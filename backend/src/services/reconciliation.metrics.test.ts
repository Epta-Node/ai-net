/**
 * Unit tests for the reconciliation metric registry and the
 * `RECONCILIATION_EVENT` sinks (issue #496).
 */

import { ReconciliationMetrics } from "./reconciliation.metrics";
import {
  createEventBusReconciliationEventSink,
  createInMemoryReconciliationEventSink,
  createNoopReconciliationEventSink,
} from "./reconciliation.events";
import {
  makeReconciliationEvent,
  RECONCILIATION_EVENT,
} from "../events/eventTypes";
import { validateEvent } from "../events/schemaRegistry";
import type {
  ReconciliationEventEvent,
  ReconciliationEventPayload,
} from "../events/eventTypes";

/** `validateEvent` takes an index-signature shape; the event union does not have one. */
function validated(event: ReconciliationEventEvent) {
  return validateEvent(event as unknown as Parameters<typeof validateEvent>[0]);
}

const payload = (
  overrides: Partial<ReconciliationEventPayload> = {},
): ReconciliationEventPayload => ({
  runId: "run-1",
  kind: "drift",
  driftType: "orphaned_locked",
  balanceId: "cb-1",
  taskId: "t1",
  nodeId: "n1",
  severity: "critical",
  description: "escrow vanished",
  ...overrides,
});

describe("ReconciliationMetrics", () => {
  let metrics: ReconciliationMetrics;

  beforeEach(() => {
    metrics = new ReconciliationMetrics();
  });

  it("starts at zero for every family", () => {
    expect(metrics.snapshot()).toEqual({
      driftDetected: {
        orphaned_locked: 0,
        missing_release_tx: 0,
        release_unconfirmed: 0,
        expired_escrow: 0,
        missing_local: 0,
        amount_mismatch: 0,
      },
      remediated: {
        orphaned_locked: 0,
        missing_release_tx: 0,
        release_unconfirmed: 0,
        expired_escrow: 0,
        missing_local: 0,
        amount_mismatch: 0,
      },
      remediationFailed: {
        orphaned_locked: 0,
        missing_release_tx: 0,
        release_unconfirmed: 0,
        expired_escrow: 0,
        missing_local: 0,
        amount_mismatch: 0,
      },
      runs: 0,
      runsWithDrift: 0,
      runsWithRemediation: 0,
    });
  });

  it("counts drift detections per type", () => {
    metrics.recordDriftDetected("orphaned_locked");
    metrics.recordDriftDetected("orphaned_locked");
    metrics.recordDriftDetected("expired_escrow", 3);

    expect(metrics.get("driftDetected", "orphaned_locked")).toBe(2);
    expect(metrics.get("driftDetected", "expired_escrow")).toBe(3);
    expect(metrics.get("driftDetected", "missing_local")).toBe(0);
  });

  it("counts remediations and failures per type", () => {
    metrics.recordRemediated("release_unconfirmed");
    metrics.recordRemediationFailed("release_unconfirmed");
    metrics.recordRemediationFailed("release_unconfirmed", 2);

    expect(metrics.get("remediated", "release_unconfirmed")).toBe(1);
    expect(metrics.get("remediationFailed", "release_unconfirmed")).toBe(3);
  });

  it("tracks run-level counters", () => {
    metrics.recordRun();
    metrics.recordRun();
    metrics.recordRun();
    metrics.recordRunWithDrift();
    metrics.recordRunWithRemediation();

    expect(metrics.snapshot()).toMatchObject({
      runs: 3,
      runsWithDrift: 1,
      runsWithRemediation: 1,
    });
  });

  it("returns copies so callers cannot mutate the registry", () => {
    metrics.recordDriftDetected("orphaned_locked");
    const snapshot = metrics.snapshot();
    snapshot.driftDetected.orphaned_locked = 999;

    expect(metrics.get("driftDetected", "orphaned_locked")).toBe(1);
  });

  it("resets every counter", () => {
    metrics.recordRun();
    metrics.recordDriftDetected("orphaned_locked");
    metrics.recordRemediated("orphaned_locked");
    metrics.recordRemediationFailed("orphaned_locked");
    metrics.recordRunWithDrift();
    metrics.recordRunWithRemediation();

    metrics.reset();

    expect(metrics.snapshot().runs).toBe(0);
    expect(metrics.get("driftDetected", "orphaned_locked")).toBe(0);
  });

  describe("toPrometheus", () => {
    it("emits every drift label for every family, including zeroes", () => {
      const output = metrics.toPrometheus();

      for (const type of [
        "orphaned_locked",
        "missing_release_tx",
        "release_unconfirmed",
        "expired_escrow",
        "missing_local",
        "amount_mismatch",
      ]) {
        expect(output).toContain(
          `reconcile_drift_detected_total{type="${type}"} 0`,
        );
        expect(output).toContain(
          `reconcile_remediated_total{type="${type}"} 0`,
        );
        expect(output).toContain(
          `reconcile_remediation_failed_total{type="${type}"} 0`,
        );
      }
    });

    it("declares HELP and TYPE for each family", () => {
      const output = metrics.toPrometheus();
      expect(output).toContain("# HELP reconcile_drift_detected_total");
      expect(output).toContain("# TYPE reconcile_drift_detected_total counter");
      expect(output).toContain("# HELP reconcile_remediated_total");
      expect(output).toContain("# TYPE reconcile_runs_total counter");
    });

    it("renders the current values", () => {
      metrics.recordDriftDetected("expired_escrow", 4);
      metrics.recordRemediated("expired_escrow", 2);
      metrics.recordRun();

      const output = metrics.toPrometheus();
      expect(output).toContain(
        'reconcile_drift_detected_total{type="expired_escrow"} 4',
      );
      expect(output).toContain(
        'reconcile_remediated_total{type="expired_escrow"} 2',
      );
      expect(output).toContain("reconcile_runs_total 1");
      expect(output.endsWith("\n")).toBe(true);
    });
  });
});

