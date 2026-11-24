import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TaskDetailPage from './TaskDetailPage';

const mockTask = {
  id: 'task-test-123',
  prompt: 'Test prompt for task detail',
  status: 'completed' as const,
  walletPublicKey: 'GABC1234567890',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dag: [],
};

const mockNodes = [
  {
    nodeId: 'node_research',
    agentType: 'research',
    prompt: 'Research agent prompt',
    dependsOn: [],
    status: 'completed' as const,
    result: { summary: 'Research complete' },
  },
  {
    nodeId: 'node_report',
    agentType: 'report',
    prompt: 'Report agent prompt',
    dependsOn: ['node_research'],
    status: 'completed' as const,
    result: { summary: 'Report complete' },
  },
];

vi.mock('../hooks/useTaskMonitor', () => ({
  useTaskMonitor: (id?: string) => ({
    task: id === 'task-test-123' ? mockTask : null,
    loading: false,
    error: null,
    wsStatus: 'connected',
    nodes: id === 'task-test-123' ? mockNodes : [],
    payments: [],
    outputs: [],
    refetch: vi.fn(),
  }),
}));

vi.mock('../services/api', () => ({
  getTaskCost: vi.fn().mockResolvedValue({
    taskId: 'task-test-123',
    budgetTokens: 200000,
    usedTokens: 1500,
    remainingTokens: 198500,
    costUsd: 0.05,
    currency: 'USD',
    exceeded: false,
    calls: 2,
    inProgress: false,
    agents: [],
  }),
}));

function renderPage(taskId = 'task-test-123') {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${taskId}`]}>
      <Routes>
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('TaskDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task details and DAG preview section without crashing', async () => {
    renderPage('task-test-123');

    expect(screen.getByText(/Test prompt for task detail/i)).toBeInTheDocument();
    expect(screen.getByTestId('dag-preview')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/Task Completed Successfully/i)).toBeInTheDocument();
    });
  });

  it('renders skeleton loader when task data is loading', () => {
    vi.mocked(useTaskMonitor).mockReturnValueOnce({
      task: null,
      loading: true,
      error: null,
      wsStatus: 'connecting',
      nodes: [],
      payments: [],
      outputs: [],
      refetch: vi.fn(),
    });

    renderPage('task-loading');
    expect(screen.getByTestId('task-detail-skeleton')).toBeInTheDocument();
  });
});
