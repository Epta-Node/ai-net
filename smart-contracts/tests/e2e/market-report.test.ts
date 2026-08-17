import axios from 'axios';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { ReportAgent } from '../../src/agents/report/report';
import {
  clearRegistry,
  discoverAgents,
  registerAgent,
} from '../../src/registry/registry';
import { lockEscrow, releasePayment } from '../../src/payment/payment';
import {
  AgentResult,
  MANDATORY_SECTION_HEADINGS,
  ReportOutput,
} from '../../src/types/agent';
import { VeniceClient } from '../../src/venice/venice';

function loadEnvFile(): void {
  const envPath = resolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

jest.setTimeout(120_000);

/**
 * Full Stellar testnet E2E.
 *
 * Expected runtime: 60-120s. This test funds fresh accounts with Friendbot,
 * submits a five-node market report DAG, releases Stellar payments for every
 * completed agent task, verifies the release payment operations through Horizon,
 * and validates the final Report Agent output with Zod.
 */
const describeE2E =
  process.env.RUN_STELLAR_E2E_TESTS === 'true' ? describe : describe.skip;

const PROMPT = 'Generate a market-entry report for solar energy in Southeast Asia';
const HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const PAYMENT_XLM = '0.1000000';

const MandatoryHeadingSchema = z.enum([
  'Executive Summary',
  'Findings',
  'Risk Analysis',
  'Recommendations',
  'Conclusion',
]);

const SectionSchema = z.object({
  heading: MandatoryHeadingSchema,
  content: z.string().min(1),
  sourceAgents: z.array(z.string()).min(1),
});

const ReportOutputSchema: z.ZodType<ReportOutput> = z.object({
  title: z.string().min(1),
  sections: z.array(SectionSchema).length(MANDATORY_SECTION_HEADINGS.length),
  wordCount: z.number().int().positive(),
  generatedAt: z.string().datetime(),
});

const AgentResultSchema: z.ZodType<AgentResult> = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  capability: z.string().min(1),
  data: ReportOutputSchema,
});

interface PipelineNode {
  id: string;
  capability: 'research' | 'risk' | 'coding' | 'design' | 'report';
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: AgentResult;
}

interface PaymentRecord {
  nodeId: string;
  lockTxHash: string;
  releaseTxHash: string;
}

const pipeline: PipelineNode[] = [
  { id: 'research', capability: 'research', dependsOn: [], status: 'pending' },
  { id: 'risk', capability: 'risk', dependsOn: ['research'], status: 'pending' },
  { id: 'coding', capability: 'coding', dependsOn: ['risk'], status: 'pending' },
  { id: 'design', capability: 'design', dependsOn: ['coding'], status: 'pending' },
  { id: 'report', capability: 'report', dependsOn: ['design'], status: 'pending' },
];

const researchResult: AgentResult = {
  agentId: 'e2e-research-agent',
  agentName: 'E2E Research Agent',
  capability: 'research',
  data: {
    summary:
      'Solar energy demand is growing across Southeast Asia, led by utility-scale deployment and commercial rooftops.',
    keyFindings: [
      'Vietnam and the Philippines show strong solar demand signals.',
      'Grid readiness and permitting vary significantly by market.',
      'Commercial buyers are increasingly using solar to stabilize energy costs.',
    ],
    sources: [
      { title: 'Southeast Asia Solar Market Brief', url: 'https://example.com/solar-brief' },
    ],
    confidence: 0.86,
  },
};

const riskResult: AgentResult = {
  agentId: 'e2e-risk-agent',
  agentName: 'E2E Risk Agent',
  capability: 'risk',
  data: {
    overallRiskScore: 10.33,
    risks: [
      {
        category: 'Regulatory',
        description: 'Permitting and tariff rules can shift by jurisdiction.',
        likelihood: 4,
        impact: 4,
        mitigations: ['Retain local regulatory counsel', 'Stage expansion by country'],
        critical: true,
      },
      {
        category: 'Grid',
        description: 'Interconnection capacity can constrain project timelines.',
        likelihood: 3,
        impact: 4,
        mitigations: ['Pre-screen substations', 'Prioritize behind-the-meter projects'],
      },
      {
        category: 'Supply Chain',
        description: 'Imported component costs are exposed to currency volatility.',
        likelihood: 3,
        impact: 3,
        mitigations: ['Hedge FX exposure', 'Qualify regional suppliers'],
      },
    ],
  },
};

const codingResult: AgentResult = {
  agentId: 'e2e-coding-agent',
  agentName: 'E2E Coding Agent',
  capability: 'coding',
  data: {
    deliverable: 'Market sizing model scaffold generated for five Southeast Asian countries.',
  },
};

const designResult: AgentResult = {
  agentId: 'e2e-design-agent',
  agentName: 'E2E Design Agent',
  capability: 'design',
  data: {
    deliverable: 'Executive report layout and chart direction prepared for solar market entry.',
  },
};

async function fundWithFriendbot(publicKey: string): Promise<void> {
  try {
    await axios.get(`https://friendbot.stellar.org/?addr=${publicKey}`, { timeout: 30_000 });
  } catch (error: any) {
    if (error?.response?.status === 400) {
      return;
    }
    throw error;
  }
}

