/**
 * Payment reconciliation service (issue #496).
 *
 * Cross-references local payment records with Stellar on-chain claimable
 * balances, classifies every divergence into a stable *drift type*, applies the
 * automatic remediations that are unambiguous, records anything left over as a
 * durable pending-drift record, and reports every observation through metrics,
 * `RECONCILIATION_EVENT` events, structured logs and an optional webhook.
 *
 * Drift scenarios
 * ───────────────
 * | # | Local DB                | Stellar chain                | Drift type         | Remediation        |
 * |---|-------------------------|------------------------------|--------------------|--------------------|
 * | 1 | `locked`                | no claimable balance         | `orphaned_locked`  | mark `orphaned`    |
 * | 2 | `released`              | release tx missing in Horizon| `missing_release_tx` | back-fill tx hash |
 * | 3 | `released`              | balance still claimable      | `release_unconfirmed` | re-submit release |
 * | 4 | `locked`, task terminal | balance still claimable      | `expired_escrow`   | refund the escrow  |
 *
 * Idempotency
 * ───────────
 * Remediation is safe to re-run. `mark_orphaned` and `refund_escrow` are
 * compare-and-set writes that only fire when the record is still in the
 * expected source state, so a second pass finds nothing to do. Re-submitting a
 * release is idempotent at the protocol level — a claimable balance can only be
 * claimed once, and a second claim fails with `tx_no_claim_claimable_balance`
 * rather than paying twice. Anything that is *not* unambiguous (an on-chain
 * balance with no local record, an amount mismatch) is reported and parked for
 * a human instead of being guessed at.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Horizon, Asset } from '@stellar/stellar-sdk';
import { createLogger } from '../utils/logger';
import { getConfig } from '../config';
import { createPaymentDb, getDb, type PaymentDb, type PaymentRecord } from '../db/index';
import type { EventStore } from '../events/eventStore';
import {
  detectPaymentDrift,
  driftCounts,
  planRemediation,
  verifyReleaseTransactions,
  emptyDriftCounters,
  type ReleaseTransactionResolver,
  type ReleaseVerification,
  type TaskStateResolver,
} from './reconciliation.drift';
import { ReconciliationMetrics, reconciliationMetrics } from './reconciliation.metrics';
import {
  classifyDriftAlert,
  type DriftAlert,
  type DriftAlertThresholds,
} from './reconciliation.alerts';
import {
  createEventBusReconciliationEventSink,
  createNoopReconciliationEventSink,
  type ReconciliationEventSink,
} from './reconciliation.events';
import {
  makeReconciliationEvent,
  type ReconciliationEventPayload,
} from '../events/eventTypes';
import type {
  ClaimableBalanceOnChain,
  ClaimTransactionOnChain,
  DriftType,
  PendingDrift,
  ReconciliationDiscrepancy,
  ReconciliationRemediation,
  ReconciliationReport,
  ReconciliationSummary,
  ReconciliationTrigger,
  RemediationAction,
} from './reconciliation.types';
import { DRIFT_TYPES } from './reconciliation.types';

const log = createLogger({ component: 'reconciliation' });

/** Default cadence for the drift-detection scheduler (issue #496). */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

/** Long-horizon reporting cadence, retained for the `startDaily` API. */
export const DEFAULT_DAILY_INTERVAL_MS = 86_400_000;
const LIST_BALANCES_MAX_PAGES = 10;
const LIST_BALANCES_PAGE_LIMIT = 200;

/** Deadline for one drift-alert webhook delivery (#811). */
const DRIFT_ALERT_TIMEOUT_MS = 5_000;
/** Drift alerts kept in memory for the admin alerts endpoint (#811). */
const MAX_RECENT_ALERTS = 1_000;
/** Task statuses after which a task has settled (#811). */
const SETTLED_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled']);

/** Sentinel stored as `txHash` when remediation could not find a real hash. */
const RECONCILED_TX_SENTINEL = 'reconciled-repair';

/**
 * The single SQLite connection shared by the default report and pending-drift
 * stores. Both live in the same file, and opening one connection per service
 * instance would leak a file descriptor every time a service is constructed
 * (the admin router constructs one per process, tests construct many).
 */
let _defaultReconciliationDb: Database.Database | null = null;

function defaultReconciliationDb(): Database.Database {
  if (!_defaultReconciliationDb) {
    _defaultReconciliationDb = new Database(
      path.join(process.cwd(), 'reconciliation.db') as unknown as string
    );
    _defaultReconciliationDb.pragma('journal_mode = WAL');
    _defaultReconciliationDb.pragma('busy_timeout = 5000');
  }
  return _defaultReconciliationDb;
}

/** Close the shared reconciliation database (graceful shutdown / tests). */
export function closeReconciliationDb(): void {
  _defaultReconciliationDb?.close();
  _defaultReconciliationDb = null;
}

/**
 * Convert an XLM amount string (as returned by Horizon, e.g. "1.0000000")
 * into an exact stroop count. Avoids floating point rounding so amounts
 * compare exactly with local records.
 */
export function xlmStringToStroops(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = frac.padEnd(7, '0').slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded || '0');
}

/** Read-only view of on-chain claimable balances. */
export interface ClaimableBalanceProvider {
  getBalance(balanceId: string): Promise<ClaimableBalanceOnChain | null>;
  listBalances(): Promise<ClaimableBalanceOnChain[]>;
}

/** Read-only view of on-chain transactions that claim a claimable balance. */
export interface ClaimTransactionProvider {
  /** Find the transaction that claimed `balanceId`, if any. */
  findClaim(balanceId: string): Promise<ClaimTransactionOnChain | null>;
  /** Look a transaction up by hash. */
  getTransaction(hash: string): Promise<ClaimTransactionOnChain | null>;
}

