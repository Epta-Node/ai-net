import express from "express";
import request from "supertest";
import { createReconciliationRouter } from "../api/routes/reconciliation";
import { errorHandler } from "../api/middleware/errorHandler";
import {
  ReconciliationService,
  createSqliteReconciliationReportStore,
  createInMemoryPendingDriftStore,
  xlmStringToStroops,
  type ClaimableBalanceProvider,
  type ClaimTransactionProvider,
  type ReconciliationReportStore,
} from "./reconciliation";
import { ReconciliationMetrics } from "./reconciliation.metrics";
import { createInMemoryReconciliationEventSink } from "./reconciliation.events";
import type { PaymentDb, PaymentRecord, PaymentStatus } from "../db/index";
import type {
  ClaimableBalanceOnChain,
  ReconciliationReport,
  ReconciliationSummary,
} from "./reconciliation.types";

jest.mock("@stellar/stellar-sdk");

/** A `PaymentDb` backed by a Map, mirroring the real compare-and-set semantics. */
function makePaymentDb(records: PaymentRecord[] = []): PaymentDb {
  const store = new Map<string, PaymentRecord>(
    records.map((record) => [`${record.taskId}:${record.nodeId}`, { ...record }])
  );
  return {
    insert(record: PaymentRecord): void {
      store.set(`${record.taskId}:${record.nodeId}`, { ...record });
    },
    findByKey(taskId: string, nodeId: string): PaymentRecord | undefined {
      return store.get(`${taskId}:${nodeId}`);
    },
    updateStatus(taskId: string, nodeId: string, status: PaymentStatus, txHash: string): void {
      const record = store.get(`${taskId}:${nodeId}`);
      if (record) {
        record.status = status;
        record.txHash = txHash;
      }
    },
    updateStatusIfCurrent(
      taskId: string,
      nodeId: string,
      expectedStatus: PaymentStatus,
      status: PaymentStatus,
      txHash: string
    ): boolean {
      const record = store.get(`${taskId}:${nodeId}`);
      if (!record || record.status !== expectedStatus) return false;
      record.status = status;
      record.txHash = txHash;
      return true;
    },
    listAll(): PaymentRecord[] {
      return [...store.values()].map((record) => ({ ...record }));
    },
  };
}

function makeOnChainProvider(balances: ClaimableBalanceOnChain[] = []): ClaimableBalanceProvider {
  return {
    getBalance: jest.fn(async (balanceId: string) => {
      const balance = balances.find((b) => b.balanceId === balanceId);
      return balance ?? null;
    }),
    listBalances: jest.fn(async () => balances.map((b) => ({ ...b }))),
  };
}

/**
 * A claim provider that reports every balance as successfully claimed. The
 * scenario-2 tests override it to simulate a missing Horizon record.
 */
function makeClaimProvider(
  overrides: Partial<ClaimTransactionProvider> = {}
): ClaimTransactionProvider {
  return {
    findClaim: jest.fn(async (balanceId: string) => ({
      hash: `claim-${balanceId}`,
      successful: true,
      ledgerSequence: 1000,
    })),
    getTransaction: jest.fn(async (hash: string) => ({
      hash,
      successful: true,
      ledgerSequence: 999,
    })),
    ...overrides,
  };
}

function makeReportStore(): { store: ReconciliationReportStore; reports: ReconciliationReport[] } {
  const reports: ReconciliationReport[] = [];
  return {
    reports,
    store: {
      save(report) {
        reports.push(report);
      },
      getLatest() {
        return [...reports].sort((a, b) => b.runAt.localeCompare(a.runAt))[0];
      },
    },
  };
}

function makeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    taskId: "task-1",
    nodeId: "node-risk",
    balanceId: "cb-local-1",
    status: "locked",
    amountStroops: 10_000_000n,
    txHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBalance(overrides: Partial<ClaimableBalanceOnChain> = {}): ClaimableBalanceOnChain {
  return {
    balanceId: "cb-onchain-1",
    amountStroops: "10000000",
    asset: "native",
    sponsor: "GCOORDINATOR",
    claimant: "GAGENT",
    ...overrides,
  };
}