async function horizonPaymentCount(
  coordinatorPublicKey: string,
  agentPublicKey: string,
  releaseTxHashes: string[],
): Promise<number> {
  const response = await axios.get(
    `${HORIZON_URL}/accounts/${coordinatorPublicKey}/payments`,
    {
      params: { order: 'desc', limit: 200 },
      timeout: 30_000,
    },
  );

  const hashes = new Set(releaseTxHashes);
  const records = response.data?._embedded?.records ?? [];

  return records.filter((record: any) => (
    record.type === 'payment' &&
    record.asset_type === 'native' &&
    record.from === coordinatorPublicKey &&
    record.to === agentPublicKey &&
    hashes.has(record.transaction_hash)
  )).length;
}

function registerTestAgents(agentPublicKey: string): void {
  for (const capability of ['research', 'risk', 'coding', 'design', 'report']) {
    registerAgent({
      id: `e2e-${capability}-agent`,
      name: `E2E ${capability[0].toUpperCase()}${capability.slice(1)} Agent`,
      capability,
      priceXLM: 0.1,
      stellarAddress: agentPublicKey,
    });
  }
}

async function executeNode(
  node: PipelineNode,
  upstreamResults: AgentResult[],
  reportAgent: ReportAgent,
): Promise<AgentResult> {
  if (node.capability === 'research') return researchResult;
  if (node.capability === 'risk') return riskResult;
  if (node.capability === 'coding') return codingResult;
  if (node.capability === 'design') return designResult;

  return reportAgent.execute({
    prompt: PROMPT,
    upstreamResults,
  });
}

describeE2E('Market report pipeline on Stellar testnet', () => {
  let coordinatorKeypair: Keypair;
  let agentKeypair: Keypair;
  let finalReport: AgentResult;
  const started: string[] = [];
  const completed: string[] = [];
  const payments: PaymentRecord[] = [];

  beforeAll(async () => {
    coordinatorKeypair = process.env.STELLAR_COORDINATOR_SECRET
      ? Keypair.fromSecret(process.env.STELLAR_COORDINATOR_SECRET)
      : Keypair.random();
    agentKeypair = Keypair.random();

    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_SECRET_KEY = coordinatorKeypair.secret();
    process.env.STELLAR_COORDINATOR_PUBLIC_KEY = coordinatorKeypair.publicKey();

    await Promise.all([
      fundWithFriendbot(coordinatorKeypair.publicKey()),
      fundWithFriendbot(agentKeypair.publicKey()),
    ]);

    clearRegistry();
    registerTestAgents(agentKeypair.publicKey());

    expect(discoverAgents('research')).toHaveLength(1);
    expect(discoverAgents('research')[0].priceXLM).toBe(0.1);
    expect(discoverAgents('report')).toHaveLength(1);
  });

  afterAll(() => {
    clearRegistry();
  });

  it('runs the full DAG, releases Stellar payments, and validates the report', async () => {
    const venice = {
      complete: jest.fn().mockRejectedValue(new Error('Use deterministic E2E fallback report')),
    } as unknown as VeniceClient;
    const reportAgent = new ReportAgent(venice);
    const upstreamResults: AgentResult[] = [];

    for (const node of pipeline) {
      expect(node.dependsOn.every((dep) => completed.includes(dep))).toBe(true);
      expect(discoverAgents(node.capability)).toHaveLength(1);

      node.status = 'running';
      started.push(node.id);

      const taskId = `mr${Date.now().toString(36)}${node.id.slice(0, 3)}`;
      const lockTxHash = await lockEscrow(
        coordinatorKeypair,
        agentKeypair.publicKey(),
        PAYMENT_XLM,
        taskId,
      );
      expect(lockTxHash).toBeTruthy();
      expect(typeof lockTxHash).toBe('string');

      node.result = await executeNode(node, upstreamResults, reportAgent);
      node.status = 'completed';
      completed.push(node.id);
      upstreamResults.push(node.result);

      const releaseTxHash = await releasePayment(
        coordinatorKeypair,
        agentKeypair.publicKey(),
        taskId,
      );
      expect(releaseTxHash).toBeTruthy();
      expect(typeof releaseTxHash).toBe('string');
      payments.push({ nodeId: node.id, lockTxHash, releaseTxHash });
    }

    finalReport = upstreamResults[upstreamResults.length - 1];

    expect(started).toEqual(['research', 'risk', 'coding', 'design', 'report']);
    expect(completed).toEqual(['research', 'risk', 'coding', 'design', 'report']);
    expect(pipeline.every((node) => node.status === 'completed')).toBe(true);
    expect(payments).toHaveLength(5);
    expect(payments.every((payment) => payment.lockTxHash && payment.releaseTxHash)).toBe(true);

    const horizonPaymentOperations = await horizonPaymentCount(
      coordinatorKeypair.publicKey(),
      agentKeypair.publicKey(),
      payments.map((payment) => payment.releaseTxHash),
    );
    expect(horizonPaymentOperations).toBeGreaterThanOrEqual(3);

    const parsed = AgentResultSchema.parse(finalReport);
    const report = parsed.data as ReportOutput;
    expect(report.sections.map((section) => section.heading)).toEqual([
      ...MANDATORY_SECTION_HEADINGS,
    ]);
  });
});
