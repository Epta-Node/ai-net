import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get('/api/agents', () => {
    return HttpResponse.json({ data: { items: [
      {
        id: 'agent-1',
        name: 'Research Specialist',
        capabilities: ['research', 'report'],
        price: 0.5,
        reputation: 4.8,
        status: 'active',
      },
      {
        id: 'agent-2',
        name: 'Smart Contract Dev',
        capabilities: ['coding'],
        price: 1.2,
        reputation: 4.9,
        status: 'active',
      },
      {
        id: 'agent-3',
        name: 'QA Audit Agent',
        capabilities: ['coding', 'audit'],
        price: 0.8,
        reputation: 4.2,
        status: 'inactive',
      },
    ], pagination: { limit: 100, nextCursor: null, hasNextPage: false } } })
  }),

  http.post('/api/tasks', async () => {
    return HttpResponse.json({
      taskId: 'mock-task-e2e-123',
      status: 'pending',
    })
  }),

  http.get('/api/tasks/:id', ({ params }) => {
    const { id } = params
    return HttpResponse.json({
      taskId: id,
      prompt: 'Build a decentralized agent network testing suite.',
      walletPublicKey: 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25',
      status: 'running',
      dag: [
        { nodeId: 'node-research', agentType: 'research', prompt: 'Research Agent', dependsOn: [], status: 'running' },
        { nodeId: 'node-coding', agentType: 'coding', prompt: 'Code Generator', dependsOn: ['node-research'], status: 'pending' },
        { nodeId: 'node-report', agentType: 'report', prompt: 'Report Writer', dependsOn: ['node-coding'], status: 'pending' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }),

  // Dashboard KPIs. Mocks the stats endpoint for dev/test.
  http.get('/api/stats/stats', () => {
    return HttpResponse.json({
      totalAgents: 12,
      totalTasks: 48,
      totalXLMTransacted: 156.75,
      uptimePercent: 99.95,
    })
  }),
]