const ZEROED_DRIFT_COUNTS = {
  orphaned_locked: 0,
  missing_release_tx: 0,
  release_unconfirmed: 0,
  expired_escrow: 0,
  missing_local: 0,
  amount_mismatch: 0,
};

/** A summary with every counter zeroed — used where the shape matters, not the values. */
function zeroedSummary(overrides: Partial<ReconciliationSummary> = {}): ReconciliationSummary {
  return {
    totalLocalRecords: 0,
    totalOnChainBalances: 0,
    matched: 0,
    discrepancies: 0,
    missingOnChain: 0,
    missingLocal: 0,
    amountMismatch: 0,
    driftByType: { ...ZEROED_DRIFT_COUNTS },
    remediatedByType: { ...ZEROED_DRIFT_COUNTS },
    remediated: 0,
    pendingRemediation: 0,
    releaseVerified: 0,
    releaseUnverified: 0,
    ...overrides,
  };
}

// ─── Amount conversion ────────────────────────────────────────────────────────

describe("xlmStringToStroops", () => {
  it("converts a full XLM amount string to stroops", () => {
    expect(xlmStringToStroops("1.0000000")).toBe(10_000_000n);
    expect(xlmStringToStroops("10.0000000")).toBe(100_000_000n);
  });

  it("converts sub-stroop precision exactly (no float rounding)", () => {
    expect(xlmStringToStroops("0.0000001")).toBe(1n);
    expect(xlmStringToStroops("42.1234567")).toBe(421_234_567n);
  });

  it("handles amounts without a fractional part", () => {
    expect(xlmStringToStroops("5")).toBe(50_000_000n);
  });
});

// ─── Reconciliation run ───────────────────────────────────────────────────────

describe("ReconciliationService.run", () => {
  it("flags orphaned_locked for locked records without an on-chain balance", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.status).toBe("discrepancies_found");
    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "missing_on_chain",
      driftType: "orphaned_locked",
      balanceId: "cb-local-1",
      severity: "critical",
    });
    expect(report.summary.missingOnChain).toBe(1);
    expect(report.summary.driftByType.orphaned_locked).toBe(1);
  });

  it("does not flag released/refunded/orphaned records missing on-chain (claimed as expected)", async () => {
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t-released", status: "released", txHash: "hash-1" }),
      makeRecord({ taskId: "t-refunded", status: "refunded", txHash: "hash-2" }),
      makeRecord({ taskId: "t-orphaned", status: "orphaned", txHash: "reconciled-repair" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      // Every recorded release is verifiable on-chain, so the run is clean.
      claimProvider: makeClaimProvider({
        findClaim: jest.fn(async () => ({ hash: "hash-1", successful: true })),
      }),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.status).toBe("consistent");
    expect(report.discrepancies).toHaveLength(0);
    expect(report.summary.releaseVerified).toBe(1);
  });

  it("flags missing_local for on-chain balances with no local record", async () => {
    const paymentDb = makePaymentDb([]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance()]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.status).toBe("discrepancies_found");
    expect(report.discrepancies[0]).toMatchObject({
      type: "missing_local",
      driftType: "missing_local",
      balanceId: "cb-onchain-1",
    });
    expect(report.summary.missingLocal).toBe(1);
  });

  it("flags amount_mismatch when on-chain and local amounts differ", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([
        makeBalance({ balanceId: "cb-local-1", amountStroops: "5000000" }),
      ]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "amount_mismatch",
      driftType: "amount_mismatch",
      balanceId: "cb-local-1",
      localAmountStroops: "10000000",
      onChainAmountStroops: "5000000",
      expectedAmountStroops: "10000000",
      severity: "critical",
    });
    expect(report.summary.amountMismatch).toBe(1);
  });

  it("flags release_unconfirmed when a released record still has an on-chain balance", async () => {
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t-released", status: "released", txHash: "hash-1" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "release_unconfirmed",
      driftType: "release_unconfirmed",
      onChainAmountStroops: "10000000",
      expectedAmountStroops: "0",
    });
  });

  it("returns a consistent report when all records match", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.status).toBe("consistent");
    expect(report.discrepancies).toHaveLength(0);
    expect(report.summary).toEqual(
      zeroedSummary({
        totalLocalRecords: 1,
        totalOnChainBalances: 1,
        matched: 1,
      })
    );
  });

  it("persists the report with a timestamp", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const reportStore = makeReportStore();
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: reportStore.store,
    });

    const report = await service.run("manual");

    expect(reportStore.reports).toHaveLength(1);
    expect(reportStore.reports[0].id).toBe(report.id);
    expect(reportStore.reports[0].runAt).toBe(report.runAt);
    expect(new Date(report.runAt).toISOString()).toBe(report.runAt);
    expect(report.triggeredBy).toBe("manual");
  });

  it("returns the latest report from the store", async () => {
    const paymentDb = makePaymentDb([]);
    const reportStore = makeReportStore();
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: reportStore.store,
    });

    await service.run();
    const latest = service.getLatestReport();

    expect(latest).toBeDefined();
    expect(latest!.runAt).toBe(reportStore.reports[0].runAt);
  });

  it("returns undefined before any run has been persisted", () => {
    const service = new ReconciliationService({
      paymentDb: makePaymentDb(),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });

    expect(service.getLatestReport()).toBeUndefined();
  });
});

