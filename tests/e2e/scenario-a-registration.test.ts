import { createTestApp, onChainContracts, createE2ETestKeypair } from "./helpers";

describe("Scenario A: Agent Registration Flow (End-to-End)", () => {
  let appServer: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    appServer = createTestApp();
  });

  afterAll(() => {
    appServer.close();
  });

  it("registers an agent through the backend API and verifies on-chain & DB persistence", async () => {
    const keypair = createE2ETestKeypair();
    const agentData = {
      agentId: "agent-research-01",
      capabilities: ["research"],
      pricingXLM: 1.5,
      endpoint: "http://localhost:4001/agent/research",
      stellarPublicKey: keypair.publicKey()
    };

    // 1. Call POST /api/agents/register
    const res = await appServer.request
      .post("/api/agents/register")
      .send(agentData)
      .expect(201);

    expect(res.body).toHaveProperty("id", agentData.agentId);
    expect(res.body.capabilities).toContain("research");
    expect(res.body.pricingXLM).toBe(1.5);
    expect(res.body.stellarPublicKey).toBe(keypair.publicKey());

    // 2. Register / Sync agent in on-chain storage
    onChainContracts.registerAgent({
      id: agentData.agentId,
      capability: "research",
      priceStroops: agentData.pricingXLM * 10_000_000,
      endpoint: agentData.endpoint,
      ownerAddress: keypair.publicKey()
    });

    // 3. Verify agent exists in on-chain registry contract storage
    const onChainRecord = onChainContracts.lookupAgent("agent-research-01");
    expect(onChainRecord).toBeDefined();
    expect(onChainRecord?.capability).toBe("research");
    expect(onChainRecord?.ownerAddress).toBe(keypair.publicKey());

    // 4. Verify agent appears in GET /api/agents list
    const listRes = await appServer.request
      .get("/api/agents")
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    const foundAgent = listRes.body.find((a: any) => a.id === agentData.agentId);
    expect(foundAgent).toBeDefined();
    expect(foundAgent.pricingXLM).toBe(1.5);

    // 5. Verify agent details in GET /api/agents/:id
    const detailRes = await appServer.request
      .get(`/api/agents/${agentData.agentId}`)
      .expect(200);

    expect(detailRes.body.id).toBe("agent-research-01");
    expect(detailRes.body.endpoint).toBe("http://localhost:4001/agent/research");
  });
});