function mapClaimableBalanceRecord(
  record: import('@stellar/stellar-sdk').ClaimableBalanceRecord
): ClaimableBalanceOnChain {
  return {
    balanceId: record.id,
    amountStroops: xlmStringToStroops(record.amount ?? '0').toString(),
    asset: record.asset,
    sponsor: record.sponsor,
    claimant: record.claimants?.[0]?.destination,
  };
}

function mapTransactionRecord(
  record: import('@stellar/stellar-sdk').TransactionRecord
): ClaimTransactionOnChain {
  return {
    hash: record.hash,
    successful: record.successful !== false,
    ledgerSequence: record.ledger_seq ?? record.ledger,
    claimant: record.source_account,
  };
}

/** Default provider backed by the Stellar SDK (Horizon REST API). */
export class HorizonClaimableBalanceProvider implements ClaimableBalanceProvider {
  private readonly server: Horizon.Server;

  constructor(horizonUrl?: string) {
    this.server = new Horizon.Server(horizonUrl ?? getConfig().STELLAR_HORIZON_URL);
  }

  async getBalance(balanceId: string): Promise<ClaimableBalanceOnChain | null> {
    try {
      const record = await this.server
        .claimableBalances()
        .claimableBalance(balanceId)
        .call();
      return mapClaimableBalanceRecord(record);
    } catch (err) {
      // 404 (already claimed / never created) or any query error → not found.
      // Unexpected errors are logged so operators can investigate rather
      // than silently trusting the absence of an on-chain balance.
      log.warn({ err, balanceId }, 'Failed to query on-chain claimable balance');
      return null;
    }
  }

  async listBalances(): Promise<ClaimableBalanceOnChain[]> {
    const balances: ClaimableBalanceOnChain[] = [];
    try {
      let page: import('@stellar/stellar-sdk').ClaimableBalancePage | null =
        await this.server
          .claimableBalances()
          .forAsset(Asset.native())
          .limit(LIST_BALANCES_PAGE_LIMIT)
          .call();
      let pages = 0;
      while (page && page.records && page.records.length > 0 && pages < LIST_BALANCES_MAX_PAGES) {
        for (const record of page.records) {
          balances.push(mapClaimableBalanceRecord(record));
        }
        page = await page.next();
        pages++;
      }
    } catch (err) {
      log.error({ err }, 'Failed to list on-chain claimable balances');
    }
    return balances;
  }
}

/**
 * Horizon-backed release-transaction verifier.
 *
 * Resolves a `released` record to the transaction that actually claimed the
 * balance, preferring the claim lookup (authoritative) over the recorded hash
 * (which may be stale, wrong, or simply absent from the index).
 */
export class HorizonClaimTransactionProvider implements ClaimTransactionProvider {
  private readonly server: Horizon.Server;

  constructor(horizonUrl?: string) {
    this.server = new Horizon.Server(horizonUrl ?? getConfig().STELLAR_HORIZON_URL);
  }

  async findClaim(balanceId: string): Promise<ClaimTransactionOnChain | null> {
    try {
      const page = await this.server
        .transactions()
        .forClaimableBalance(balanceId)
        .limit(1)
        .call();
      const record = page.records[0];
      return record ? mapTransactionRecord(record) : null;
    } catch (err) {
      log.warn({ err, balanceId }, 'Failed to look up on-chain claim transaction');
      return null;
    }
  }

  async getTransaction(hash: string): Promise<ClaimTransactionOnChain | null> {
    try {
      const record = await this.server.transactions().transaction(hash).call();
      return mapTransactionRecord(record);
    } catch (err) {
      log.warn({ err, hash }, 'Failed to look up on-chain transaction');
      return null;
    }
  }
}

/** Build the resolver used by the drift detector. */
export function createReleaseTransactionResolver(
  provider: ClaimTransactionProvider
): ReleaseTransactionResolver {
  return async (record: PaymentRecord): Promise<ReleaseVerification> => {
    const claim = await provider.findClaim(record.balanceId);
    if (claim) {
      return { recordedTxHash: record.txHash, onChainTx: claim };
    }
    const recorded = record.txHash;
    if (!recorded) {
      return {
        recordedTxHash: null,
        onChainTx: null,
        lookupError: 'no claim transaction and no recorded hash',
      };
    }
    const tx = await provider.getTransaction(recorded);
    return {
      recordedTxHash: recorded,
      onChainTx: tx,
      ...(tx ? {} : { lookupError: 'transaction not found in Horizon' }),
    };
  };
}

/** Persistence for reconciliation reports. */
export interface ReconciliationReportStore {
  save(report: ReconciliationReport): void;
  getLatest(): ReconciliationReport | undefined;
}

/** Persistence for drifts that need a human decision. */
export interface PendingDriftStore {
  /** Insert or refresh a pending drift, returning the stored record. */
  upsert(drift: PendingDrift): PendingDrift;
  /** All unresolved drifts, newest first. */
  list(includeAcknowledged?: boolean): PendingDrift[];
  /** Mark a drift resolved and clear it from the pending set. */
  resolve(id: string, resolution: NonNullable<PendingDrift['resolution']>): PendingDrift | undefined;
  /** Forget drifts that no longer reproduce. */
  retain(ids: readonly string[]): void;
}

