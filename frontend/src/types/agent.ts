export type Capability = 'research' | 'report' | 'coding' | 'risk' | 'design';

export interface Source {
  url: string;
  title: string;
}

export interface ResearchResult {
  taskId?: string;
  nodeId?: string;
  summary?: string;
  keyFindings?: string[];
  sources?: Source[];
  confidence?: number;
  markdown?: string;
  content?: string;
}

export type ResearchReportResult = string | ResearchResult;

export interface CodingResultObj {
  code: string;
  language?: string;
}

export type CodingResult = string | CodingResultObj;

export interface RiskItem {
  likelihood: number; // 1-5
  impact: number; // 1-5
  description: string;
  mitigations: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface RiskResultObj {
  risks: RiskItem[];
}

export type RiskResult = RiskItem[] | RiskResultObj;

export interface DesignColor {
  name?: string;
  hex?: string;
  value?: string;
}

export interface ComponentNode {
  name: string;
  children?: ComponentNode[];
}

export interface DesignImage {
  url?: string;
  src?: string;
  image?: string;
  name?: string;
  title?: string;
  alt?: string;
  description?: string;
  type?: string;
}

export interface DesignResultObj {
  colors?: string[] | DesignColor[];
  palette?: string[] | DesignColor[];
  components?: ComponentNode;
  hierarchy?: ComponentNode;
  images?: string[] | DesignImage[];
  mockups?: string[] | DesignImage[];
  wireframes?: string[] | DesignImage[];
}

export type DesignResult = DesignResultObj;

export type AgentResult =
  | ResearchReportResult
  | CodingResult
  | RiskResult
  | DesignResult
  | null
  | undefined;
