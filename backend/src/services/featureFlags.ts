/**
 * Feature-flag service for progressive rollout (#425, #814).
 *
 * Flags are resolved in priority order:
 *   1. Runtime records set via the admin API. These are persisted to the
 *      `feature_flags` table (tasks DB) and reloaded on startup.
 *   2. Environment variable `FEATURE_<FLAG_NAME>=true|false`
 *   3. Compiled-in defaults below
 *
 * A runtime record can also carry a rollout: `rolloutPercent` (0–100) buckets
 * wallets deterministically, and `enabledWallets` always sees the flag on.
 *
 * Flag state is exposed in the health payload so ops can verify what is
 * active without access to the admin UI.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { getConfig } from "../config";

// ─── Flag registry ────────────────────────────────────────────────────────────

/** All known feature flags. Add new ones here. */
export const KNOWN_FLAGS = [
  "streaming_responses",
  "dag_preview",
  "experimental_agents",
  "quality_scorer",
  "reconciliation",
  "agent_ownership_proof",
] as const;

export type FeatureFlag = (typeof KNOWN_FLAGS)[number];

/**
 * Any flag key. Besides the known flags, runtime records can create new keys
 * (for example `design_agent`) so a feature can be gated before it is
 * registered in `KNOWN_FLAGS`.
 */
export type FlagKey = string;

/** Accepted shape for a runtime flag key. */
export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** Compiled-in defaults — lowest precedence. */
const DEFAULTS: Record<FeatureFlag, boolean> = {
  streaming_responses: true,
  dag_preview: false,
  experimental_agents: false,
  quality_scorer: true,
  reconciliation: true,
  // Enforced by default. Setting this to `false` re-opens the *unsigned*
  // register/heartbeat path so existing agent clients keep working during a
  // migration window — see AGENT_AUTH_SUNSET_DATE for the cutover date.
  agent_ownership_proof: true,
};

// ─── Store ────────────────────────────────────────────────────────────────────

/** A runtime override, with the rollout and audit fields persisted alongside it. */
export interface FlagRecord {
  key: FlagKey;
  /** Master switch. `false` disables the flag for everyone except `enabledWallets`. */
  enabled: boolean;
  /** 0–100. Share of wallets that see the flag once it is enabled. */
  rolloutPercent: number;
  /** Stellar public keys that always see the flag as enabled. */
  enabledWallets: string[];
  /** ISO-8601 time of the last change. */
  updatedAt: string;
  /** Actor (admin identity) that made the last change. */
  updatedBy: string;
}

/** Per-request context used to bucket a wallet into a rollout. */
export interface FlagContext {
  walletPublicKey?: string;
}

/** Runtime records, keyed by flag. Hydrated from the DB when persistence is on. */
const runtimeOverrides = new Map<FlagKey, FlagRecord>();

/** Database that runtime records are written through to. `null` keeps them in memory only. */
let persistDb: Database.Database | null = null;

/** DDL matching `migrations/tasks/007_create_feature_flags_table.up.sql`. */
const FEATURE_FLAGS_DDL = `
  CREATE TABLE IF NOT EXISTS feature_flags (
    key              TEXT    PRIMARY KEY,
    enabled          INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    rollout_percent  INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
    enabled_wallets  TEXT    NOT NULL DEFAULT '[]',
    updated_at       TEXT    NOT NULL,
    updated_by       TEXT    NOT NULL
  );
`;

interface FeatureFlagRow {
  key: string;
  enabled: number;
  rollout_percent: number;
  enabled_wallets: string;
  updated_at: string;
  updated_by: string;
}