// ─── Alerting ─────────────────────────────────────────────────────────────────

describe("ReconciliationService alerts", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs the report to the webhook when discrepancies are found", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      webhookUrl: "https://alerts.example.com/reconciliation",
    });

    const report = await service.run();

    // One POST carries the full report; one more carries the threshold drift alert (#811).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      "https://alerts.example.com/reconciliation",
      "https://alerts.example.com/reconciliation",
    ]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies.find((body) => body.alert === undefined)?.id).toBe(report.id);
    expect(bodies.filter((body) => body.alert === "payment_drift_detected")).toHaveLength(1);
  });

  it("does not POST to the webhook when no discrepancies are found", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
      webhookUrl: "https://alerts.example.com/reconciliation",
    });

    await service.run();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs each discrepancy", async () => {
    const warn = jest.fn();
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      logger: { info: jest.fn(), warn, error: jest.fn() },
    });

    await service.run();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ discrepancy: expect.objectContaining({ type: "missing_on_chain" }) }),
      expect.stringContaining("orphaned_locked")
    );
  });

  it("survives webhook delivery failures without throwing", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      webhookUrl: "https://alerts.example.com/reconciliation",
    });

    const report = await service.run();
    expect(report.status).toBe("discrepancies_found");
  });
});

// ─── Report store ─────────────────────────────────────────────────────────────

describe("createSqliteReconciliationReportStore", () => {
  it("persists reports and returns the latest by runAt", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    const store = createSqliteReconciliationReportStore(db);

    const earlier = {
      id: "r-1",
      runAt: "2026-08-18T00:00:00.000Z",
      triggeredBy: "manual",
      status: "consistent",
      summary: zeroedSummary(),
      discrepancies: [],
    } as ReconciliationReport;

    const later = { ...earlier, id: "r-2", runAt: "2026-08-19T00:00:00.000Z" };

    store.save(earlier);
    store.save(later);

    // `npm test` maps better-sqlite3 to a statement stub that does not retain
    // rows (see backend/__mocks__/better-sqlite3.js), so the read path is driven
    // by seeding the statement the store prepared. Under `npm run test:sqlite`
    // the real rows are already present and this is a no-op.
    const readStatement = db.prepare(
      "SELECT reportJson FROM reconciliation_reports ORDER BY runAt DESC LIMIT 1"
    ) as { rows?: unknown[] };
    if (Array.isArray(readStatement.rows) && readStatement.rows.length === 0) {
      readStatement.rows.push({ reportJson: JSON.stringify(later) });
    }

    expect(store.getLatest()?.id).toBe("r-2");
  });
});

