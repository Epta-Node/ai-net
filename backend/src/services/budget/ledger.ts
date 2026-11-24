/**
 * Per-task token budget ledger (Issue #390).
 *
 * The review comment on the issue makes the requirement explicit: a cost
 * tracker that only reports *after* the fact is a postmortem dashboard, not
 * control. So the ledger is an enforcement point — every LLM call reserves
 * against it before going upstream, and a task that runs out of budget is
 * halted rather than allowed to keep spending.
 *
 * One ledger per taskId, held in memory for the duration of the run and
 * snapshotted to SQLite at task completion (see `db/taskUsage.ts`).
 */

import { computeCostUsd } from './pricing.js';
import { estimateTokens, trimToTokenBudget } from './tokens.js';

/** Token usage for a single LLM call. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** One accounted LLM call, as reported to the Venice client. */
export interface UsageRecord extends LlmUsage {
  model: string;
  costUsd: number;
  /** Set when the prompt was trimmed to fit the remaining budget. */
  trimmed: boolean;
  /** Prompt tokens that were dropped by trimming. */
  tokensSaved: number;
}

/** One node's (and one agent's) rollup within a task. */
export interface AgentUsageEntry {
  nodeId: string;
  agentId: string;
  agentType: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** True when at least one prompt for this node was trimmed to fit. */
  trimmed: boolean;
  /** True once this node tripped the task budget. */
  budgetExhausted: boolean;
}

export interface TaskCostSnapshot {
  taskId: string;
  walletPublicKey: string;
  budgetTokens: number;
  usedTokens: number;
  remainingTokens: number;
  costUsd: number;
  currency: 'USD';
  exceeded: boolean;
  calls: number;
  agents: AgentUsageEntry[];
  createdAt: string;
}

export interface BudgetLimits {
  /** Total tokens (input + output) a single task may consume. */
  maxTokensPerTask: number;
  /** Hard ceiling on a single call's `max_tokens`. */
  maxTokensPerCall: number;
  /** Hard ceiling on a single call's input prompt. */
  maxPromptTokens: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxTokensPerTask: 200_000,
  maxTokensPerCall: 8_192,
  maxPromptTokens: 16_000,
};

function now(): string {
  return new Date().toISOString();
}

/**
 * Raised when a task has no budget left. The coordinator turns this into a
 * `budget_exhausted` node failure so the run halts *gracefully* — the task is
 * marked failed with a clear reason rather than blowing through the cap or
 * dying on an unhandled rejection.
 */
export class BudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED';
  constructor(taskId: string, usedTokens: number, budgetTokens: number) {
    super(
      `Token budget exhausted for task ${taskId}: ${usedTokens}/${budgetTokens} tokens used`
    );
    this.name = 'BudgetExhaustedError';
  }
}

interface LedgerState {
  taskId: string;
  walletPublicKey: string;
  limits: BudgetLimits;
  usedTokens: number;
  costUsd: number;
  calls: number;
  createdAt: string;
  entries: Map<string, AgentUsageEntry>;
  /**
   * Tokens earmarked for calls that are in flight but not yet reported.
   *
   * Without this, `allowanceFor()` hands the *entire* remainder to every node,
   * and a DAG running four nodes concurrently can authorise four times the
   * budget. Reservations are taken and released synchronously, so the
   * reservation itself needs no lock even though the calls it covers overlap.
   */
  reservedTokens: number;
  /** Reservation currently held per node id, so it can be settled or released. */
  reservations: Map<string, number>;
}

/**
 * Accounting + enforcement for one task.
 *
 * Node ids are the map key, so concurrent nodes of the same task (the DAG runs
 * up to `concurrency` at a time) never clobber each other's counters. Node ids
 * are unique within a DAG, which is all the isolation we need.
 */
export class TaskBudgetLedger {
  private readonly state: LedgerState;

  constructor(taskId: string, options: {
    walletPublicKey?: string;
    limits?: Partial<BudgetLimits>;
  } = {}) {
    this.state = {
      taskId,
      walletPublicKey: options.walletPublicKey ?? '',
      limits: { ...DEFAULT_BUDGET_LIMITS, ...options.limits },
      usedTokens: 0,
      costUsd: 0,
      calls: 0,
      createdAt: now(),
      entries: new Map(),
      reservedTokens: 0,
      reservations: new Map(),
    };
  }

  get taskId(): string {
    return this.state.taskId;
  }

  get limits(): BudgetLimits {
    return this.state.limits;
  }

  get usedTokens(): number {
    return this.state.usedTokens;
  }

  get remainingTokens(): number {
    return Math.max(0, this.state.limits.maxTokensPerTask - this.state.usedTokens);
  }

  /**
   * Tokens still unspent *and* unclaimed: the remainder minus what in-flight
   * calls have reserved. This — not {@link remainingTokens} — is what a new
   * call may be authorised for.
   */
  get availableTokens(): number {
    return Math.max(0, this.remainingTokens - this.state.reservedTokens);
  }

  get costUsd(): number {
    return this.state.costUsd;
  }

