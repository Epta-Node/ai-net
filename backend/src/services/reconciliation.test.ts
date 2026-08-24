import express from "express";
import request from "supertest";
import { createReconciliationRouter } from "../api/routes/reconciliation";
import {
  ReconciliationService,
  createSqliteReconciliationReportStore,
  xlmStringToStroops,
  type ClaimableBalanceProvider,
  type ReconciliationReportStore,
} from "./reconciliation";
import type { PaymentDb, PaymentRecord, PaymentStatus } from "../db/index";
import type {
  ClaimableBalanceOnChain,
  ReconciliationReport,
} from "./reconciliation.types";

jest.mock("@stellar/stellar-sdk");

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
  it("flags missing_on_chain for locked records without an on-chain balance", async () => {
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
      balanceId: "cb-local-1",
      severity: "critical",
    });
    expect(report.summary.missingOnChain).toBe(1);
  });

  it("does not flag released/refunded records missing on-chain (claimed as expected)", async () => {
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t-released", status: "released", txHash: "hash-1" }),
      makeRecord({ taskId: "t-refunded", status: "refunded", txHash: "hash-2" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.status).toBe("consistent");
    expect(report.discrepancies).toHaveLength(0);
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
      balanceId: "cb-local-1",
      localAmountStroops: "10000000",
      onChainAmountStroops: "5000000",
      expectedAmountStroops: "10000000",
      severity: "critical",
    });
    expect(report.summary.amountMismatch).toBe(1);
  });

  it("flags amount_mismatch when a released record still has an on-chain balance", async () => {
    const paymentDb = makePaymentDb([
      makeRecord({ taskId: "t-released", status: "released", txHash: "hash-1" }),
    ]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([
        makeBalance({ balanceId: "cb-local-1" }),
      ]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0]).toMatchObject({
      type: "amount_mismatch",
      severity: "warning",
      expectedAmountStroops: "0",
      onChainAmountStroops: "10000000",
    });
  });

  it("returns a consistent report when all records match", async () => {
    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([
        makeBalance({ balanceId: "cb-local-1" }),
      ]),
      reportStore: makeReportStore().store,
    });

    const report = await service.run();

    expect(report.status).toBe("consistent");
    expect(report.discrepancies).toHaveLength(0);
    expect(report.summary).toEqual({
      totalLocalRecords: 1,
      totalOnChainBalances: 1,
      matched: 1,
      discrepancies: 0,
      missingOnChain: 0,
      missingLocal: 0,
      amountMismatch: 0,
    });
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://alerts.example.com/reconciliation");
    expect(JSON.parse((init as RequestInit).body as string).id).toBe(report.id);
  });

  it("does not POST to the webhook when no discrepancies are found", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const paymentDb = makePaymentDb([makeRecord()]);
    const service = new ReconciliationService({
      paymentDb,
      onChainProvider: makeOnChainProvider([
        makeBalance({ balanceId: "cb-local-1" }),
      ]),
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
      expect.stringContaining("missing_on_chain")
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
    const Database = require("better-sqlite3");
    const store = createSqliteReconciliationReportStore(new Database(":memory:"));

    const earlier = {
      id: "r-1",
      runAt: "2026-08-18T00:00:00.000Z",
      triggeredBy: "manual",
      status: "consistent",
      summary: {
        totalLocalRecords: 0,
        totalOnChainBalances: 0,
        matched: 0,
        discrepancies: 0,
        missingOnChain: 0,
        missingLocal: 0,
        amountMismatch: 0,
      },
      discrepancies: [],
    } as ReconciliationReport;

    const later = { ...earlier, id: "r-2", runAt: "2026-08-19T00:00:00.000Z" };

    store.save(earlier);
    store.save(later);

    expect(store.getLatest()?.id).toBe("r-2");
  });
});

// ─── Payment service hook ─────────────────────────────────────────────────────

describe("PaymentService reconciliation hook", () => {
  it("exposes listLocalRecords from the payment DB", () => {
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
  const sampleReport = (): ReconciliationReport => ({
    id: "r-1",
    runAt: "2026-08-19T00:00:00.000Z",
    triggeredBy: "manual",
    status: "consistent",
    summary: {
      totalLocalRecords: 1,
      totalOnChainBalances: 1,
      matched: 1,
      discrepancies: 0,
      missingOnChain: 0,
      missingLocal: 0,
      amountMismatch: 0,
    },
    discrepancies: [],
  });

  function makeApp(service: Partial<ReconciliationService>): express.Express {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/reconciliation",
      createReconciliationRouter({
        service: service as unknown as ReconciliationService,
      })
    );
    return app;
  }

  it("POST /run triggers a run and returns the report", async () => {
    const run = jest.fn().mockResolvedValue(sampleReport());
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app)
      .post("/api/reconciliation/run")
      .send({ triggeredBy: "manual" });

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith("manual");
    expect(response.body.id).toBe("r-1");
  });

  it("POST /run defaults to a manual trigger", async () => {
    const run = jest.fn().mockResolvedValue(sampleReport());
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app).post("/api/reconciliation/run").send({});

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith("manual");
  });

  it("POST /run surfaces failures as a 500", async () => {
    const run = jest.fn().mockRejectedValue(new Error("boom"));
    const app = makeApp({ run, getLatestReport: jest.fn() });

    const response = await request(app).post("/api/reconciliation/run").send({});

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("RECONCILIATION_FAILED");
  });

  it("GET /report returns the latest report when one exists", async () => {
    const app = makeApp({
      run: jest.fn(),
      getLatestReport: jest.fn().mockReturnValue(sampleReport()),
    });

    const response = await request(app).get("/api/reconciliation/report");

    expect(response.status).toBe(200);
    expect(response.body.id).toBe("r-1");
  });

  it("GET /report returns 404 when no report exists", async () => {
    const app = makeApp({
      run: jest.fn(),
      getLatestReport: jest.fn().mockReturnValue(undefined),
    });

    const response = await request(app).get("/api/reconciliation/report");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("NO_RECONCILIATION_REPORT");
  });
});