describe("RECONCILIATION_EVENT", () => {
  it("is a member of the EventType union", () => {
    expect(RECONCILIATION_EVENT).toBe("ReconciliationEvent");
  });

  it("builds a schema-valid event", () => {
    const event = makeReconciliationEvent(
      "t1",
      payload(),
      "2026-09-01T00:00:00.000Z",
    );

    expect(event).toEqual({
      type: "ReconciliationEvent",
      taskId: "t1",
      occurredAt: "2026-09-01T00:00:00.000Z",
      version: 2,
      payload: payload(),
    });
    expect(validated(event)).toEqual({ valid: true, errors: [] });
  });

  it("validates a remediation event carrying an outcome", () => {
    const event = makeReconciliationEvent(
      "t1",
      payload({
        kind: "remediation",
        remediation: {
          action: "refund_escrow",
          status: "remediated",
          txHash: "hash-1",
          at: "2026-09-01T00:00:00.000Z",
        },
        previousStatus: "locked",
        newStatus: "refunded",
      }),
    );

    expect(validated(event)).toEqual({ valid: true, errors: [] });
  });

  it("rejects an unknown drift type", () => {
    const event = makeReconciliationEvent("t1", {
      ...payload(),
      driftType: "not_a_drift" as never,
    });

    const result = validated(event);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("driftType");
  });

  describe("sinks", () => {
    it("records events in memory", () => {
      const sink = createInMemoryReconciliationEventSink();
      sink.emit(makeReconciliationEvent("t1", payload()));

      expect(sink.events).toHaveLength(1);
      expect(sink.events[0].type).toBe("ReconciliationEvent");
    });

    it("the noop sink swallows everything", () => {
      expect(() =>
        createNoopReconciliationEventSink().emit(
          makeReconciliationEvent("t1", payload()),
        ),
      ).not.toThrow();
    });

    it("appends to a supplied event store", () => {
      const appended: unknown[] = [];
      const store = {
        append: (event: unknown) => {
          appended.push(event);
          return event;
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sink = createEventBusReconciliationEventSink(store as any);

      sink.emit(makeReconciliationEvent("t1", payload()));

      expect(appended).toHaveLength(1);
    });

    it("swallows a store failure so remediation is never blocked", () => {
      const store = {
        append: () => {
          throw new Error("event store offline");
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sink = createEventBusReconciliationEventSink(store as any);

      expect(() =>
        sink.emit(makeReconciliationEvent("t1", payload())),
      ).not.toThrow();
    });
  });
});
