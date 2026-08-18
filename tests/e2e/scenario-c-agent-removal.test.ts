import { createTestApp, onChainContracts, createE2ETestKeypair, signChallenge } from "./helpers";

describe("Scenario C: Agent Removal Cascades (End-to-End)", () => {
  let appServer: ReturnType<typeof createTestApp>;
  let agentKeypair: ReturnType<typeof createE2ETestKeypair>;

  beforeAll(async () => {
    appServer = createTestApp();
    agentKeypair = createE2ETestKeypair();

    // 1. Register agent
    const agentData = {
      agentId: "agent-ephemeral-03",
      capabilities: ["risk"],
      pricingXLM: 3.0,
      endpoint: "http://localhost:4004/risk",
      stellarPublicKey: agentKeypair.publicKey()
    };

    await appServer.request.post("/api/agents/register").send(agentData).expect(201);

    onChainContracts.registerAgent({
      id: agentData.agentId,
      capability: "risk",
      priceStroops: 30_000_000,
      endpoint: agentData.endpoint,
      ownerAddress: agentData.stellarPublicKey
    });

    // 2. Submit errors for the agent to error-resolver
    onChainContracts.recordError(
      "agent-ephemeral-03",
      "storage",
      "MissingValue",
      "Key not found in contract storage."
    );

    onChainContracts.recordError(
      "agent-ephemeral-03",
      "auth",
      "InvalidInput",
      "Invalid address authentication credentials."
    );
  });

  afterAll(() => {
    appServer.close();
  });

  it("removes agent via API, deregulation on-chain, and cascades cleanup to error-resolver", async () => {
    const agentId = "agent-ephemeral-03";

    // Confirm agent and errors exist prior to deletion
    expect(onChainContracts.lookupAgent(agentId)).toBeDefined();
    expect(onChainContracts.getErrors(agentId).length).toBe(2);

    // 3. Remove agent via DELETE /api/agents/:id with challenge & signature
    const challenge = "agent-deletion-challenge-123456";
    const signature = signChallenge(agentKeypair, challenge);

    const deleteRes = await appServer.request
      .delete(`/api/agents/${agentId}`)
      .set("x-challenge", challenge)
      .set("x-signature", signature)
      .expect(200);

    expect(deleteRes.body).toHaveProperty("message", "Agent deleted successfully");

    // 4. Verify agent deleted from backend DB
    await appServer.request.get(`/api/agents/${agentId}`).expect(404);

    // 5. Deregister agent from on-chain registry
    onChainContracts.deregisterAgent(agentId);
    expect(onChainContracts.lookupAgent(agentId)).toBeUndefined();

    // 6. Cascade cleanup of agent's errors from error-resolver smart contract
    const cleanedCount = onChainContracts.clearErrorsForAgent(agentId);
    expect(cleanedCount).toBe(2);
    expect(onChainContracts.getErrors(agentId)).toEqual([]);
  });
});
