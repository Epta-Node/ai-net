/**
 * Reconciliation drift metrics (issue #496).
 *
 * Two counter families are maintained, both labelled by {@link DriftType}:
 *
 * • `reconcile.driftDetected{type}` — how often a drift category was observed.
 * • `reconcile.remediated{type}`   — how often a drift category was actually
 *   repaired (as opposed to merely reported).
 *
 * The difference between the two is the operational signal: a growing gap means
 * drift is being detected but not acted upon, which is the condition that leads
 * to stranded escrows.
 *
 * A tiny process-local registry is all this needs: the counters are reset on
 * restart by design (they are rates and ratios, not a ledger), and the durable
 * record of what happened lives in the reconciliation report and the
 * `reconcile_pending_drift` table.
 */

import { DRIFT_TYPES, type DriftType } from "./reconciliation.types";

/** Snapshot of every reconciliation counter. */
export interface ReconciliationMetricsSnapshot {
  /** Drift detections per category since process start. */
  driftDetected: Record<DriftType, number>;
  /** Remediations per category since process start. */
  remediated: Record<DriftType, number>;
  /** Remediation attempts that failed, per category. */
  remediationFailed: Record<DriftType, number>;
  /** Total reconciliation runs started. */
  runs: number;
  /** Runs that found at least one drift. */
  runsWithDrift: number;
  /** Runs that remediated at least one drift. */
  runsWithRemediation: number;
}

function zeroed(): Record<DriftType, number> {
  const out = {} as Record<DriftType, number>;
  for (const type of DRIFT_TYPES) out[type] = 0;
  return out;
}

/**
 * In-process counter registry. Exposed as a class so tests can construct an
 * isolated instance; production code uses {@link reconciliationMetrics}.
 */
export class ReconciliationMetrics {
  private driftDetected = zeroed();
  private remediated = zeroed();
  private remediationFailed = zeroed();
  private runs = 0;
  private runsWithDrift = 0;
  private runsWithRemediation = 0;
  /** Alerts raised at the warning threshold (#811). */
  private driftWarnings = 0;
  /** Alerts raised at the critical threshold (#811). */
  private driftCritical = 0;
  /** Drift percentage of the most recent alert (#811). */
  private lastDriftPercent = 0;

  /** Count one drift alert at the given level (#811). */
  recordDriftAlert(level: 'warning' | 'critical'): void {
    if (level === 'critical') this.driftCritical += 1;
    else this.driftWarnings += 1;
  }

  /** Record the drift percentage of the most recent alert (#811). */
  setLastDriftPercent(percent: number): void {
    this.lastDriftPercent = percent;
  }

  /** Count one detected drift of the given category. */
  recordDriftDetected(type: DriftType, count = 1): void {
    this.driftDetected[type] = (this.driftDetected[type] ?? 0) + count;
  }

  /** Count one successfully applied remediation. */
  recordRemediated(type: DriftType, count = 1): void {
    this.remediated[type] = (this.remediated[type] ?? 0) + count;
  }

  /** Count one remediation attempt that did not succeed. */
  recordRemediationFailed(type: DriftType, count = 1): void {
    this.remediationFailed[type] = (this.remediationFailed[type] ?? 0) + count;
  }

  /** Mark the start of a reconciliation run. */
  recordRun(): void {
    this.runs += 1;
  }

  /** Mark that a run observed at least one drift. */
  recordRunWithDrift(): void {
    this.runsWithDrift += 1;
  }

  /** Mark that a run remediated at least one drift. */
  recordRunWithRemediation(): void {
    this.runsWithRemediation += 1;
  }

  /** Current values of every counter. */
  snapshot(): ReconciliationMetricsSnapshot {
    return {
      driftDetected: { ...this.driftDetected },
      remediated: { ...this.remediated },
      remediationFailed: { ...this.remediationFailed },
      runs: this.runs,
      runsWithDrift: this.runsWithDrift,
      runsWithRemediation: this.runsWithRemediation,
    };
  }

  /** Value of a single counter. */
  get(
    kind: "driftDetected" | "remediated" | "remediationFailed",
    type: DriftType,
  ): number {
    return this[kind][type] ?? 0;
  }

  /** Reset every counter (test helper / ops endpoint). */
  reset(): void {
    this.driftDetected = zeroed();
    this.remediated = zeroed();
    this.remediationFailed = zeroed();
    this.runs = 0;
    this.runsWithDrift = 0;
    this.runsWithRemediation = 0;
    this.driftWarnings = 0;
    this.driftCritical = 0;
    this.lastDriftPercent = 0;
  }

  /**
   * Render the counters in Prometheus text exposition format.
   *
   * Every drift category is emitted for every family — including the ones that
   * are still zero — so a dashboard never has to special-case a label that has
   * not been seen yet.
   */
  toPrometheus(): string {
    const lines: string[] = [];
    const families: Array<[string, string, Record<DriftType, number>]> = [
      [
        "reconcile_drift_detected_total",
        "Total payment state drifts detected, by drift type",
        this.driftDetected,
      ],
      [
        "reconcile_remediated_total",
        "Total payment state drifts remediated automatically, by drift type",
        this.remediated,
      ],
      [
        "reconcile_remediation_failed_total",
        "Total payment remediation attempts that did not succeed, by drift type",
        this.remediationFailed,
      ],
    ];

    for (const [name, help, counters] of families) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const type of DRIFT_TYPES) {
        lines.push(`${name}{type="${type}"} ${counters[type] ?? 0}`);
      }
      lines.push("");
    }

    lines.push(
      "# HELP reconcile_runs_total Total reconciliation runs executed",
    );
    lines.push("# TYPE reconcile_runs_total counter");
    lines.push(`reconcile_runs_total ${this.runs}`);
    lines.push("");
    lines.push(
      "# HELP reconcile_runs_with_drift_total Reconciliation runs that found drift",
    );
    lines.push("# TYPE reconcile_runs_with_drift_total counter");
    lines.push(`reconcile_runs_with_drift_total ${this.runsWithDrift}`);
    lines.push("");
    lines.push(
      "# HELP reconcile_runs_with_remediation_total Reconciliation runs that remediated drift",
    );
    lines.push("# TYPE reconcile_runs_with_remediation_total counter");
    lines.push(
      `reconcile_runs_with_remediation_total ${this.runsWithRemediation}`,
    );
    lines.push("");
    lines.push("# HELP reconciliation_drift_warnings_total Drift alerts raised at the warning threshold");
    lines.push("# TYPE reconciliation_drift_warnings_total counter");
    lines.push(`reconciliation_drift_warnings_total ${this.driftWarnings}`);
    lines.push("");
    lines.push("# HELP reconciliation_drift_critical_total Drift alerts raised at the critical threshold");
    lines.push("# TYPE reconciliation_drift_critical_total counter");
    lines.push(`reconciliation_drift_critical_total ${this.driftCritical}`);
    lines.push("");
    lines.push("# HELP reconciliation_last_drift_percent Drift percentage of the most recent alert");
    lines.push("# TYPE reconciliation_last_drift_percent gauge");
    lines.push(`reconciliation_last_drift_percent ${this.lastDriftPercent}`);

    return lines.join("\n") + "\n";
  }
}

/** Process-wide registry used by the reconciliation service. */
export const reconciliationMetrics = new ReconciliationMetrics();
