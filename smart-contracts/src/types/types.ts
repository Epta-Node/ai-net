/**
 * Shared type definitions for the ai-net smart-contracts layer.
 *
 * Canonical agent types (SubTask, AgentResult, Agent, etc.) live in
 * src/types/agent.ts — this file holds domain types referenced across
 * multiple modules, plus the composite index types added in issue #256.
 */

export * from './agent';

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export type Capability =
  | 'research'
  | 'risk'
  | 'coding'
  | 'design'
  | 'report'
  | string; // allow extension

export interface AgentRecord {
  id: string;
  name: string;
  capability: Capability;
  priceXLM: number;
  stellarAddress: string;
  /** Optional HTTP(S) endpoint for direct invocation */
  endpoint?: string;
  /**
   * Reputation score in [0, 1].
   * Defaults to 1 for newly-registered agents and updated by the coordinator
   * after each successful/failed task.
   */
  reputationScore: number;
  /** Additional capabilities an agent supports (multi-capability agents) */
  extraCapabilities?: Capability[];
}

export interface RegistryEvent {
  type: 'registered' | 'deregistered' | 'pricingUpdated';
  agentId: string;
  timestamp: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Composite index types  (issue #256)
// ---------------------------------------------------------------------------

/**
 * A single entry in the composite capability index.
 *
 * The index is keyed by capability and each entry stores the three
 * dimensions used for multi-criteria filtering and scoring:
 *   price      → lower is better
 *   reputation → higher is better
 *   agentId    → ties back to the full AgentRecord in the main store
 *
 * Composite score = reputationScore / (priceXLM + ε)
 * Higher composite score = cheaper AND more reputable → sorted descending.
 */
export interface CompositeIndexEntry {
  agentId: string;
  priceXLM: number;
  reputationScore: number; // [0, 1]
  /** Pre-computed composite score for fast sorting */
  compositeScore: number;
}

/**
 * The full composite index: capability → sorted array of CompositeIndexEntry.
 * Sorted descending by compositeScore so the best agent is always at index 0.
 */
export type CompositeIndex = Map<Capability, CompositeIndexEntry[]>;

/**
 * Filter parameters for lookupAgentsComposite().
 */
export interface CompositeQueryFilter {
  capability: Capability;
  /** Agents with priceXLM > maxPrice are excluded (inclusive upper-bound) */
  maxPrice?: number;
  /** Agents with reputationScore < minReputation are excluded (inclusive lower-bound) */
  minReputation?: number;
  /** Maximum number of results to return (default: 100) */
  limit?: number;
}

/**
 * A result row returned by lookupAgentsComposite().
 */
export interface CompositeQueryResult {
  agent: AgentRecord;
  compositeScore: number;
}

// ---------------------------------------------------------------------------
// Task / DAG types
// ---------------------------------------------------------------------------

export interface TaskOptions {
  includeTests?: boolean;
  [key: string]: unknown;
}

export interface SubTask {
  id: string;
  description: string;
  options?: TaskOptions;
  context?: AgentResult[];
}

export type DAGNodeStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface DAGNode {
  id: string;
  taskType: Capability;
  dependsOn: string[];
  assignedAgent?: AgentRecord;
  status: DAGNodeStatus;
  result?: AgentResult;
}

// ---------------------------------------------------------------------------
// Agent result types
// ---------------------------------------------------------------------------

export interface Source {
  title: string;
  url?: string;
  excerpt?: string;
}

export interface AgentResult {
  summary: string;
  keyFindings: string[];
  sources: Source[];
  confidence: number; // 0–1
}

// ---------------------------------------------------------------------------
// Coding agent output
// ---------------------------------------------------------------------------

export interface CodingOutput {
  language: string;
  code: string;
  explanation: string;
  testScaffold?: string;
}

// ---------------------------------------------------------------------------
// Risk agent output
// ---------------------------------------------------------------------------

export interface RiskItem {
  category: string;
  description: string;
  likelihood: number; // 1–5
  impact: number; // 1–5
  mitigations: string[];
  critical?: boolean;
}

export interface RiskOutput {
  risks: RiskItem[];
  overallRiskScore: number;
}

// ---------------------------------------------------------------------------
// Report agent output
// ---------------------------------------------------------------------------

export interface Section {
  heading: string;
  content: string;
  sourceAgents: string[];
}

export interface ReportOutput {
  title: string;
  sections: Section[];
  wordCount: number;
  generatedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Design agent output
// ---------------------------------------------------------------------------

export interface UIElement {
  type: string;
  label: string;
}

export interface WireframeSection {
  name: string;
  description: string;
  layout: 'grid' | 'flex' | 'absolute';
  elements: UIElement[];
}

export interface ColorToken {
  name: string;
  hex: string;
  usage: string;
}

export interface ComponentNode {
  id: string;
  name: string;
  parentId?: string;
  children?: ComponentNode[];
}

export interface AssetEntry {
  name: string;
  type: 'icon' | 'image' | 'font';
  description: string;
  suggestedSource: string;
}

export interface DesignOutput {
  wireframes: WireframeSection[];
  colorPalette: ColorToken[];
  componentHierarchy: ComponentNode[];
  assetManifest: AssetEntry[];
}

// ---------------------------------------------------------------------------
// Agent interface
// ---------------------------------------------------------------------------

export interface Agent {
  execute(task: SubTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
  start(): Promise<void>;
}