// ─── Payment service hook ─────────────────────────────────────────────────────

describe("PaymentService reconciliation hook", () => {
  it("exposes listLocalRecords from the payment DB", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PaymentService } = require("../payment/payment");
    const record = makeRecord();
    const service = new PaymentService(makePaymentDb([record]));

    expect(service.listLocalRecords()).toHaveLength(1);
    expect(service.listLocalRecords()[0].balanceId).toBe("cb-local-1");
  });
});

// ─── API routes ───────────────────────────────────────────────────────────────

describe("reconciliation API routes", () => {
  const ADMIN_KEY = "test-admin-key";
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeAll(() => {
    // `adminAuthMiddleware` fails closed: without a configured key every admin
    // route answers 503.
    process.env.ADMIN_API_KEY = ADMIN_KEY;
  });

  afterAll(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = originalAdminKey;
    }
  });

  const sampleReport = (): ReconciliationReport => ({
    id: "r-1",
    runAt: "2026-08-19T00:00:00.000Z",
    triggeredBy: "manual",
    status: "consistent",
    summary: zeroedSummary({ totalLocalRecords: 1, totalOnChainBalances: 1, matched: 1 }),
    discrepancies: [],
  });

  function makeApp(service: Partial<ReconciliationService>): express.Express {
    process.env.ADMIN_API_KEY = "test-admin-key";
    const app = express();
    app.use(express.json());
    app.use(
      "/api/reconciliation",
      createReconciliationRouter({
        service: service as unknown as ReconciliationService,
      })
    );
    app.use(errorHandler);
    return app;
  }

  it("rejects unauthenticated requests with 401", async () => {
    const app = makeApp({ run: jest.fn(), getLatestReport: jest.fn() });

    const response = await request(app).get("/api/reconciliation/report");

    expect(response.status).toBe(401);
  });

  it("POST /run triggers a run and returns the report", async () => {
    const run = jest.fn().mockResolvedValue(sampleReport());
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app)
      .post("/api/reconciliation/run")
      .set("x-admin-api-key", "test-admin-key")
      .send({ triggeredBy: "manual" });

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith("manual");
    expect(response.body.id).toBe("r-1");
  });

  it("POST /run defaults to a manual trigger", async () => {
    const run = jest.fn().mockResolvedValue(sampleReport());
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app)
      .post("/api/reconciliation/run")
      .set("x-admin-api-key", "test-admin-key")
      .send({});

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith("manual");
  });

  it("POST /run rejects an unknown trigger", async () => {
    const run = jest.fn().mockResolvedValue(sampleReport());
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app)
      .post("/api/reconciliation/run")
      .set("X-Admin-API-Key", ADMIN_KEY)
      .send({ triggeredBy: "bogus" });

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("POST /run surfaces failures as a 500", async () => {
    const run = jest.fn().mockRejectedValue(new Error("boom"));
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app)
      .post("/api/reconciliation/run")
      .set("x-admin-api-key", "test-admin-key")
      .send({});

    expect(response.status).toBe(500);
    expect(response.body.error?.code ?? response.body.error).toBe("INTERNAL_ERROR");
  });

  it("GET /report returns the latest report when one exists", async () => {
    const app = makeApp({
      run: jest.fn(),
      getLatestReport: jest.fn().mockReturnValue(sampleReport()),
    });

    const response = await request(app)
      .get("/api/reconciliation/report")
      .set("x-admin-api-key", "test-admin-key");

    expect(response.status).toBe(200);
    expect(response.body.id).toBe("r-1");
  });

  it("GET /report returns 404 when no report exists", async () => {
    const app = makeApp({
      run: jest.fn(),
      getLatestReport: jest.fn().mockReturnValue(undefined),
    });

    const response = await request(app)
      .get("/api/reconciliation/report")
      .set("x-admin-api-key", "test-admin-key");

    expect(response.status).toBe(404);
  });

  it("GET /drift lists pending drift records", async () => {
    const app = makeApp({
      run: jest.fn(),
      listPendingDrift: jest.fn().mockReturnValue([{ id: "t1:n1", driftType: "orphaned_locked" }]),
    } as unknown as Partial<ReconciliationService>);

    const response = await request(app)
      .get("/api/reconciliation/drift")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(response.status).toBe(200);
    expect(response.body.drift).toHaveLength(1);
  });

  it("POST /drift/:id/resolve patches the record and returns the drift", async () => {
    const resolvePendingDrift = jest.fn().mockReturnValue({ id: "t1:n1", acknowledged: true });
    const app = makeApp({
      run: jest.fn(),
      resolvePendingDrift,
    } as unknown as Partial<ReconciliationService>);

    const response = await request(app)
      .post("/api/reconciliation/drift/t1:n1/resolve")
      .set("X-Admin-API-Key", ADMIN_KEY)
      .send({ status: "released", txHash: "abc123", by: "ops" });

    expect(response.status).toBe(200);
    expect(resolvePendingDrift).toHaveBeenCalledWith("t1:n1", "released", "abc123", "ops");
  });

  it("POST /drift/:id/resolve returns 404 for an unknown drift", async () => {
    const app = makeApp({
      run: jest.fn(),
      resolvePendingDrift: jest.fn().mockReturnValue(undefined),
    } as unknown as Partial<ReconciliationService>);

    const response = await request(app)
      .post("/api/reconciliation/drift/nope/resolve")
      .set("X-Admin-API-Key", ADMIN_KEY)
      .send({ status: "released", txHash: "abc123" });

    expect(response.status).toBe(404);
  });

  it("GET /metrics exposes counters and the Prometheus rendering", async () => {
    const metrics = new ReconciliationMetrics();
    metrics.recordRun();
    metrics.recordDriftDetected("orphaned_locked", 2);
    metrics.recordRemediated("orphaned_locked", 1);
    const app = makeApp({ run: jest.fn(), getMetrics: () => metrics } as unknown as Partial<ReconciliationService>);

    const response = await request(app)
      .get("/api/reconciliation/metrics")
      .set("X-Admin-API-Key", ADMIN_KEY);
    expect(response.status).toBe(200);
    expect(response.body.driftDetected.orphaned_locked).toBe(2);
    expect(response.body.remediated.orphaned_locked).toBe(1);
    expect(response.body.prometheus).toContain('reconcile_drift_detected_total{type="orphaned_locked"} 2');
  });
});

