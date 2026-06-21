/**
 * Shared type definitions for ai-net smart-contracts layer.
 */

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
  endpoint?: string;
}

export interface RegistryEvent {
  type: 'registered' | 'deregistered' | 'pricingUpdated';
  agentId: string;
  timestamp: string;
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
  generatedAt: string; // ISO8601
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