/** Durable pending-drift store, backed by a SQLite table. */
export function createSqlitePendingDriftStore(db?: Database.Database): PendingDriftStore {
  const database = db ?? defaultReconciliationDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconcile_pending_drift (
      id                TEXT PRIMARY KEY,
      driftType         TEXT NOT NULL,
      balanceId         TEXT NOT NULL,
      taskId            TEXT,
      nodeId            TEXT,
      description       TEXT NOT NULL,
      severity          TEXT NOT NULL,
      recommendedAction TEXT NOT NULL,
      detectedAt        TEXT NOT NULL,
      lastSeenAt        TEXT NOT NULL,
      occurrences       INTEGER NOT NULL DEFAULT 1,
      acknowledged      INTEGER NOT NULL DEFAULT 0,
      resolvedStatus    TEXT,
      resolvedTxHash    TEXT,
      resolvedAt        TEXT,
      resolvedBy        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reconcile_pending_drift_lastSeen
      ON reconcile_pending_drift (lastSeenAt);
  `);

  const upsertStmt = database.prepare(`
    INSERT INTO reconcile_pending_drift
      (id, driftType, balanceId, taskId, nodeId, description, severity,
       recommendedAction, detectedAt, lastSeenAt, occurrences, acknowledged)
    VALUES
      (@id, @driftType, @balanceId, @taskId, @nodeId, @description, @severity,
       @recommendedAction, @detectedAt, @lastSeenAt, @occurrences, @acknowledged)
    ON CONFLICT(id) DO UPDATE SET
      driftType         = excluded.driftType,
      balanceId         = excluded.balanceId,
      taskId            = excluded.taskId,
      nodeId            = excluded.nodeId,
      description       = excluded.description,
      severity          = excluded.severity,
      recommendedAction = excluded.recommendedAction,
      lastSeenAt        = excluded.lastSeenAt,
      occurrences       = reconcile_pending_drift.occurrences + 1
  `);
  const listStmt = database.prepare(
    'SELECT * FROM reconcile_pending_drift WHERE acknowledged = 0 ORDER BY lastSeenAt DESC',
  );
  const listAllStmt = database.prepare(
    'SELECT * FROM reconcile_pending_drift ORDER BY lastSeenAt DESC',
  );
  const getStmt = database.prepare('SELECT * FROM reconcile_pending_drift WHERE id = ?');
  const resolveStmt = database.prepare(`
    UPDATE reconcile_pending_drift
    SET acknowledged = 1, resolvedStatus = ?, resolvedTxHash = ?, resolvedAt = ?, resolvedBy = ?
    WHERE id = ?
  `);
  const deleteStmt = database.prepare('DELETE FROM reconcile_pending_drift WHERE id = ?');
  const idsStmt = database.prepare('SELECT id FROM reconcile_pending_drift');

  interface DriftRow {
    id: string;
    driftType: string;
    balanceId: string;
    taskId: string | null;
    nodeId: string | null;
    description: string;
    severity: string;
    recommendedAction: string;
    detectedAt: string;
    lastSeenAt: string;
    occurrences: number;
    acknowledged: number;
    resolvedStatus: string | null;
    resolvedTxHash: string | null;
    resolvedAt: string | null;
    resolvedBy: string | null;
  }

  function rowToPending(row: DriftRow): PendingDrift {
    return {
      id: row.id,
      driftType: row.driftType as DriftType,
      balanceId: row.balanceId,
      ...(row.taskId ? { taskId: row.taskId } : {}),
      ...(row.nodeId ? { nodeId: row.nodeId } : {}),
      description: row.description,
      severity: row.severity as PendingDrift['severity'],
      recommendedAction: row.recommendedAction as RemediationAction,
      detectedAt: row.detectedAt,
      lastSeenAt: row.lastSeenAt,
      occurrences: row.occurrences,
      acknowledged: row.acknowledged === 1,
      ...(row.resolvedStatus && row.resolvedTxHash && row.resolvedAt && row.resolvedBy
        ? {
            resolution: {
              status: row.resolvedStatus as NonNullable<PendingDrift['resolution']>['status'],
              txHash: row.resolvedTxHash,
              at: row.resolvedAt,
              by: row.resolvedBy,
            },
          }
        : {}),
    };
  }

  return {
    upsert(drift: PendingDrift): PendingDrift {
      upsertStmt.run({
        id: drift.id,
        driftType: drift.driftType,
        balanceId: drift.balanceId,
        taskId: drift.taskId ?? null,
        nodeId: drift.nodeId ?? null,
        description: drift.description,
        severity: drift.severity,
        recommendedAction: drift.recommendedAction,
        detectedAt: drift.detectedAt,
        lastSeenAt: drift.lastSeenAt,
        occurrences: drift.occurrences,
        acknowledged: drift.acknowledged ? 1 : 0,
      });
      return drift;
    },
    list(includeAcknowledged = false): PendingDrift[] {
      const rows = (includeAcknowledged ? listAllStmt.all() : listStmt.all()) as DriftRow[];
      return rows.map(rowToPending);
    },
    resolve(id, resolution): PendingDrift | undefined {
      const existing = getStmt.get(id) as DriftRow | undefined;
      if (!existing) return undefined;
      resolveStmt.run(
        resolution.status,
        resolution.txHash,
        resolution.at,
        resolution.by,
        id,
      );
      const updated = getStmt.get(id) as DriftRow;
      return rowToPending(updated);
    },
    retain(ids: readonly string[]): void {
      const keep = new Set(ids);
      const rows = idsStmt.all() as Array<{ id: string }>;
      for (const row of rows) {
        if (!keep.has(row.id)) deleteStmt.run(row.id);
      }
    },
  };
}

/** An in-memory pending-drift store (tests, and the default when no DB is wired). */
export function createInMemoryPendingDriftStore(): PendingDriftStore & {
  readonly records: Map<string, PendingDrift>;
} {
  const records = new Map<string, PendingDrift>();
  return {
    records,
    upsert(drift: PendingDrift): PendingDrift {
      const existing = records.get(drift.id);
      const next: PendingDrift = existing
        ? { ...drift, detectedAt: existing.detectedAt, occurrences: existing.occurrences + 1 }
        : drift;
      records.set(drift.id, next);
      return next;
    },
    list(includeAcknowledged = false): PendingDrift[] {
      return [...records.values()]
        .filter((d) => includeAcknowledged || !d.acknowledged)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    },
    resolve(id, resolution): PendingDrift | undefined {
      const existing = records.get(id);
      if (!existing) return undefined;
      const next: PendingDrift = { ...existing, acknowledged: true, resolution };
      records.set(id, next);
      return next;
    },
    retain(ids: readonly string[]): void {
      const keep = new Set(ids);
      for (const id of [...records.keys()]) {
        if (!keep.has(id)) records.delete(id);
      }
    },
  };
}

/** SQLite-backed report store; defaults to an in-memory database. */
export function createSqliteReconciliationReportStore(
  db?: Database.Database
): ReconciliationReportStore {
  const database = db ?? defaultReconciliationDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_reports (
      id         TEXT PRIMARY KEY,
      runAt      TEXT NOT NULL,
      reportJson TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_runAt
      ON reconciliation_reports (runAt);
  `);

  const insertStmt = database.prepare(`
    INSERT OR REPLACE INTO reconciliation_reports (id, runAt, reportJson)
    VALUES (@id, @runAt, @reportJson)
  `);
  const latestStmt = database.prepare(
    'SELECT reportJson FROM reconciliation_reports ORDER BY runAt DESC LIMIT 1'
  );

  return {
    save(report: ReconciliationReport): void {
      insertStmt.run({
        id: report.id,
        runAt: report.runAt,
        reportJson: JSON.stringify(report),
      });
    },
    getLatest(): ReconciliationReport | undefined {
      const row = latestStmt.get() as { reportJson: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.reportJson) as ReconciliationReport;
    },
  };
}

