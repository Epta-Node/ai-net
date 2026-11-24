import {
  validateEvent,
  migrateEvent,
  getSchema,
  getRegisteredVersions,
  isCurrentVersion,
  isDeprecatedVersion,
  getLatestVersion,
} from '../src/events/schemaRegistry';
import {
  CURRENT_EVENT_VERSION,
  MIN_SUPPORTED_EVENT_VERSION,
} from '../src/events/eventTypes';

// ---------------------------------------------------------------------------
// validateEvent
// ---------------------------------------------------------------------------

describe('validateEvent', () => {
  it('returns valid for a well-formed v1 TaskCreated event', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 1,
      payload: {
        prompt: 'Analyze trends',
        walletPublicKey: 'GBZXN7...AAA',
        dagSize: 3,
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid for a well-formed v2 TaskCreated event', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 2,
      payload: {
        prompt: 'Analyze trends',
        walletPublicKey: 'GBZXN7...AAA',
        dagSize: 3,
        agentId: 'agent-001',
        durationMs: 42100,
      },
    });
    expect(result.valid).toBe(true);
  });

  it('returns valid for v2 with only v1 fields (new fields are optional)', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 2,
      payload: {
        prompt: 'Analyze trends',
        walletPublicKey: 'GBZXN7...AAA',
        dagSize: 3,
      },
    });
    expect(result.valid).toBe(true);
  });

  it('returns errors for missing required fields', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 1,
      payload: {
        prompt: 'Analyze trends',
        // missing walletPublicKey and dagSize
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('walletPublicKey');
  });

  it('returns errors for unknown event version', () => {
    const result = validateEvent({
      type: 'TaskCreated',
      version: 99,
      payload: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unknown event version');
  });

  it('returns errors for unknown event type', () => {
    const result = validateEvent({
      type: 'UnknownEvent',
      version: 1,
      payload: {},
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unknown event type');
  });

  it('validates v1 NodeStarted', () => {
    expect(
      validateEvent({
        type: 'NodeStarted',
        version: 1,
        payload: { agentType: 'research' },
      }).valid,
    ).toBe(true);
  });

  it('validates v2 NodeStarted with optional timeoutMs', () => {
    expect(
      validateEvent({
        type: 'NodeStarted',
        version: 2,
        payload: { agentType: 'research', timeoutMs: 30000 },
      }).valid,
    ).toBe(true);
  });

  it('validates v1 NodeCompleted', () => {
    expect(
      validateEvent({
        type: 'NodeCompleted',
        version: 1,
        payload: { result: { summary: 'done' } },
      }).valid,
    ).toBe(true);
  });

  it('validates v2 NodeCompleted with optional durationMs', () => {
    expect(
      validateEvent({
        type: 'NodeCompleted',
        version: 2,
        payload: { result: { summary: 'done' }, durationMs: 14000 },
      }).valid,
    ).toBe(true);
  });

  it('validates v1 NodeFailed', () => {
    expect(
      validateEvent({
        type: 'NodeFailed',
        version: 1,
        payload: { error: 'timeout' },
      }).valid,
    ).toBe(true);
  });

  it('validates v2 NodeFailed with optional retryCount', () => {
    expect(
      validateEvent({
        type: 'NodeFailed',
        version: 2,
        payload: { error: 'timeout', retryCount: 3 },
      }).valid,
    ).toBe(true);
  });

  it('validates v1 PaymentLocked', () => {
    expect(
      validateEvent({
        type: 'PaymentLocked',
        version: 1,
        payload: { balanceId: '000000', amountStroops: 50000000 },
      }).valid,
    ).toBe(true);
  });

  it('validates v2 PaymentLocked with optional xlmAmount', () => {
    expect(
      validateEvent({
        type: 'PaymentLocked',
        version: 2,
        payload: { balanceId: '000000', amountStroops: 50000000, xlmAmount: 5.0 },
      }).valid,
    ).toBe(true);
  });

  it('validates v1 PaymentReleased', () => {
    expect(
      validateEvent({
        type: 'PaymentReleased',
        version: 1,
        payload: { txHash: 'abc123' },
      }).valid,
    ).toBe(true);
  });

  it('validates v2 PaymentReleased with optional ledgerSequence', () => {
    expect(
      validateEvent({
        type: 'PaymentReleased',
        version: 2,
        payload: { txHash: 'abc123', ledgerSequence: 5241098 },
      }).valid,
    ).toBe(true);
  });

  it('validates v1 TaskCompleted (no payload)', () => {
    expect(
      validateEvent({
        type: 'TaskCompleted',
        version: 1,
      }).valid,
    ).toBe(true);
  });

  it('validates v2 TaskCompleted with optional durationMs', () => {
    expect(
      validateEvent({
        type: 'TaskCompleted',
        version: 2,
        payload: { durationMs: 90000 },
      }).valid,
    ).toBe(true);
  });

  it('validates v1 TaskFailed', () => {
    expect(
      validateEvent({
        type: 'TaskFailed',
        version: 1,
        payload: { error: 'failed' },
      }).valid,
    ).toBe(true);
  });

  it('validates v2 TaskFailed with optional failedStage', () => {
    expect(
      validateEvent({
        type: 'TaskFailed',
        version: 2,
        payload: { error: 'failed', failedStage: 'dispatch' },
      }).valid,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// migrateEvent
// ---------------------------------------------------------------------------

describe('migrateEvent', () => {
  it('bumps version from 1 to 2', () => {
    const event = {
      type: 'TaskCreated' as const,
      version: 1,
      payload: { prompt: 'test', walletPublicKey: 'key', dagSize: 1 },
    };
    const migrated = migrateEvent(event, 2);
    expect(migrated.version).toBe(2);
  });

  it('returns the same event when target version matches current', () => {
    const event = { type: 'TaskCreated' as const, version: 2, payload: {} };
    const migrated = migrateEvent(event, 2);
    expect(migrated).toBe(event); // same reference
  });

  it('throws when trying to downgrade', () => {
    const event = { type: 'TaskCreated' as const, version: 2, payload: {} };
    expect(() => migrateEvent(event, 1)).toThrow('Cannot downgrade');
  });

  it('preserves existing payload fields', () => {
    const event = {
      type: 'TaskCreated' as const,
      version: 1,
      payload: { prompt: 'test', walletPublicKey: 'key', dagSize: 1 },
    };
    const migrated = migrateEvent(event, 2);
    expect(migrated.payload).toEqual(event.payload);
  });
});

// ---------------------------------------------------------------------------
// Schema lookup helpers
// ---------------------------------------------------------------------------

describe('getSchema', () => {
  it('returns a schema for a known version and type', () => {
    const schema = getSchema('TaskCreated', 1);
    expect(schema).toBeDefined();
  });

  it('returns undefined for an unknown version', () => {
    expect(getSchema('TaskCreated', 99)).toBeUndefined();
  });

  it('returns undefined for an unknown type', () => {
    // @ts-expect-error — testing runtime behavior for unknown type
    expect(getSchema('UnknownType', 1)).toBeUndefined();
  });
});

describe('getRegisteredVersions', () => {
  it('returns an array of registered versions', () => {
    const versions = getRegisteredVersions();
    expect(versions).toContain(1);
    expect(versions).toContain(2);
    expect(versions.length).toBeGreaterThanOrEqual(2);
  });

  it('returns versions in ascending order', () => {
    const versions = getRegisteredVersions();
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });
});

describe('isCurrentVersion / isDeprecatedVersion', () => {
  it('identifies the current version', () => {
    expect(isCurrentVersion(CURRENT_EVENT_VERSION)).toBe(true);
    expect(isCurrentVersion(CURRENT_EVENT_VERSION - 1)).toBe(false);
  });

  it('identifies deprecated versions', () => {
    expect(isDeprecatedVersion(1)).toBe(CURRENT_EVENT_VERSION > 1);
    expect(isDeprecatedVersion(CURRENT_EVENT_VERSION)).toBe(false);
  });
});

describe('getLatestVersion', () => {
  it('returns CURRENT_EVENT_VERSION', () => {
    expect(getLatestVersion()).toBe(CURRENT_EVENT_VERSION);
  });
});