function fromRow(row: FeatureFlagRow): FlagRecord {
  return {
    key: row.key,
    enabled: row.enabled === 1,
    rolloutPercent: row.rollout_percent,
    enabledWallets: parseWallets(row.enabled_wallets),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function parseWallets(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Attach a database for runtime records. Creates the table if it is missing,
 * then loads every stored record so the overrides are in effect before the
 * first request. Safe to call again; it reloads from the database.
 */
export function initFeatureFlagPersistence(db: Database.Database): void {
  db.exec(FEATURE_FLAGS_DDL);
  persistDb = db;

  const rows = db
    .prepare(
      "SELECT key, enabled, rollout_percent, enabled_wallets, updated_at, updated_by FROM feature_flags",
    )
    .all() as FeatureFlagRow[];
  for (const row of rows) {
    runtimeOverrides.set(row.key, fromRow(row));
  }
}

function persist(record: FlagRecord): void {
  if (!persistDb) return;
  persistDb
    .prepare(
      `INSERT INTO feature_flags (key, enabled, rollout_percent, enabled_wallets, updated_at, updated_by)
       VALUES (@key, @enabled, @rolloutPercent, @enabledWallets, @updatedAt, @updatedBy)
       ON CONFLICT(key) DO UPDATE SET
         enabled = excluded.enabled,
         rollout_percent = excluded.rollout_percent,
         enabled_wallets = excluded.enabled_wallets,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run({
      key: record.key,
      enabled: record.enabled ? 1 : 0,
      rolloutPercent: record.rolloutPercent,
      enabledWallets: JSON.stringify(record.enabledWallets),
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    });
}

// ─── Rollout ──────────────────────────────────────────────────────────────────

/**
 * Deterministic bucket in `[0, 100)` for a wallet and flag. The same pair
 * always lands in the same bucket, so a wallet's answer is stable across
 * requests and restarts.
 */
export function rolloutBucket(flag: FlagKey, walletPublicKey: string): number {
  const digest = createHash("sha256").update(`${flag}:${walletPublicKey}`).digest();
  return digest.readUInt32BE(0) % 100;
}

function evaluateRecord(record: FlagRecord, context: FlagContext): boolean {
  const wallet = context.walletPublicKey;

  // An explicit allow-list entry wins over both the master switch and the rollout.
  if (wallet && record.enabledWallets.includes(wallet)) return true;
  if (!record.enabled) return false;
  if (record.rolloutPercent >= 100) return true;
  // Without a wallet there is nothing to bucket, so a partial rollout is off.
  if (!wallet || record.rolloutPercent <= 0) return false;
  return rolloutBucket(record.key, wallet) < record.rolloutPercent;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

function readEnvFlag(flag: FlagKey): boolean | undefined {
  const cfg = getConfig() as Record<string, any>;
  const key = `FEATURE_${flag.toUpperCase()}`;
  const val = cfg[key];
  // `.env` files copied from `.env.example` ship these keys empty; an empty
  // value means "not configured", never "false" — otherwise merely copying the
  // example would silently disable safety flags such as agent_ownership_proof.
  if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
    return undefined;
  }
  if (typeof val === "boolean") return val;
  return val === "1" || String(val).toLowerCase() === "true";
}

/** Compiled-in default for a flag, or `false` for a key nobody has defined. */
function defaultFor(flag: FlagKey): boolean {
  return (DEFAULTS as Record<string, boolean>)[flag] ?? false;
}

/**
 * Returns whether a feature flag is currently enabled for a context.
 * Resolution order: runtime record → env var → compiled default.
 *
 * Without a context, a partial rollout is evaluated as "not enabled" for
 * everyone, so callers that are not wallet-scoped never see a rollout.
 */
export function isEnabled(flag: FlagKey, context: FlagContext = {}): boolean {
  const record = runtimeOverrides.get(flag);
  if (record) return evaluateRecord(record, context);
  const envVal = readEnvFlag(flag);
  if (envVal !== undefined) return envVal;
  return defaultFor(flag);
}

/** Resolved state and the source that decided it, for one flag. */
function resolve(flag: FlagKey): { enabled: boolean; source: "runtime" | "env" | "default" } {
  const record = runtimeOverrides.get(flag);
  if (record) return { enabled: record.enabled, source: "runtime" };
  const envVal = readEnvFlag(flag);
  if (envVal !== undefined) return { enabled: envVal, source: "env" };
  return { enabled: defaultFor(flag), source: "default" };
}

/** Input for {@link upsertFlag}. Omitted fields keep their current value. */
export interface FlagPatch {
  enabled?: boolean;
  rolloutPercent?: number;
  enabledWallets?: string[];
}

/**
 * Create or update a runtime record. Writes to the database first, so a failed
 * write leaves the in-memory state unchanged.
 */
export function upsertFlag(flag: FlagKey, patch: FlagPatch, actor: string): FlagRecord {
  const existing = runtimeOverrides.get(flag);
  const record: FlagRecord = {
    key: flag,
    enabled: patch.enabled ?? existing?.enabled ?? true,
    rolloutPercent: patch.rolloutPercent ?? existing?.rolloutPercent ?? 100,
    enabledWallets: patch.enabledWallets ?? existing?.enabledWallets ?? [],
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  persist(record);
  runtimeOverrides.set(flag, record);
  return record;
}

/**
 * Remove a runtime record so the flag falls back to env or default.
 * Returns `false` when there was no record to remove.
 */
export function deleteFlagRecord(flag: FlagKey): boolean {
  if (!runtimeOverrides.has(flag)) return false;
  persistDb?.prepare("DELETE FROM feature_flags WHERE key = ?").run(flag);
  runtimeOverrides.delete(flag);
  return true;
}

/** All runtime records, sorted by key. */
export function listFlagRecords(): FlagRecord[] {
  return [...runtimeOverrides.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Set a runtime override for a flag, applied to every wallet.
 * Pass `null` to clear the override and fall back to env/default.
 */
export function setFlag(flag: FlagKey, value: boolean | null): void {
  if (value === null) {
    deleteFlagRecord(flag);
  } else {
    upsertFlag(flag, { enabled: value, rolloutPercent: 100, enabledWallets: [] }, "system");
  }
}

/** Returns a snapshot of all known flag states with their resolution source. */
export function getAllFlags(): Record<FeatureFlag, { enabled: boolean; source: "runtime" | "env" | "default" }> {
  const result = {} as Record<FeatureFlag, { enabled: boolean; source: "runtime" | "env" | "default" }>;
  for (const flag of KNOWN_FLAGS) {
    result[flag] = resolve(flag);
  }
  return result;
}

/**
 * State of one flag, including flags that are not in `KNOWN_FLAGS`. Used by the
 * admin API so it can report a runtime-created key.
 */
export function getFlagState(flag: FlagKey): { enabled: boolean; source: "runtime" | "env" | "default" } {
  return resolve(flag);
}

/** Clears all runtime overrides (useful in tests). Does not touch the database. */
export function clearRuntimeOverrides(): void {
  runtimeOverrides.clear();
}