/** Wallet that re-drives a release or refund. */
export interface EscrowSettler {
  /** Re-submit the release of a claimable balance; resolves to the new tx hash. */
  release(balanceId: string, taskId: string, nodeId: string): Promise<string>;
  /** Refund a claimable balance back to the coordinator; resolves to the tx hash. */
  refund(balanceId: string, taskId: string, nodeId: string): Promise<string>;
}

/** Queue a release/refund for re-execution outside the reconciliation loop. */
export type SettlementQueue = (job: {
  kind: 'release' | 'refund';
  balanceId: string;
  taskId: string;
  nodeId: string;
}) => void;

export interface ReconciliationServiceOptions {
  /** Local payment records used as the source of truth. */
  paymentDb: PaymentDb;
  /** On-chain query provider; defaults to Horizon via the Stellar SDK. */
  onChainProvider?: ClaimableBalanceProvider;
  /** Release-transaction verifier; defaults to Horizon. */
  claimProvider?: ClaimTransactionProvider;
  /** Resolve a task's state, used to spot expired escrows. */
  taskState?: TaskStateResolver;
  /** Where reports are persisted; defaults to a SQLite store. */
  reportStore?: ReconciliationReportStore;
  /** Where unremediated drifts are parked; defaults to a SQLite store. */
  pendingDriftStore?: PendingDriftStore;
  /** Optional webhook URL alerted on discrepancies. */
  webhookUrl?: string;
  /** Logger for reconciliation events; defaults to a pino child logger. */
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
  /** Clock (epoch ms) — injectable for deterministic tests. */
  now?: () => number;
  /** Escrow expiry window, in ms. `0` disables the age gate. */
  escrowExpiryMs?: number;
  /** Master switch for automatic remediation. */
  remediationEnabled?: boolean;
  /** Executes releases/refunds on-chain. */
  settler?: EscrowSettler;
  /** Queues releases/refunds for asynchronous re-execution. */
  settlementQueue?: SettlementQueue;
  /** Maximum release transactions verified per run. */
  maxTxLookups?: number;
  /** Where `RECONCILIATION_EVENT` events are published. */
  eventSink?: ReconciliationEventSink;
  /** Event store, when the default event-bus sink should persist to it. */
  eventStore?: EventStore;
  /** Metric registry; defaults to the process-wide one. */
  metrics?: ReconciliationMetrics;
  /**
   * Drift percentages that raise warning and critical alerts. Defaults to
   * `RECONCILIATION_WARNING_DRIFT_PERCENT` (1) and `RECONCILIATION_CRITICAL_DRIFT_PERCENT` (5).
   */
  alertThresholds?: Partial<DriftAlertThresholds>;
}

