/**
 * Versioned event schema registry — validates and documents the event payload
 * shapes across schema versions.
 *
 * ## Design
 *
 * Every event record carries a `version` field (integer).  The schema registry:
 *
 *  1. Maintains a Zod schema per `(eventType, version)` pair.
 *  2. Provides `validateEvent(event)` that checks the event against its
 *     declared version, returning structured validation errors.
 *  3. Provides `migrateEvent(event, targetVersion)` that upgrades an event
 *     from an older version to the latest, applying documented migration rules.
 *  4. Logs deprecation warnings for events emitted at versions older than
 *     the current schema.
 *
 * ## Compatibility rules
 *
 * The schema is **append-only** within a major version:
 *
 *  - Adding a new optional field does NOT require a version bump.  Consumers
 *    should tolerate unknown fields.
 *  - Removing, renaming, or changing the type of an existing field DOES
 *    require a version bump.  Consumers can branch on `version`.
 *  - A breaking change introduces a new version number.
 *
 * ## Adding a new version
 *
 *  1. Increment `CURRENT_EVENT_VERSION` in `eventTypes.ts`.
 *  2. Add the new Zod schemas in the `schemasByVersion` map below.
 *  3. Add migration logic in `migrateEvent()`.
 *  4. Update `docs/EVENTS.md` with examples.
 */

import { z } from 'zod';
import { createLogger } from '../utils/logger';
import { CURRENT_EVENT_VERSION, type EventType } from './eventTypes';

const log = createLogger({ component: 'eventSchemaRegistry' });

// ---------------------------------------------------------------------------
// Base schemas (common to all event types)
// ---------------------------------------------------------------------------

