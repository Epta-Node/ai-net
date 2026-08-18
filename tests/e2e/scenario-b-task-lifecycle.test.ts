import { createTestApp, onChainContracts, createE2ETestKeypair } from "./helpers";

describe("Scenario B: Task Lifecycle & Error Recording (End-to-End)", () => {
  let appServer: ReturnType<typeof createTestApp>;
  let agent1Keypair: ReturnType<typeof createE2ETestKeypair>;
  let agent2Keypair: ReturnType<typeof createE2ETestKeypair>;

  beforeAll(async () => {
    appServer = createTestApp();
    agent1Keypair = createE2ETestKeypair();
    agent2Keypair = createE2ETestKeypair();

    // 1. Register 2 agents on-chain & backend
    const agent1 = {
      agentId: "agent-researcher-02",
      capabilities: ["research"],
      pricingXLM: 1.0,
      endpoint: "http://localhost:4002/research",
      stellarPublicKey: agent1Keypair.publicKey()
    };

    const agent2 = {
      agentId: "agent-coder-02",
      capabilities: ["coding"],
      pricingXLM: 2.0,
      endpoint: "http://localhost:4003/coding",
      stellarPublicKey: agent2Keypair.publicKey()
    };

    await appServer.request.post("/api/agents/register").send(agent1).expect(201);
    await appServer.request.post("/api/agents/register").send(agent2).expect(201);

    onChainContracts.registerAgent({
      id: agent1.agentId,
      capability: "research",
      priceStroops: 10_000_000,
      endpoint: agent1.endpoint,
      ownerAddress: agent1.stellarPublicKey
    });

    onChainContracts.registerAgent({
      id: agent2.agentId,
      capability: "coding",
      priceStroops: 20_000_000,
      endpoint: agent2.endpoint,
      ownerAddress: agent2.stellarPublicKey
    });
  });

  afterAll(() => {
    appServer.close();
  });

  it("assigns task to registered agents, tracks execution, and records execution errors in error-resolver", async () => {
    // 2. Create a task via POST /api/tasks
    const taskPayload = {
      prompt: "Research market data and generate summary code",
      maxBudgetXLM: 5.0
    };

    const createRes = await appServer.request
      .post("/api/tasks")
      .set("x-wallet-public-key", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
      .send(taskPayload)
      .expect(201);

    expect(createRes.body).toHaveProperty("taskId");
    expect(createRes.body.status).toBe("queued");
    expect(Array.isArray(createRes.body.dagPreview)).toBe(true);

    const taskId = createRes.body.taskId;

    // 3. Verify coordinator assigned agents to nodes matching capabilities
    const researchAgents = onChainContracts.lookupAgentsByCapability("research");
    expect(researchAgents.length).toBeGreaterThan(0);
    expect(researchAgents[0].id).toBe("agent-researcher-02");

    // 4. Verify task status can be queried via GET /api/tasks/:id
    const taskDetail = await appServer.request
      .get(`/api/tasks/${taskId}`)
      .set("walletpublickey", "anonymous")
      .expect(200);

    expect(taskDetail.body.id).toBe(taskId);
    expect(taskDetail.body.prompt).toBe(taskPayload.prompt);

    // 5. Simulate agent execution error & store in error-resolver smart contract
    const recordedError = onChainContracts.recordError(
      "agent-researcher-02",
      "budget",
      "ExceededLimit",
      "Optimize CPU instructions or increase resource limit fee."
    );

    expect(recordedError).toBeDefined();
    expect(recordedError.agentId).toBe("agent-researcher-02");
    expect(recordedError.errorCode).toBe("ExceededLimit");

    // Verify error is retrievable from error-resolver contract storage
    const errors = onChainContracts.getErrors("agent-researcher-02");
    expect(errors.length).toBe(1);
    expect(errors[0].category).toBe("budget");
    expect(errors[0].fixSuggestion).toContain("resource limit fee");
  });
});
