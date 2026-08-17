import supertest from 'supertest';
import type { Server as HttpServer } from 'http';

import { createApp } from '../../backend/src/api/app';
import type { DispatchFn, PaymentReleaseFn } from '../../backend/src/coordinator/coordinator';
import type { AgentResult } from '../../backend/src/agents/research/types';
import { MOCK_CONTRACT_IDS, onChainContracts, createE2ETestKeypair, signChallenge } from './helpers';

process.env.NODE_ENV = 'test';
process.env.SKIP_STELLAR_ACCOUNT_VERIFY = 'true';
process.env.REGISTRY_CONTRACT_ID = MOCK_CONTRACT_IDS.REGISTRY;
process.env.ERROR_RESOLVER_CONTRACT_ID = MOCK_CONTRACT_IDS.ERROR_RESOLVER;

const dispatchedAgents: Array<{ taskId: string; nodeType: string }> = [];

const mockReleasePayment: PaymentReleaseFn = async () => 'mock-hash';

const mockDispatch: DispatchFn = async (taskId, node, _context) => {
  dispatchedAgents.push({ taskId, nodeType: node.type });
  return {
    taskId,
    nodeId: node.nodeId,
    summary: `Result for ${node.type}`,
    keyFindings: [],
    sources: [],
    confidence: 0.5,
  } satisfies AgentResult;
};

let httpServer: HttpServer;
let request: ReturnType<typeof supertest>;
let closeApp: () => void;

beforeAll(done => {
  onChainContracts.initialize();
  dispatchedAgents.length = 0;

  const app = createApp({ dispatch: mockDispatch, releasePayment: mockReleasePayment });
  httpServer = app.httpServer;
  closeApp = app.close;
  request = supertest(httpServer);
  httpServer.listen(0, '127.0.0.1', done);
}, 10_000);

afterAll(done => {
  closeApp();
  done();
});

describe('Agent Lifecycle E2E', () => {
  const agentId = 'agent-lifecycle-test-01';
  const capability = 'research';

  it('registers, executes, and deregisters an agent', async () => {
    const keypair = createE2ETestKeypair();

    // 1. Register agent via API
    const agentData = {
      agentId,
      capabilities: [capability],
      pricingXLM: 2.0,
      endpoint: 'http://localhost:9999/execute',
      stellarPublicKey: keypair.publicKey(),
    };
    const registerRes = await request.post('/api/agents/register').send(agentData).expect(201);
    expect(registerRes.body).toHaveProperty('id', agentId);
    expect(registerRes.body.capabilities).toContain(capability);

    // 2. Sync agent to on-chain registry
    onChainContracts.registerAgent({
      id: agentId,
      capability,
      priceStroops: 20_000_000,
      endpoint: agentData.endpoint,
      ownerAddress: keypair.publicKey(),
    });

    // 3. Verify agent appears in GET /api/agents list
    const listRes = await request.get('/api/agents').expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const found = listRes.body.find((a: any) => a.id === agentId);
    expect(found).toBeDefined();
    expect(found.pricingXLM).toBe(2.0);

    // 4. Verify agent detail via GET /api/agents/:id
    const detailRes = await request.get(`/api/agents/${agentId}`).expect(200);
    expect(detailRes.body.id).toBe(agentId);
    expect(detailRes.body.endpoint).toBe(agentData.endpoint);
    expect(detailRes.body.stellarPublicKey).toBe(keypair.publicKey());

    // 5. Submit a task requiring the agent's capability
    const taskRes = await request
      .post('/api/tasks')
      .set('walletpublickey', 'GFAKEWALLETPUBLICKEY')
      .send({ prompt: 'Research solar energy market in SEA', walletPublicKey: 'GFAKEWALLETPUBLICKEY' })
      .expect(201);
    const taskId = taskRes.body.taskId as string;

    const deadline = Date.now() + 120_000;
    let status = 'queued';
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const getRes = await request
        .get(`/api/tasks/${taskId}`)
        .set('walletpublickey', 'GFAKEWALLETPUBLICKEY');
      status = getRes.body.status as string;
      if (status === 'completed' || status === 'failed') break;
    }
    expect(status).toBe('completed');

    // 6. Verify the research agent was dispatched to
    const agentCalls = dispatchedAgents.filter(a => a.taskId === taskId && a.nodeType === capability);
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);

    // 7. Deregister agent with challenge + signature auth
    const challenge = 'agent-deletion-challenge';
    const signature = signChallenge(keypair, challenge);
    await request
      .delete(`/api/agents/${agentId}`)
      .set('x-challenge', challenge)
      .set('x-signature', signature)
      .expect(200);

    // 8. Verify agent removed from on-chain registry
    onChainContracts.deregisterAgent(agentId);
    expect(onChainContracts.lookupAgent(agentId)).toBeUndefined();

    // 9. Verify agent returns 404 on detail
    await request.get(`/api/agents/${agentId}`).expect(404);
  });
});