  /**
   * True once the task has consumed its whole budget.
   *
   * Reserved-but-unreported tokens count as spent: the provider call is already
   * out the door, so treating them as available would let the same tokens be
   * authorised twice.
   */
  get exhausted(): boolean {
    return this.availableTokens <= 0;
  }

  /**
   * Tokens a single call may still request, respecting the task remainder, the
   * per-call ceiling, and the per-call prompt ceiling.
   *
   * Callers that are about to spend should prefer {@link reserve}, which also
   * debits the amount. This getter is for sizing a request without committing
   * to it.
   */
  allowanceFor(): number {
    return Math.min(this.availableTokens, this.state.limits.maxTokensPerCall);
  }

  /**
   * Claim up to `requested` tokens for a call that is about to be made.
   *
   * The granted amount is debited from the available pool immediately, so
   * concurrent nodes cannot each authorise the same remaining tokens. Always
   * follow this with {@link record} (which settles the reservation against real
   * usage) or {@link release} (for a call that never happened).
   *
   * Returns 0 when the task is out of budget; the caller should fail the node
   * with a `BudgetExhaustedError` rather than dispatching a zero-token call.
   */
  reserve(nodeId: string, requested: number): number {
    const want = Math.max(0, Math.floor(requested));
    const granted = Math.min(
      want,
      this.availableTokens,
      this.state.limits.maxTokensPerCall,
      this.state.limits.maxTokensPerTask,
    );
    if (granted > 0) {
      this.state.reservedTokens += granted;
      // A node holds at most one reservation at a time; take the max so a
      // double-reserve cannot shrink the amount already held.
      this.state.reservations.set(
        nodeId,
        Math.max(this.state.reservations.get(nodeId) ?? 0, granted),
      );
    }
    return granted;
  }

  /** Give back a node's reservation without recording usage. */
  release(nodeId: string): void {
    const held = this.state.reservations.get(nodeId);
    if (held === undefined) return;
    this.state.reservations.delete(nodeId);
    this.state.reservedTokens = Math.max(0, this.state.reservedTokens - held);
  }

  /**
   * How many calls have been recorded against a node.
   *
   * Lets a caller tell "the node dispatched but nothing was accounted" (a
   * `dispatchOverride`, or an agent that reports no usage) from "the node ran
   * and its reservation is already settled", without having to keep its own
   * bookkeeping in step with the ledger.
   */
  usageCallsFor(nodeId: string): number {
    return this.state.entries.get(nodeId)?.calls ?? 0;
  }

  /**
   * Trim a prompt to what this node can afford, so a huge upstream context is
   * cut down *before* the request goes out instead of after the bill arrives.
   *
   * Returns the (possibly shortened) prompt and whether anything was cut.
   */
  preparePrompt(
    nodeId: string,
    agentId: string,
    agentType: string,
    prompt: string
  ): { prompt: string; trimmed: boolean; tokensSaved: number } {
    const entry = this.entryFor(nodeId, agentId, agentType, undefined);
    // Leave room for the completion: a prompt that consumes the entire
    // allowance guarantees an empty or truncated answer. Reserve is not
    // deducted here — the caller's `reserve()` already holds the completion
    // side, so this only sizes the prompt.
    const promptCeiling = Math.min(
      this.state.limits.maxPromptTokens,
      Math.max(1, this.allowanceFor() - Math.floor(this.allowanceFor() * 0.25))
    );

    const originalTokens = estimateTokens(prompt);
    const trimmedPrompt =
      originalTokens <= promptCeiling ? prompt : trimToTokenBudget(prompt, promptCeiling);
    const tokensSaved = originalTokens - estimateTokens(trimmedPrompt);
    this.lastTrimmedTokens = tokensSaved;

    if (tokensSaved > 0) {
      entry.trimmed = true;
    }
    return { prompt: trimmedPrompt, trimmed: tokensSaved > 0, tokensSaved };
  }

  /**
   * Throw if the task has no budget left.
   *
   * Called by the coordinator before dispatching a node so a DAG halts at the
   * node boundary with a clear reason instead of discovering the overrun in a
   * provider error.
   */
  assertCanSpend(): void {
    if (this.exhausted) {
      throw new BudgetExhaustedError(
        this.state.taskId,
        this.state.usedTokens,
        this.state.limits.maxTokensPerTask
      );
    }
  }