// ─── Remediation (idempotent drift repair) ────────────────────────────────────

describe("ReconciliationService remediation", () => {
  it("remediates orphaned_locked by marking the local record orphaned", async () => {
    const paymentDb = makePaymentDb([makeRecord({ taskId: "t1", nodeId: "n1", status: "locked" })]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]), // no on-chain balance → orphaned_locked
      reportStore: makeReportStore().store,
    });

    const report = await service.repair("manual");

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0].driftType).toBe("orphaned_locked");
    const updated = paymentDb.findByKey("t1", "n1");
    expect(updated?.status).toBe("orphaned");
    expect(updated?.txHash).toBe("reconciled-repair");
    expect(report.summary.remediated).toBe(1);
    expect(report.summary.remediatedByType.orphaned_locked).toBe(1);
  });

  it("does not auto-remediate missing_local discrepancies", async () => {
    const paymentDb = makePaymentDb([]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance()]),
      reportStore: makeReportStore().store,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const report = await service.repair("manual");

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0].driftType).toBe("missing_local");
    expect(report.remediations?.[0]).toMatchObject({ action: "manual_review", status: "manual_review" });
  });

  it("remediation is idempotent — running twice produces the same result", async () => {
    const paymentDb = makePaymentDb([makeRecord({ taskId: "t3", nodeId: "n3", status: "locked" })]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });

    const report1 = await service.repair("manual");
    const report2 = await service.repair("manual");

    expect(report1.discrepancies).toHaveLength(1);
    expect(report2.discrepancies).toHaveLength(0);
    expect(report2.status).toBe("consistent");
  });

  it("returns a consistent report when no discrepancies exist", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
    });

    const report = await service.repair("manual");

    expect(report.status).toBe("consistent");
    expect(report.discrepancies).toHaveLength(0);
  });

  it("detects and back-fills a missing release transaction", async () => {
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t9", nodeId: "n9", status: "released", txHash: "wrong-hash" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      claimProvider: makeClaimProvider({
        findClaim: jest.fn(async () => ({
          hash: "real-claim-hash",
          successful: true,
          ledgerSequence: 42,
        })),
      }),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.discrepancies[0].driftType).toBe("missing_release_tx");
    expect(paymentDb.findByKey("t9", "n9")?.txHash).toBe("real-claim-hash");
    expect(report.summary.remediatedByType.missing_release_tx).toBe(1);
  });

  it("parks a missing release transaction for review when no claim hash can be found", async () => {
    const pending = createInMemoryPendingDriftStore();
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t10", nodeId: "n10", status: "released", txHash: "ghost-hash" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      claimProvider: makeClaimProvider({
        findClaim: jest.fn(async () => null),
        getTransaction: jest.fn(async () => null),
      }),
      reportStore: makeReportStore().store,
      pendingDriftStore: pending,
    });

    const report = await service.run();

    expect(report.discrepancies[0].driftType).toBe("missing_release_tx");
    expect(report.remediations?.[0]).toMatchObject({ action: "manual_review", status: "manual_review" });
    expect(pending.records.get("t10:n10")?.recommendedAction).toBe("manual_review");
  });

  it("queues a release re-submit for an unconfirmed release", async () => {
    const settlementQueue = jest.fn();
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t11", nodeId: "n11", status: "released", txHash: "hash-11" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
      settlementQueue,
    });

    const report = await service.run();

    expect(report.discrepancies[0].driftType).toBe("release_unconfirmed");
    expect(settlementQueue).toHaveBeenCalledWith({
      kind: "release",
      balanceId: "cb-local-1",
      taskId: "t11",
      nodeId: "n11",
    });
    expect(report.summary.remediatedByType.release_unconfirmed).toBe(1);
  });

  it("flags a release re-submit for review when no settler is configured", async () => {
    const pending = createInMemoryPendingDriftStore();
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t12", nodeId: "n12", status: "released", txHash: "hash-12" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
      pendingDriftStore: pending,
    });

    const report = await service.run();

    expect(report.remediations?.[0]).toMatchObject({ action: "requeue_release", status: "skipped" });
    expect(pending.records.get("t12:n12")?.recommendedAction).toBe("requeue_release");
  });

  it("resolves a pending drift and patches the payment record", async () => {
    const pending = createInMemoryPendingDriftStore();
    const paymentDb = makePaymentDb([makeRecord({ taskId: "t13", nodeId: "n13", status: "locked" })]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      pendingDriftStore: pending,
      remediationEnabled: false,
    });

    await service.run();
    expect(pending.list()).toHaveLength(1);

    const resolved = service.resolvePendingDrift("t13:n13", "refunded", "refund-hash", "ops");

    expect(resolved?.acknowledged).toBe(true);
    expect(paymentDb.findByKey("t13", "n13")).toMatchObject({
      status: "refunded",
      txHash: "refund-hash",
    });
  });

  it("forgets pending drifts that no longer reproduce", async () => {
    const pending = createInMemoryPendingDriftStore();
    const balances: ClaimableBalanceOnChain[] = [];
    const onChain = makeOnChainProvider(balances);
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([]),
      onChainProvider: onChain,
      reportStore: makeReportStore().store,
      pendingDriftStore: pending,
    });

    balances.push(makeBalance());
    await service.run();
    expect(pending.list()).toHaveLength(1);

    balances.length = 0;
    await service.run();
    expect(pending.list()).toHaveLength(0);
  });
});

