import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskSubmissionForm } from './TaskSubmissionForm';
import type { AgentPreference } from '../../services/taskService';

const mockShowToast = vi.fn();

vi.mock('../../context/ToastContext', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ showToast: mockShowToast }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

vi.mock('./DAGPreview', () => ({
  DAGPreview: ({ dagPreview }: { dagPreview?: { nodes: { id: string; label: string }[]; edges: { source: string; target: string }[] } }) => (
    <div data-testid="dag-preview" data-nodes={JSON.stringify(dagPreview?.nodes ?? [])} data-edges={JSON.stringify(dagPreview?.edges ?? [])}>
      {dagPreview?.nodes.map((node) => <span key={node.id}>{node.label}</span>) ?? 'No DAG preview available yet.'}
    </div>
  ),
}));

vi.mock('../../hooks/useTaskSubmit', () => ({
  useTaskSubmit: () => ({
    submitTask: mockSubmitTask,
    status: mockStatus,
    error: mockError,
    data: null,
  }),
}));

const mockSubmitTask = vi.fn();
const mockStatus = 'idle';
const mockError = null;

const successfulResponse = {
  taskId: 'task-123',
  dagPreview: { nodes: [], edges: [] },
  status: 'created',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderForm() {
  return render(
    <MemoryRouter initialEntries={['/tasks/new']}>
      <Routes>
        <Route path="/tasks/new" element={<TaskSubmissionForm />} />
        <Route
          path="/tasks/:taskId"
          element={
            <>
              <LocationProbe />
              <div>Task detail</div>
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function fillGoal() {
  fireEvent.change(screen.getByLabelText(/task prompt/i), { target: { value: 'Build a report' } });
}

function selectAgents(agents: AgentPreference[]) {
  agents.forEach((agent) => fireEvent.click(screen.getByLabelText(new RegExp(`^${agentLabels[agent]}$`))));
}

const agentLabels: Record<AgentPreference, string> = {
  research: 'Research Agent',
  risk: 'Risk Agent',
  coding: 'Coding Agent',
  design: 'Design Agent',
  report: 'Report Agent',
};

describe('TaskSubmissionForm · wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockSubmitTask.mockReset();
    mockSubmitTask.mockResolvedValue(successfulResponse);
  });

  it('renders the first step by default and shows progress', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: 'Describe your goal' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    expect(screen.getByLabelText('Step 1: current')).toBeInTheDocument();
  });

  it('blocks advancement on invalid step 1 and shows an inline error', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Prompt is required')).toBeInTheDocument();
    // Still on step 1 — advancement was blocked.
    expect(screen.getByRole('heading', { name: 'Describe your goal' })).toBeInTheDocument();
    expect(mockSubmitTask).not.toHaveBeenCalled();
  });

  it('blocks advancement on step 2 when no agents are selected', async () => {
    renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // Now on step 2
    expect(await screen.findByRole('heading', { name: 'Choose agents & capabilities' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Choose at least one agent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeInTheDocument();
  });

  it('highlights completed and current steps in the progress indicator', async () => {
    renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByLabelText('Step 1: done')).toBeInTheDocument());
    expect(screen.getByLabelText('Step 2: current')).toBeInTheDocument();
    expect(screen.getByLabelText('Step 3: pending')).toBeInTheDocument();
    expect(screen.getByLabelText('Step 4: pending')).toBeInTheDocument();
  });

  it('prevents skipping ahead: navigating to an unvalidated later step is impossible', async () => {
    renderForm();
    // Empty goal — step 1 invalid. Advance is blocked.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Prompt is required');

    // The forward button remains on step 1; there is no path to step 4.
    expect(screen.getByRole('heading', { name: 'Describe your goal' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Submit' })).not.toBeInTheDocument();

    // Complete step 1, reach step 2 but do not select agents. Repeat the check.

    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Choose at least one agent');
    expect(screen.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Review budget & DAG' })).not.toBeInTheDocument();
  });

  it('updates the DAG preview in real time as agents change', async () => {
    renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });

    selectAgents(['research', 'coding']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review budget & DAG' });

    const preview = screen.getByTestId('dag-preview');
    expect(JSON.parse(preview.getAttribute('data-nodes')!)).toEqual([
      { id: 'research', label: 'Research Agent' },
      { id: 'coding', label: 'Coding Agent' },
    ]);
    expect(JSON.parse(preview.getAttribute('data-edges')!)).toEqual([
      { source: 'research', target: 'coding' },
    ]);

    // Go back, change the selection, and confirm the preview structure updates.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    fireEvent.click(screen.getByLabelText(agentLabels.report));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      const updated = screen.getByTestId('dag-preview');
      const nodes = JSON.parse(updated.getAttribute('data-nodes')!) as { id: string; label: string }[];
      const edges = JSON.parse(updated.getAttribute('data-edges')!) as { source: string; target: string }[];
      expect(nodes.map((n) => n.id)).toEqual(['research', 'coding', 'report']);
      expect(edges).toEqual([
        { source: 'research', target: 'coding' },
        { source: 'coding', target: 'report' },
      ]);
    });
  });

  it('validates the budget in the review step before advancing', async () => {
    renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    selectAgents(['research']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review budget & DAG' });

    fireEvent.change(screen.getByLabelText(/maximum budget/i), { target: { value: '0.01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Minimum budget is 0.1 XLM')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review budget & DAG' })).toBeInTheDocument();
  });

  it('persists a draft across navigation and restores it (incl. step)', async () => {
    const first = renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    selectAgents(['risk']);

    // Simulate leaving the page (unmount) and returning (fresh render).
    first.unmount();

    renderForm();

    // Restored the agent selection and skipped straight to the corresponding step.
    expect(await screen.findByRole('heading', { name: 'Choose agents & capabilities' })).toBeInTheDocument();
    expect(screen.getByLabelText('Step 2: current')).toBeInTheDocument();

    // Back to step 1 — the typed prompt is still there.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const promptField = screen.getByLabelText(/task prompt/i) as HTMLTextAreaElement;
    expect(promptField.value).toBe('Build a report');
  });

  it('redirects to the task detail route after a successful submission through all steps', async () => {
    renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    selectAgents(['research']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review budget & DAG' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Submit' });

    fireEvent.click(screen.getByRole('button', { name: /submit task/i }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-123'), { timeout: 500 });
  });

  it('shows an error toast when the network request fails', async () => {
    mockSubmitTask.mockRejectedValueOnce(new Error('Network unavailable'));
    renderForm();
    fillGoal();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    selectAgents(['research']);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review budget & DAG' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Submit' });

    fireEvent.click(screen.getByRole('button', { name: /submit task/i }));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    const [message, type] = mockShowToast.mock.calls[0];
    expect(message).toBe('Network unavailable');
    expect(type).toBe('error');
  });
});