  /**
   * Record actual usage returned by the provider.
   *
   * `usage` is optional because cache hits and stale-cache fallbacks do not
   * produce provider usage; in that case we fall back to estimating from the
   * prompt, which is how the burn still gets counted. Under-counting a cache
   * hit is correct — a cache hit genuinely costs (almost) nothing upstream.
   */
  record(nodeId: string, params: {
    agentId: string;
    agentType: string;
    model: string;
    usage?: LlmUsage;
    prompt?: string;
    completion?: string;
  }): UsageRecord {
    // Settle the reservation first: the real usage is now known, so the
    // earmarked tokens convert from "pending" to "spent". Actual usage may
    // exceed the grant (the provider had the last word), and that overrun is
    // recorded honestly rather than clamped away.
    this.release(nodeId);

    const promptTokens = params.usage?.promptTokens ?? estimateTokens(params.prompt ?? '');
    const completionTokens =
      params.usage?.completionTokens ?? estimateTokens(params.completion ?? '');
    const totalTokens = params.usage?.totalTokens ?? promptTokens + completionTokens;
    const costUsd = computeCostUsd(params.model, promptTokens, completionTokens);

    this.state.usedTokens += totalTokens;
    this.state.costUsd = round6(this.state.costUsd + costUsd);
    this.state.calls += 1;

    const entry = this.entryFor(nodeId, params.agentId, params.agentType, params.model);
    entry.calls += 1;
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.totalTokens += totalTokens;
    entry.costUsd = round6(entry.costUsd + costUsd);
    entry.trimmed = entry.trimmed || this.lastTrimmedTokens > 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      model: params.model,
      costUsd,
      trimmed: entry.trimmed,
      tokensSaved: this.lastTrimmedTokens,
    };
  }

  /** Tokens dropped by the most recent {@link preparePrompt} on this ledger. */
  private lastTrimmedTokens = 0;

  /**
   * Mark a node as the one that exhausted the budget. Surfaced in the cost
   * breakdown so an operator can see *which* step overran rather than just
   * that the task did.
   */
  markExhausted(nodeId: string, agentId: string, agentType: string): void {
    this.entryFor(nodeId, agentId, agentType, undefined).budgetExhausted = true;
  }

  /** Per-agent rollup, ordered by cost descending — the shape the API returns. */
  agents(): AgentUsageEntry[] {
    return [...this.state.entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => b.costUsd - a.costUsd);
  }

  /** Immutable billing snapshot, suitable for persistence and the API. */
  snapshot(): TaskCostSnapshot {
    return {
      taskId: this.state.taskId,
      walletPublicKey: this.state.walletPublicKey,
      budgetTokens: this.state.limits.maxTokensPerTask,
      usedTokens: this.state.usedTokens,
      remainingTokens: this.remainingTokens,
      costUsd: this.state.costUsd,
      currency: 'USD',
      // Over budget means actual usage passed the cap, which can only happen if
      // a call overran its reservation. Reservations keep the *authorised* spend
      // under the cap; they cannot un-spend tokens the provider already billed.
      exceeded: this.state.usedTokens > this.state.limits.maxTokensPerTask,
      calls: this.state.calls,
      agents: this.agents(),
      createdAt: this.state.createdAt,
    };
  }

  private entryFor(
    nodeId: string,
    agentId: string,
    agentType: string,
    model: string | undefined
  ): AgentUsageEntry {
    let entry = this.state.entries.get(nodeId);
    if (!entry) {
      entry = {
        nodeId,
        agentId,
        agentType,
        model: model ?? '',
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        trimmed: false,
        budgetExhausted: false,
      };
      this.state.entries.set(nodeId, entry);
    } else {
      if (agentId) entry.agentId = agentId;
      if (agentType) entry.agentType = agentType;
      if (model) entry.model = model;
    }
    return entry;
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Process-wide registry of active ledgers.
 *
 * Keyed by taskId, with a bounded size so a long-lived process that never
 * reaps finished tasks cannot leak memory. Eviction is LRU-by-insertion which
 * is adequate here: a task's ledger only matters while it is running.
 */
const MAX_TRACKED_TASKS = 1_000;
const ledgers = new Map<string, TaskBudgetLedger>();

/** Get (or lazily create) the ledger for a task. */
export function getLedger(
  taskId: string,
  options: { walletPublicKey?: string; limits?: Partial<BudgetLimits> } = {}
): TaskBudgetLedger {
  const existing = ledgers.get(taskId);
  if (existing) return existing;

  const ledger = new TaskBudgetLedger(taskId, options);
  if (ledgers.size >= MAX_TRACKED_TASKS) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    const oldest = ledgers.keys().next();
    if (!oldest.done) ledgers.delete(oldest.value);
  }
  ledgers.set(taskId, ledger);
  return ledger;
}

/** Peek at an existing ledger without creating one. */
export function peekLedger(taskId: string): TaskBudgetLedger | undefined {
  return ledgers.get(taskId);
}

/** Snapshot + forget a task's ledger, after persisting the snapshot. */
export function takeLedgerSnapshot(taskId: string): TaskCostSnapshot | undefined {
  const ledger = ledgers.get(taskId);
  if (!ledger) return undefined;
  ledgers.delete(taskId);
  return ledger.snapshot();
}

/** Drop a ledger without snapshotting (used when a task is cancelled). */
export function dropLedger(taskId: string): void {
  ledgers.delete(taskId);
}

/** Every active ledger snapshot. Backs the stats endpoint. */
export function activeSnapshots(): TaskCostSnapshot[] {
  return [...ledgers.values()].map((ledger) => ledger.snapshot());
}

/** Test hook: clear all tracked ledgers. */
export function resetLedgers(): void {
  ledgers.clear();
}