// ─── Events and metrics (issue #496 acceptance criteria) ─────────────────────

describe("ReconciliationService events and metrics", () => {
  it("emits a RECONCILIATION_EVENT for each detected drift and each remediation", async () => {
    const sink = createInMemoryReconciliationEventSink();
    const paymentDb = makePaymentDb([makeRecord({ taskId: "t20", nodeId: "n20" })]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      eventSink: sink,
    });

    await service.run();

    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]).toMatchObject({
      type: "ReconciliationEvent",
      taskId: "t20",
      payload: { kind: "drift", driftType: "orphaned_locked", nodeId: "n20" },
    });
    expect(sink.events[1]).toMatchObject({
      type: "ReconciliationEvent",
      payload: {
        kind: "remediation",
        driftType: "orphaned_locked",
        remediation: { action: "mark_orphaned", status: "remediated" },
        newStatus: "orphaned",
      },
    });
  });

  it("does not emit a remediation event when nothing is remediated", async () => {
    const sink = createInMemoryReconciliationEventSink();
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([makeRecord()]),
      onChainProvider: makeOnChainProvider([makeBalance({ balanceId: "cb-local-1" })]),
      reportStore: makeReportStore().store,
      eventSink: sink,
    });

    await service.run();

    expect(sink.events).toHaveLength(0);
  });

  it("survives a throwing event sink", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      eventSink: {
        emit() {
          throw new Error("sink down");
        },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

    const report = await service.run();

    expect(report.summary.remediated).toBe(1);
  });

  it("increments drift and remediation counters per drift type", async () => {
    const metrics = new ReconciliationMetrics();
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([makeRecord({ taskId: "t21", nodeId: "n21" })]),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      metrics,
    });

    await service.run();
    await service.run();

    const snapshot = metrics.snapshot();
    expect(snapshot.driftDetected.orphaned_locked).toBe(1);
    expect(snapshot.remediated.orphaned_locked).toBe(1);
    expect(snapshot.runs).toBe(2);
    expect(snapshot.runsWithDrift).toBe(1);
    expect(snapshot.runsWithRemediation).toBe(1);
  });
});

