import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../context/ToastContext';
import { TaskSubmissionForm } from './TaskSubmissionForm';

vi.mock('./DAGPreview', () => ({
  DAGPreview: ({ dagPreview }: { dagPreview?: { nodes: { label: string }[] } }) => (
    <div data-testid="dag-preview">
      {dagPreview?.nodes.map((node) => <span key={node.label}>{node.label}</span>) ?? 'No DAG preview available yet.'}
    </div>
  ),
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderForm() {
  return render(
    <ToastProvider>
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
      </MemoryRouter>
    </ToastProvider>,
  );
}

const successfulResponse = {
  taskId: 'task-123',
  dagPreview: {
    nodes: [{ id: 'research', label: 'Research Agent' }],
    edges: [],
  },
  status: 'created',
};

describe('TaskSubmissionForm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a validation error for empty prompt without making an API call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /submit task/i }));

    expect(await screen.findByText('Prompt is required')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a validation error when maxBudgetXLM is below 0.1', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderForm();

    fireEvent.change(screen.getByLabelText(/task prompt/i), { target: { value: 'Build a report' } });
    fireEvent.change(screen.getByLabelText(/maximum budget/i), { target: { value: '0.01' } });
    fireEvent.click(screen.getByLabelText(/research agent/i));
    fireEvent.click(screen.getByRole('button', { name: /submit task/i }));

    expect(await screen.findByText('Minimum budget is 0.1 XLM')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redirects to the task detail route within 500ms of a successful API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => successfulResponse,
    } as unknown as Response);
    renderForm();

    fireEvent.change(screen.getByLabelText(/task prompt/i), { target: { value: 'Build a report' } });
    fireEvent.click(screen.getByLabelText(/research agent/i));
    fireEvent.click(screen.getByRole('button', { name: /submit task/i }));

    await waitFor(() => expect(screen.getByText('Task submitted successfully. Redirecting...')).toBeInTheDocument());

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/tasks/task-123'), { timeout: 500 });
  });

  it('shows and dismisses a toast when the network request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network unavailable'));
    renderForm();

    fireEvent.change(screen.getByLabelText(/task prompt/i), { target: { value: 'Build a report' } });
    fireEvent.click(screen.getByLabelText(/research agent/i));
    fireEvent.click(screen.getByRole('button', { name: /submit task/i }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Network unavailable')).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