const baseEventSchema = z.object({
  type: z.string(),
  taskId: z.string().min(1),
  occurredAt: z.string(),
  version: z.number().int().min(1),
  globalSeq: z.number().int().optional(),
  taskSeq: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Version 1 payload schemas
// ---------------------------------------------------------------------------

const v1TaskCreatedPayload = z.object({
  prompt: z.string(),
  walletPublicKey: z.string(),
  dagSize: z.number().int().nonnegative(),
});

const v1NodeStartedPayload = z.object({
  agentType: z.string(),
});

const v1NodeCompletedPayload = z.object({
  result: z.unknown(),
});

const v1NodeFailedPayload = z.object({
  error: z.string(),
});

const v1PaymentLockedPayload = z.object({
  balanceId: z.string(),
  amountStroops: z.number(),
});

const v1PaymentReleasedPayload = z.object({
  txHash: z.string(),
});

const v1TaskCompletedPayload = z.object({}).optional();

const v1TaskFailedPayload = z.object({
  error: z.string().optional(),
}).optional();

// ---------------------------------------------------------------------------
// Version 2 payload schemas — new fields added behind version bump
// ---------------------------------------------------------------------------

/**
 * V2 adds `agentId` and `durationMs` to TaskCreatedPayload so consumers can
 * track which agent handled the task without joining a separate table.
 */
const v2TaskCreatedPayload = v1TaskCreatedPayload.extend({
  /** The agent that was dispatched (populated after dispatch). */
  agentId: z.string().optional(),
  /** Duration from creation to completion in milliseconds. */
  durationMs: z.number().int().nonnegative().optional(),
});

const v2NodeStartedPayload = v1NodeStartedPayload.extend({
  /** Maximum time allowed for this node before timeout. */
  timeoutMs: z.number().int().positive().optional(),
});

const v2NodeCompletedPayload = v1NodeCompletedPayload.extend({
  /** Agent response time in milliseconds. */
  durationMs: z.number().int().nonnegative().optional(),
});

const v2NodeFailedPayload = v1NodeFailedPayload.extend({
  /** Number of retry attempts before failure. */
  retryCount: z.number().int().nonnegative().optional(),
});

const v2PaymentLockedPayload = v1PaymentLockedPayload.extend({
  /** XLM equivalent of the locked amount. */
  xlmAmount: z.number().nonnegative().optional(),
});

const v2PaymentReleasedPayload = v1PaymentReleasedPayload.extend({
  /** Stellar ledger sequence at which the release was confirmed. */
  ledgerSequence: z.number().int().positive().optional(),
});

const v2TaskCompletedPayload = z.object({
  /** Total duration from task creation to completion in milliseconds. */
  durationMs: z.number().int().nonnegative().optional(),
}).optional();

const v2TaskFailedPayload = z.object({
  error: z.string().optional(),
  /** The stage at which the task failed (e.g. 'dispatch', 'execution'). */
  failedStage: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Schema registry — map of version → event type → Zod schema
// ---------------------------------------------------------------------------

type EventPayloadSchemas = {
  [K in EventType]: z.ZodType<any>;
};

const schemasByVersion: Record<number, EventPayloadSchemas> = {
  1: {
    TaskCreated: v1TaskCreatedPayload,
    NodeStarted: v1NodeStartedPayload,
    NodeCompleted: v1NodeCompletedPayload,
    NodeFailed: v1NodeFailedPayload,
    PaymentLocked: v1PaymentLockedPayload,
    PaymentReleased: v1PaymentReleasedPayload,
    TaskCompleted: v1TaskCompletedPayload,
    TaskFailed: v1TaskFailedPayload,
  },
  2: {
    TaskCreated: v2TaskCreatedPayload,
    NodeStarted: v2NodeStartedPayload,
    NodeCompleted: v2NodeCompletedPayload,
    NodeFailed: v2NodeFailedPayload,
    PaymentLocked: v2PaymentLockedPayload,
    PaymentReleased: v2PaymentReleasedPayload,
    TaskCompleted: v2TaskCompletedPayload,
    TaskFailed: v2TaskFailedPayload,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate an event payload against its declared version.
 *
 * @param event  The event object (must include `type`, `version`, and `payload`).
 * @returns      A result indicating whether the event matches its schema.
 */
export function validateEvent(event: {
  type: string;
  version: number;
  payload?: unknown;
  [key: string]: unknown;
}): ValidationResult {
  const { type, version } = event;

  // Check that the version is known
  const versionSchemas = schemasByVersion[version];
  if (!versionSchemas) {
    return {
      valid: false,
      errors: [`Unknown event version: ${version}. Known versions: ${Object.keys(schemasByVersion).join(', ')}`],
    };
  }

  // Check that the event type is known
  const payloadSchema = versionSchemas[type as EventType];
  if (!payloadSchema) {
    return {
      valid: false,
      errors: [`Unknown event type: ${type}`],
    };
  }

  // Validate the payload
  const result = payloadSchema.safeParse(event.payload);
  if (result.success) {
    return { valid: true, errors: [] };
  }

  const errors = result.error.issues.map(
    (issue) => `${type}.payload.${issue.path.join('.')}: ${issue.message}`,
  );

  return { valid: false, errors };
}

/**
 * Migrate an event from one version to another.
 *
 * Currently supports migration from version 1 → 2.  Migration fills in
 * new optional fields with sensible defaults (undefined / absent).
 *
 * @param event          The source event.
 * @param targetVersion  The desired output version (must be >= event.version).
 * @returns              A new event object with the target version applied.
 */
export function migrateEvent<T extends { version: number; payload?: unknown; type?: string }>(
  event: T,
  targetVersion: number,
): T {
  if (targetVersion < event.version) {
    throw new Error(
      `Cannot downgrade event from version ${event.version} to ${targetVersion}`,
    );
  }

  if (targetVersion === event.version) {
    return event;
  }

  // For now, migration between known versions just bumps the version number.
  // New fields are optional, so no data transformation is needed — consumers
  // of the new version simply tolerate missing optional fields.
  const migrated = { ...event, version: targetVersion };

  log.debug(
    { fromVersion: event.version, toVersion: targetVersion, type: event.type },
    'event migrated to newer schema version',
  );

  return migrated;
}

/**
 * Get the Zod schema for a specific event type and version.
 * Returns undefined if the combination is not registered.
 */
export function getSchema(
  eventType: EventType,
  version: number,
): z.ZodType<any> | undefined {
  return schemasByVersion[version]?.[eventType];
}

/**
 * Get all registered versions for an event type.
 */
export function getRegisteredVersions(): number[] {
  return Object.keys(schemasByVersion).map(Number).sort((a, b) => a - b);
}

/**
 * Check whether a given event version is the current/latest version.
 */
export function isCurrentVersion(version: number): boolean {
  return version === CURRENT_EVENT_VERSION;
}

/**
 * Check whether a given event version is deprecated (older than current).
 */
export function isDeprecatedVersion(version: number): boolean {
  return version < CURRENT_EVENT_VERSION;
}

/**
 * Get the latest supported schema version.
 */
export function getLatestVersion(): number {
  return CURRENT_EVENT_VERSION;
}