// ─── Scheduling ───────────────────────────────────────────────────────────────

describe("ReconciliationService.start", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function consistentReport(): ReconciliationReport {
    return {
      id: "r-1",
      runAt: new Date().toISOString(),
      triggeredBy: "scheduled",
      status: "consistent",
      summary: zeroedSummary(),
      discrepancies: [],
    };
  }

  it("defaults to a 60-second interval", () => {
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([]),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });

    service.start();

    expect((service as unknown as { timer: NodeJS.Timeout }).timer).not.toBeNull();
    service.stop();
  });

  it("runs on the configured interval", async () => {
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([]),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });
    const runSpy = jest.spyOn(service, "run").mockResolvedValue(consistentReport());

    service.start(300_000);

    jest.advanceTimersByTime(300_000);
    await Promise.resolve();

    expect(runSpy).toHaveBeenCalledWith("scheduled");

    service.stop();
  });

  it("is idempotent — a second start does not add a second timer", async () => {
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([]),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });
    const runSpy = jest.spyOn(service, "run").mockResolvedValue(consistentReport());

    service.start(300_000);
    service.start(300_000);

    jest.advanceTimersByTime(300_000);
    await Promise.resolve();

    expect(runSpy).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("keeps running after a failed tick", async () => {
    const service = new ReconciliationService({
      paymentDb: makePaymentDb([]),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    const runSpy = jest
      .spyOn(service, "run")
      .mockRejectedValueOnce(new Error("horizon down"))
      .mockResolvedValue(consistentReport());

    service.start(300_000);
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();

    expect(runSpy).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("stop() cancels the scheduler", () => {
    const service = new ReconciliationService({
      paymentDb: makePaymentDb(),
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });
    service.start(300_000);
    service.stop();

    expect((service as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
  });
});