export class ReconciliationService {
  private readonly paymentDb: PaymentDb;
  private readonly onChainProvider: ClaimableBalanceProvider;
  private readonly claimProvider: ClaimTransactionProvider;
  private readonly releaseResolver: ReleaseTransactionResolver | undefined;
  private readonly taskState: TaskStateResolver | undefined;
  private readonly reportStore: ReconciliationReportStore;
  private readonly pendingDriftStore: PendingDriftStore;
  private readonly webhookUrl?: string;
  private readonly logger: Pick<typeof log, 'info' | 'warn' | 'error'>;
  private readonly now: () => number;
  private readonly escrowExpiryMs: number;
  private readonly remediationEnabled: boolean;
  private readonly settler?: EscrowSettler;
  private readonly settlementQueue?: SettlementQueue;
  private readonly maxTxLookups: number;
  private readonly eventSink: ReconciliationEventSink;
  private readonly metrics: ReconciliationMetrics;
  private readonly alertThresholds: DriftAlertThresholds;
  private readonly recentAlerts: DriftAlert[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly scheduledRuns = new Set<Promise<void>>();

  constructor(options: ReconciliationServiceOptions) {
    this.paymentDb = options.paymentDb;
    this.onChainProvider =
      options.onChainProvider ?? new HorizonClaimableBalanceProvider();
    this.claimProvider =
      options.claimProvider ?? new HorizonClaimTransactionProvider();
    this.releaseResolver = createReleaseTransactionResolver(this.claimProvider);
    this.taskState = options.taskState;
    this.reportStore =
      options.reportStore ?? createSqliteReconciliationReportStore();
    this.pendingDriftStore =
      options.pendingDriftStore ?? createSqlitePendingDriftStore();
    this.webhookUrl = options.webhookUrl ?? safeConfig()?.RECONCILIATION_WEBHOOK_URL;
    this.logger = options.logger ?? log;
    this.now = options.now ?? (() => Date.now());
    this.escrowExpiryMs = options.escrowExpiryMs ?? safeConfig()?.RECONCILIATION_ESCROW_EXPIRY_MS ?? 86_400_000;
    this.remediationEnabled = options.remediationEnabled ?? safeConfig()?.RECONCILIATION_REMEDIATION_ENABLED ?? true;
    this.settler = options.settler;
    this.settlementQueue = options.settlementQueue;
    this.maxTxLookups = options.maxTxLookups ?? safeConfig()?.RECONCILIATION_MAX_TX_LOOKUPS ?? 200;
    this.metrics = options.metrics ?? reconciliationMetrics;
    this.alertThresholds = {
      warningPercent:
        options.alertThresholds?.warningPercent ?? safeConfig()?.RECONCILIATION_WARNING_DRIFT_PERCENT ?? 1,
      criticalPercent:
        options.alertThresholds?.criticalPercent ?? safeConfig()?.RECONCILIATION_CRITICAL_DRIFT_PERCENT ?? 5,
    };
    this.eventSink =
      options.eventSink ??
      (options.eventStore
        ? createEventBusReconciliationEventSink(options.eventStore)
        : createNoopReconciliationEventSink());
  }

  /**
   * Run a reconciliation pass: compare every local payment record against
   * on-chain claimable balances, remediate the unambiguous drift, persist a
   * timestamped report, and alert on anything left over. Never throws —
   * infrastructure failures surface inside the report's discrepancies or log,
   * keeping automated runs resilient.
   */
  async run(triggeredBy: ReconciliationTrigger = 'manual'): Promise<ReconciliationReport> {
    if (this.running) {
      const inFlight = this.getLatestReport();
      if (inFlight) return inFlight;
      throw new Error('Reconciliation already in progress');
    }
    this.running = true;
    this.metrics.recordRun();
    try {
      const runId = randomUUID();
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();

      const localRecords = this.paymentDb.listAll();
      const onChainBalances = await this.onChainProvider.listBalances();

      const verifications = await this.verifyReleases(localRecords);
      const detection = detectPaymentDrift(localRecords, onChainBalances, {
        escrowExpiryMs: this.escrowExpiryMs,
        now: () => nowMs,
        ...(this.taskState ? { taskState: this.taskState } : {}),
      }, verifications);

      // 1. Report every drift first, so detection metrics and events are
      //    recorded even when remediation subsequently fails.
      for (const discrepancy of detection.discrepancies) {
        this.metrics.recordDriftDetected(discrepancy.driftType);
        this.emitEvent(runId, discrepancy, 'drift');
      }
      if (detection.discrepancies.length > 0) {
        this.metrics.recordRunWithDrift();
      }

      // 2. Remediate what can be remediated safely. The outcome is recorded on
      //    the discrepancy itself so the report is self-describing, and every
      //    outcome that is not `remediated` is parked for a human.
      const remediations: ReconciliationRemediation[] = [];
      const remediatedByType = emptyDriftCounters<DriftType>(DRIFT_TYPES);
      const pendingIds: string[] = [];
      for (const discrepancy of detection.discrepancies) {
        const outcome = this.remediationEnabled
          ? await this.remediate(runId, discrepancy, nowIso)
          : {
              action: planRemediation(discrepancy).action,
              status: 'skipped' as const,
              reason: 'automatic remediation disabled',
              at: nowIso,
            };

        remediations.push(outcome);
        discrepancy.remediation = outcome;

        if (outcome.status === 'remediated') {
          this.metrics.recordRemediated(discrepancy.driftType);
          remediatedByType[discrepancy.driftType] += 1;
          this.emitEvent(runId, discrepancy, 'remediation');
        } else {
          if (outcome.status === 'failed') {
            this.metrics.recordRemediationFailed(discrepancy.driftType);
          }
          this.park(discrepancy, outcome, nowIso);
          pendingIds.push(this.driftId(discrepancy));
        }
      }
      if (remediations.some((r) => r.status === 'remediated')) {
        this.metrics.recordRunWithRemediation();
      }
      // Drifts that no longer reproduce are forgotten, so the queue only ever
      // holds what an operator still has to look at.
      this.pendingDriftStore.retain(pendingIds);

      const summary: ReconciliationSummary = {
        totalLocalRecords: localRecords.length,
        totalOnChainBalances: onChainBalances.length,
        matched: detection.matched,
        discrepancies: detection.discrepancies.length,
        missingOnChain: detection.discrepancies.filter((d) => d.type === 'missing_on_chain').length,
        missingLocal: detection.discrepancies.filter((d) => d.type === 'missing_local').length,
        amountMismatch: detection.discrepancies.filter((d) => d.type === 'amount_mismatch').length,
        driftByType: driftCounts(detection.discrepancies),
        remediatedByType,
        remediated: remediations.filter((r) => r.status === 'remediated').length,
        pendingRemediation: remediations.filter((r) => r.status !== 'remediated').length,
        releaseVerified: detection.releaseVerified,
        releaseUnverified: detection.releaseUnverified,
      };

      const report: ReconciliationReport = {
        id: runId,
        runAt: nowIso,
        triggeredBy,
        status: detection.discrepancies.length > 0 ? 'discrepancies_found' : 'consistent',
        summary,
        discrepancies: detection.discrepancies,
        remediations,
      };

      this.reportStore.save(report);
      await this.alert(report);
      return report;
    } finally {
      this.running = false;
    }
  }

  /** The most recently persisted report, if any. */
  getLatestReport(): ReconciliationReport | undefined {
    return this.reportStore.getLatest();
  }

  /** Drift records still awaiting a human decision. */
  listPendingDrift(includeAcknowledged = false): PendingDrift[] {
    return this.pendingDriftStore.list(includeAcknowledged);
  }

  /**
   * Mark a pending drift as handled. The payments row is patched in the same
   * step so a subsequent run is a no-op.
   */
  resolvePendingDrift(
    id: string,
    status: NonNullable<PendingDrift['resolution']>['status'],
    txHash: string,
    by: string,
  ): PendingDrift | undefined {
    const pending = this.pendingDriftStore.list(true).find((d) => d.id === id);
    if (!pending || !pending.taskId || !pending.nodeId) {
      return this.pendingDriftStore.resolve(id, {
        status,
        txHash,
        at: new Date(this.now()).toISOString(),
        by,
      });
    }
    this.paymentDb.updateStatus(pending.taskId, pending.nodeId, status, txHash);
    return this.pendingDriftStore.resolve(id, {
      status,
      txHash,
      at: new Date(this.now()).toISOString(),
      by,
    });
  }

  /** The counter registry backing `reconcile.*` metrics. */
  getMetrics(): ReconciliationMetrics {
    return this.metrics;
  }

  /** Schedule automated reconciliation runs (default 60 s). Idempotent. */
  start(intervalMs: number = DEFAULT_RECONCILIATION_INTERVAL_MS): void {
    this.startScheduled(intervalMs, 'Reconciliation scheduled');
  }

  /** Schedule automated (daily) reconciliation runs. Idempotent. */
  startDaily(intervalMs: number = DEFAULT_DAILY_INTERVAL_MS): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      await this.runScheduled('Scheduled reconciliation run failed');
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    this.logger.info({ intervalMs }, 'Daily reconciliation scheduled');
  }

