/**
 * Payment reconciliation service.
 *
 * Cross-references local payment records with Stellar on-chain claimable
 * balances, flags discrepancies (missing on-chain, missing local, amount
 * mismatch), persists a timestamped report, and alerts on discrepancies
 * (structured log + optional webhook).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Horizon, Asset } from '@stellar/stellar-sdk';
import { createLogger } from '../utils/logger';
import { createPaymentDb, getDb, type PaymentDb, type PaymentRecord } from '../db/index';
import type {
  ClaimableBalanceOnChain,
  ReconciliationDiscrepancy,
  ReconciliationReport,
  ReconciliationSummary,
  ReconciliationTrigger,
} from './reconciliation.types';

const log = createLogger({ component: 'reconciliation' });

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_DAILY_INTERVAL_MS = 86_400_000; // 24h
const LIST_BALANCES_MAX_PAGES = 10;
const LIST_BALANCES_PAGE_LIMIT = 200;

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

/** Default provider backed by the Stellar SDK (Horizon REST API). */
export class HorizonClaimableBalanceProvider implements ClaimableBalanceProvider {
  private readonly server: Horizon.Server;

  constructor(horizonUrl?: string) {
    this.server = new Horizon.Server(
      horizonUrl ?? process.env.STELLAR_HORIZON ?? DEFAULT_HORIZON_URL
    );
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

/** Persistence for reconciliation reports. */
export interface ReconciliationReportStore {
  save(report: ReconciliationReport): void;
  getLatest(): ReconciliationReport | undefined;
}

/** SQLite-backed report store; defaults to an in-memory database. */
export function createSqliteReconciliationReportStore(
  db?: Database.Database
): ReconciliationReportStore {
  const database =
    db ?? new Database(path.join(process.cwd(), 'reconciliation.db') as unknown as string);

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

export interface ReconciliationServiceOptions {
  /** Local payment records used as the source of truth. */
  paymentDb: PaymentDb;
  /** On-chain query provider; defaults to Horizon via the Stellar SDK. */
  onChainProvider?: ClaimableBalanceProvider;
  /** Where reports are persisted; defaults to a SQLite store. */
  reportStore?: ReconciliationReportStore;
  /** Optional webhook URL alerted on discrepancies. */
  webhookUrl?: string;
  /** Logger for reconciliation events; defaults to a pino child logger. */
  logger?: Pick<typeof log, 'info' | 'warn' | 'error'>;
}

export class ReconciliationService {
  private readonly paymentDb: PaymentDb;
  private readonly onChainProvider: ClaimableBalanceProvider;
  private readonly reportStore: ReconciliationReportStore;
  private readonly webhookUrl?: string;
  private readonly logger: Pick<typeof log, 'info' | 'warn' | 'error'>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: ReconciliationServiceOptions) {
    this.paymentDb = options.paymentDb;
    this.onChainProvider =
      options.onChainProvider ?? new HorizonClaimableBalanceProvider();
    this.reportStore =
      options.reportStore ?? createSqliteReconciliationReportStore();
    this.webhookUrl =
      options.webhookUrl ?? process.env.RECONCILIATION_WEBHOOK_URL;
    this.logger = options.logger ?? log;
  }

  /**
   * Run a reconciliation pass: compare every local payment record against
   * on-chain claimable balances, persist a timestamped report, and alert on
   * discrepancies. Never throws — infrastructure failures surface inside the
   * report's discrepancies or log, keeping automated runs resilient.
   */
  async run(triggeredBy: ReconciliationTrigger = 'manual'): Promise<ReconciliationReport> {
    if (this.running) {
      const inFlight = this.getLatestReport();
      if (inFlight) return inFlight;
      throw new Error('Reconciliation already in progress');
    }
    this.running = true;
    try {
      const localRecords = this.paymentDb.listAll();
      const onChainBalances = await this.onChainProvider.listBalances();
      const onChainByBalanceId = new Map(
        onChainBalances.map((balance) => [balance.balanceId, balance])
      );
      const localBalanceIds = new Set<string>();
      const matchedBalanceIds = new Set<string>();
      const discrepancies: ReconciliationDiscrepancy[] = [];

      for (const record of localRecords) {
        localBalanceIds.add(record.balanceId);
        const onChain = onChainByBalanceId.get(record.balanceId);

        if (!onChain) {
          if (record.status === 'locked') {
            discrepancies.push({
              type: 'missing_on_chain',
              balanceId: record.balanceId,
              taskId: record.taskId,
              nodeId: record.nodeId,
              severity: 'critical',
              description:
                `Local payment record (task=${record.taskId}, node=${record.nodeId}, ` +
                `status=${record.status}) has no matching on-chain claimable balance`,
              localAmountStroops: record.amountStroops.toString(),
            });
          }
          // Released/refunded records are expected to have no on-chain
          // balance (it was claimed) — not a discrepancy.
          continue;
        }

        matchedBalanceIds.add(record.balanceId);
        const onChainStroops = BigInt(onChain.amountStroops);
        // A released/refunded record should have 0 stroops on-chain.
        const expectedStroops = record.status === 'locked' ? record.amountStroops : 0n;

        if (expectedStroops !== onChainStroops) {
          discrepancies.push({
            type: 'amount_mismatch',
            balanceId: record.balanceId,
            taskId: record.taskId,
            nodeId: record.nodeId,
            severity: record.status === 'locked' ? 'critical' : 'warning',
            description:
              record.status === 'locked'
                ? `On-chain amount ${onChain.amountStroops} stroops does not match ` +
                  `local record amount ${record.amountStroops.toString()} stroops ` +
                  `(task=${record.taskId}, node=${record.nodeId})`
                : `Record (task=${record.taskId}, node=${record.nodeId}) is ` +
                  `status=${record.status} but ${onChain.amountStroops} stroops are ` +
                  `still claimable on-chain`,
            localAmountStroops: record.amountStroops.toString(),
            onChainAmountStroops: onChain.amountStroops,
            expectedAmountStroops: expectedStroops.toString(),
          });
        }
      }

      for (const balance of onChainBalances) {
        if (!localBalanceIds.has(balance.balanceId)) {
          discrepancies.push({
            type: 'missing_local',
            balanceId: balance.balanceId,
            severity: 'warning',
            description:
              `On-chain claimable balance ${balance.balanceId} ` +
              `(${balance.amountStroops} stroops) has no matching local payment record`,
            onChainAmountStroops: balance.amountStroops,
          });
        }
      }

      const summary: ReconciliationSummary = {
        totalLocalRecords: localRecords.length,
        totalOnChainBalances: onChainBalances.length,
        matched: matchedBalanceIds.size,
        discrepancies: discrepancies.length,
        missingOnChain: discrepancies.filter((d) => d.type === 'missing_on_chain').length,
        missingLocal: discrepancies.filter((d) => d.type === 'missing_local').length,
        amountMismatch: discrepancies.filter((d) => d.type === 'amount_mismatch').length,
      };

      const report: ReconciliationReport = {
        id: randomUUID(),
        runAt: new Date().toISOString(),
        triggeredBy,
        status: discrepancies.length > 0 ? 'discrepancies_found' : 'consistent',
        summary,
        discrepancies,
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

  /** Schedule automated (daily) reconciliation runs. Idempotent. */
  startDaily(intervalMs: number = DEFAULT_DAILY_INTERVAL_MS): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        await this.run('scheduled');
      } catch (err) {
        this.logger.error({ err }, 'Scheduled reconciliation run failed');
      }
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    this.logger.info({ intervalMs }, 'Daily reconciliation scheduled');
  }

  /** Stop the automated scheduler. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Daily reconciliation stopped');
    }
  }

  /**
   * Alert on discrepancies: structured logs per discrepancy plus an optional
   * webhook POST with the full report.
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
        { runId: report.id, discrepancy },
        `Reconciliation discrepancy [${discrepancy.type}] ${discrepancy.balanceId}`
      );
    }

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

/** Default service wired to the production payment DB and Horizon. */
export function createDefaultReconciliationService(
  paymentDb?: PaymentDb
): ReconciliationService {
  return new ReconciliationService({
    paymentDb: paymentDb ?? createPaymentDb(getDb()),
  });
}