  private startScheduled(intervalMs: number, message: string): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = async () => {
      await this.runScheduled('Frequent reconciliation run failed');
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    this.logger.info({ intervalMs }, message);
  }

  private runScheduled(failureMessage: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const trackedRun = this.run('scheduled')
      .then(() => undefined)
      .catch((err) => {
        this.logger.error({ err }, failureMessage);
      });
    this.scheduledRuns.add(trackedRun);
    void trackedRun.finally(() => {
      this.scheduledRuns.delete(trackedRun);
    });
    return trackedRun;
  }

  /** Stop the automated scheduler. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Reconciliation scheduler stopped');
    }
    await Promise.all(this.scheduledRuns);
  }

  /**
   * Idempotent drift repair: run a pass and apply every automatic remediation.
   * Safe to re-run — a second pass finds nothing left to do.
   */
  async repair(triggeredBy: ReconciliationTrigger = 'manual'): Promise<ReconciliationReport> {
    return this.run(triggeredBy);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async verifyReleases(
    localRecords: readonly PaymentRecord[]
  ): Promise<Map<string, ReleaseVerification> | undefined> {
    if (!this.releaseResolver) return undefined;
    const candidates = localRecords.filter((r) => r.status === 'released' && r.txHash);
    if (candidates.length === 0) return new Map();
    try {
      return await verifyReleaseTransactions(localRecords, this.releaseResolver, this.maxTxLookups);
    } catch (err) {
      // Verification is best-effort: an unavailable Horizon must not blind the
      // rest of the detection pass, it only downgrades scenario 2 detection.
      this.logger.warn({ err }, 'release transaction verification failed — continuing without it');
      return undefined;
    }
  }

  private driftId(discrepancy: ReconciliationDiscrepancy): string {
    return discrepancy.taskId && discrepancy.nodeId
      ? `${discrepancy.taskId}:${discrepancy.nodeId}`
      : discrepancy.balanceId;
  }

  private park(
    discrepancy: ReconciliationDiscrepancy,
    remediation: ReconciliationRemediation,
    nowIso: string
  ): void {
    const plan = planRemediation(discrepancy);
    this.pendingDriftStore.upsert({
      id: this.driftId(discrepancy),
      driftType: discrepancy.driftType,
      balanceId: discrepancy.balanceId,
      ...(discrepancy.taskId ? { taskId: discrepancy.taskId } : {}),
      ...(discrepancy.nodeId ? { nodeId: discrepancy.nodeId } : {}),
      description: discrepancy.description,
      severity: discrepancy.severity,
      recommendedAction: plan.action,
      detectedAt: nowIso,
      lastSeenAt: nowIso,
      occurrences: 1,
      acknowledged: false,
    });
    this.logger.warn(
      { driftType: discrepancy.driftType, balanceId: discrepancy.balanceId, action: remediation.action },
      'Drift requires manual review — parked in the pending-drift queue'
    );
  }

  private async remediate(
    runId: string,
    discrepancy: ReconciliationDiscrepancy,
    nowIso: string
  ): Promise<ReconciliationRemediation> {
    const plan = planRemediation(discrepancy);
    if (!plan.automatic || plan.action === 'manual_review') {
      return { action: plan.action, status: 'manual_review', at: nowIso };
    }
    if (!discrepancy.taskId || !discrepancy.nodeId) {
      return {
        action: plan.action,
        status: 'skipped',
        reason: 'record is not addressable by (taskId, nodeId)',
        at: nowIso,
      };
    }
    const { taskId, nodeId, balanceId } = discrepancy;

    try {
      switch (plan.action) {
        case 'mark_orphaned': {
          // Compare-and-set: only a still-`locked` row is flipped, so a
          // concurrent release that already settled the payment is not undone.
          const changed = this.paymentDb.updateStatusIfCurrent(
            taskId,
            nodeId,
            'locked',
            'orphaned',
            RECONCILED_TX_SENTINEL
          );
          if (!changed) {
            return {
              action: plan.action,
              status: 'skipped',
              reason: 'record was no longer `locked` — nothing to orphan',
              at: nowIso,
            };
          }
          this.logger.info(
            { runId, balanceId, taskId, nodeId },
            'Remediating orphaned_locked: locked → orphaned (no on-chain claimable balance)'
          );
          return {
            action: plan.action,
            status: 'remediated',
            txHash: RECONCILED_TX_SENTINEL,
            at: nowIso,
          };
        }
        case 'backfill_tx_hash': {
          const realHash = discrepancy.onChainTxHash;
          if (!realHash) {
            return {
              action: plan.action,
              status: 'manual_review',
              reason: 'no on-chain claim transaction to copy',
              at: nowIso,
            };
          }
          const changed = this.paymentDb.updateStatusIfCurrent(
            taskId,
            nodeId,
            'released',
            'released',
            realHash
          );
          if (!changed) {
            return {
              action: plan.action,
              status: 'skipped',
              reason: 'record is no longer `released` — nothing to back-fill',
              at: nowIso,
            };
          }
          this.logger.info(
            { runId, balanceId, taskId, nodeId, from: discrepancy.recordedTxHash, to: realHash },
            'Remediating missing_release_tx: back-filled the real on-chain claim hash'
          );
          return { action: plan.action, status: 'remediated', txHash: realHash, at: nowIso };
        }
        case 'requeue_release': {
          // Prefer the queue (durable, off the hot path); fall back to settling
          // inline, then to a parked flag for an operator.
          if (this.settlementQueue) {
            this.settlementQueue({ kind: 'release', balanceId, taskId, nodeId });
          } else if (this.settler) {
            const txHash = await this.settler.release(balanceId, taskId, nodeId);
            this.logger.info(
              { runId, balanceId, taskId, nodeId, txHash },
              'Remediating release_unconfirmed: release re-submitted on-chain'
            );
            return { action: plan.action, status: 'remediated', txHash, at: nowIso };
          } else {
            return {
              action: plan.action,
              status: 'skipped',
              reason: 'no settlement queue or settler configured — flagged for re-submit',
              at: nowIso,
            };
          }
          return {
            action: plan.action,
            status: 'remediated',
            reason: 'queued for re-submit',
            at: nowIso,
          };
        }
        case 'refund_escrow': {
          // Only a still-`locked` row is eligible, and the claim is
          // single-use on-chain, so a re-run can never double-refund.
          if (this.paymentDb.findByKey(taskId, nodeId)?.status !== 'locked') {
            return {
              action: plan.action,
              status: 'skipped',
              reason: 'record is no longer `locked` — refund already handled',
              at: nowIso,
            };
          }
          if (this.settlementQueue) {
            this.settlementQueue({ kind: 'refund', balanceId, taskId, nodeId });
            return {
              action: plan.action,
              status: 'remediated',
              reason: 'refund queued',
              at: nowIso,
            };
          }
          if (!this.settler) {
            return {
              action: plan.action,
              status: 'skipped',
              reason: 'no settlement queue or settler configured — refund not scheduled',
              at: nowIso,
            };
          }
          const txHash = await this.settler.refund(balanceId, taskId, nodeId);
          this.paymentDb.updateStatus(taskId, nodeId, 'refunded', txHash);
          this.logger.info(
            { runId, balanceId, taskId, nodeId, txHash },
            'Remediating expired_escrow: escrow refunded on-chain'
          );
          return { action: plan.action, status: 'remediated', txHash, at: nowIso };
        }
        default:
          return { action: plan.action, status: 'manual_review', at: nowIso };
      }
    } catch (err) {
      this.logger.error(
        { err, driftType: discrepancy.driftType, balanceId },
        'Reconciliation remediation failed'
      );
      return {
        action: plan.action,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
        at: nowIso,
      };
    }
  }

  private emitEvent(
    runId: string,
    discrepancy: ReconciliationDiscrepancy,
    kind: 'drift' | 'remediation'
  ): void {
    const previous = kind === 'remediation'
      ? (discrepancy.remediation?.action === 'mark_orphaned' ? 'locked' : undefined)
      : undefined;
    const newStatus = kind === 'remediation'
      ? this.currentStatus(discrepancy, discrepancy.remediation?.action)
      : undefined;
    const payload: ReconciliationEventPayload = {
      runId,
      kind,
      driftType: discrepancy.driftType,
      balanceId: discrepancy.balanceId,
      ...(discrepancy.taskId ? { taskId: discrepancy.taskId } : {}),
      ...(discrepancy.nodeId ? { nodeId: discrepancy.nodeId } : {}),
      severity: discrepancy.severity,
      description: discrepancy.description,
      ...(discrepancy.remediation ? { remediation: discrepancy.remediation } : {}),
      ...(previous ? { previousStatus: previous } : {}),
      ...(newStatus ? { newStatus } : {}),
    };
    try {
      this.eventSink.emit(
        makeReconciliationEvent(discrepancy.taskId ?? 'reconciliation', payload)
      );
    } catch (err) {
      this.logger.error({ err }, 'failed to emit RECONCILIATION_EVENT');
    }
  }

  private currentStatus(
    discrepancy: ReconciliationDiscrepancy,
    action: RemediationAction | undefined
  ): string | undefined {
    if (!discrepancy.taskId || !discrepancy.nodeId) return undefined;
    switch (action) {
      case 'mark_orphaned':
        return 'orphaned';
      case 'refund_escrow':
        return 'refunded';
      default:
        return this.paymentDb.findByKey(discrepancy.taskId, discrepancy.nodeId)?.status;
    }
  }

  /**
   * Drift alerts raised in the last `hours` hours, oldest first. Kept in
   * process memory, so the list restarts empty with the process (#811).
   */
  getRecentAlerts(hours: number): DriftAlert[] {
    const since = this.now() - hours * 60 * 60 * 1000;
    return this.recentAlerts.filter((alert) => alert.detectedAt.getTime() >= since);
  }

  /**
   * Deliver one drift alert. Posts it to the configured webhook with a
   * {@link DRIFT_ALERT_TIMEOUT_MS} deadline; without a webhook it is only
   * logged. A delivery failure is logged and never stops reconciliation (#811).
   */
  async notifyDrift(alert: DriftAlert): Promise<void> {
    const payload = {
      level: alert.level,
      service: 'ai-net-backend',
      alert: 'payment_drift_detected',
      taskId: alert.taskId,
      balanceId: alert.balanceId,
      driftType: alert.driftType,
      driftPercent: alert.driftPercent,
      expectedXLM: alert.expectedXLM,
      actualXLM: alert.actualXLM,
      detectedAt: alert.detectedAt.toISOString(),
      message: alert.message,
    };

    if (!this.webhookUrl) {
      this.logger.warn({ alert: payload }, `Drift alert [${alert.level}] ${alert.message}`);
      return;
    }
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DRIFT_ALERT_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.error(
          { status: response.status, taskId: alert.taskId },
          'Drift alert webhook returned non-2xx status'
        );
      }
    } catch (err) {
      this.logger.error({ err, taskId: alert.taskId }, 'Failed to deliver drift alert webhook');
    }
  }

  /**
   * Classify each discrepancy against the alert thresholds and notify for the
   * ones that breach them. Drift on a task that has not settled yet is exempt:
   * its escrow is still expected to be in flight.
   */
  private async raiseDriftAlerts(report: ReconciliationReport): Promise<void> {
    const detectedAt = new Date(this.now());
    for (const discrepancy of report.discrepancies) {
      if (this.isUnsettledTask(discrepancy.taskId)) continue;
      const alert = classifyDriftAlert(discrepancy, this.alertThresholds, detectedAt);
      if (!alert) continue;

      this.metrics.recordDriftAlert(alert.level);
      this.metrics.setLastDriftPercent(alert.driftPercent);
      this.recentAlerts.push(alert);
      if (this.recentAlerts.length > MAX_RECENT_ALERTS) {
        this.recentAlerts.splice(0, this.recentAlerts.length - MAX_RECENT_ALERTS);
      }
      await this.notifyDrift(alert);
    }
  }

  /** `true` when the task exists and has not reached a settled status. */
  private isUnsettledTask(taskId: string | undefined): boolean {
    if (!taskId || !this.taskState) return false;
    const task = this.taskState(taskId);
    return task !== undefined && !SETTLED_TASK_STATUSES.has(task.status.toLowerCase());
  }

  /**
   * Alert on discrepancies: structured logs per discrepancy, threshold-based
   * drift alerts (#811), plus an optional webhook POST with the full report.
   */
  private async alert(report: ReconciliationReport): Promise<void> {
    if (report.discrepancies.length === 0) {
      this.logger.info(
        { runId: report.id, summary: report.summary },
        'Reconciliation complete — no discrepancies'
      );
      return;
    }

    for (const discrepancy of report.discrepancies) {
      this.logger.warn(
        { runId: report.id, driftType: discrepancy.driftType, discrepancy },
        `Reconciliation drift [${discrepancy.driftType}] ${discrepancy.balanceId}`
      );
    }

    await this.raiseDriftAlerts(report);

    if (!this.webhookUrl) return;
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (!response.ok) {
        this.logger.warn(
          { status: response.status },
          'Reconciliation webhook alert returned non-2xx status'
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to deliver reconciliation webhook alert');
    }
  }
}

/** `getConfig()` throws before `loadConfig()`; reconciliation must not depend on order. */
function safeConfig(): ReturnType<typeof getConfig> | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

/** Resolve a task's state from the local task database. */
export function createTaskStateResolver(
  findById: (taskId: string) => { status: string; updatedAt?: string } | undefined
): TaskStateResolver {
  return (taskId: string) => {
    try {
      return findById(taskId);
    } catch (err) {
      log.warn({ err, taskId }, 'failed to read task state for reconciliation');
      return undefined;
    }
  };
}

/**
 * Wire an {@link EscrowSettler} backed by a Stellar coordinator keypair.
 * Returns `undefined` when `STELLAR_COORDINATOR_SECRET` is unset, which keeps
 * the reconciliation loop in detect-and-park mode in CI.
 */
export function createSettlerFromCoordinatorSecret(): EscrowSettler | undefined {
  const secret = safeConfig()?.STELLAR_COORDINATOR_SECRET;
  if (!secret) return undefined;
  // Imported lazily so tests without a configured secret never load the SDK
  // signing path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { PaymentService } = require('../payment/payment') as typeof import('../payment/payment');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
  const keypair = Keypair.fromSecret(secret);
  const service = new PaymentService(createPaymentDb(getDb()));
  return {
    release(balanceId: string, taskId: string, nodeId: string): Promise<string> {
      return service.release(taskId, nodeId, keypair).then((hash) => {
        void balanceId;
        return hash;
      });
    },
    refund(balanceId: string, taskId: string, nodeId: string): Promise<string> {
      return service.refund(taskId, nodeId, keypair).then((hash) => {
        void balanceId;
        return hash;
      });
    },
  };
}

/** Default service wired to the production payment DB, Horizon and task DB. */
export function createDefaultReconciliationService(
  paymentDb?: PaymentDb
): ReconciliationService {
  const taskDb = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { getTaskDb } = require('../db/tasks') as typeof import('../db/tasks');
      return getTaskDb();
    } catch {
      return null;
    }
  })();

  return new ReconciliationService({
    paymentDb: paymentDb ?? createPaymentDb(getDb()),
    ...(taskDb
      ? {
          taskState: createTaskStateResolver((taskId) => {
            const row = taskDb.prepare('SELECT status, updatedAt FROM tasks WHERE id = ?').get(taskId) as
              | { status: string; updatedAt: string }
              | undefined;
            return row ?? undefined;
          }),
        }
      : {}),
    settler: createSettlerFromCoordinatorSecret(),
  });
}
