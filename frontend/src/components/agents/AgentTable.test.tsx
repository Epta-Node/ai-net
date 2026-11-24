import { useState, type ComponentProps, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import type { AgentRecord } from '../../types/api';
import type { SortDir, SortKey } from '../../utils/agentRegistry';
import { AgentTable } from './AgentTable';
import { AgentDetailModal } from './AgentDetailModal';

vi.mock('../../hooks/useAgentReputation', () => ({
  useAgentReputation: () => ({ data: null, loading: false, error: null }),
}));

function renderInRouter(ui: ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

const AGENTS: AgentRecord[] = [
  {
    id: 'agent-alpha-001',
    name: 'Alpha Agent',
    capabilities: ['research'],
    price: 0.5,
    reputation: 4.8,
    status: 'active',
  },
  {
    id: 'agent-bravo-002',
    name: 'Bravo Agent',
    capabilities: ['coding'],
    price: 1.2,
    reputation: 4.9,
    status: 'active',
  },
  {
    id: 'agent-charlie-003',
    name: 'Charlie Agent',
    capabilities: ['audit'],
    price: 0.8,
    reputation: 4.2,
    status: 'inactive',
  },
];

function tableProps(overrides: Partial<ComponentProps<typeof AgentTable>> = {}) {
  return {
    agents: AGENTS,
    loading: false,
    sortKey: null,
    sortDir: 'desc' as SortDir,
    onSort: vi.fn(),
    onRowClick: vi.fn(),
    ...overrides,
  };
}

function tableRows() {
  const table = screen.getByRole('table', { name: 'Agent Registry' });
  return within(table).getAllByRole('row').slice(1);
}

function focusElement(element: HTMLElement) {
  act(() => element.focus());
}

function ControlledSortTable() {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  return (
    <AgentTable
      {...tableProps({
        sortKey,
        sortDir,
        onSort: (key) => {
          setSortDir((current) => (key === sortKey ? (current === 'asc' ? 'desc' : 'asc') : 'asc'));
          setSortKey(key);
        },
      })}
    />
  );
}

function FilterableTable() {
  const [query, setQuery] = useState('');
  const visible = AGENTS.filter((agent) => agent.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <label>
        Filter by name
        <input value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <AgentTable {...tableProps({ agents: visible })} />
    </>
  );
}

function ModalHarness() {
  const [selected, setSelected] = useState<AgentRecord | null>(null);

  return (
    <>
      <AgentTable {...tableProps({ onRowClick: setSelected })} />
      <AgentDetailModal agent={selected} onClose={() => setSelected(null)} />
    </>
  );
}

describe('AgentTable - native table semantics', () => {
  it('uses native table markup with a caption, column scopes, and no redundant roles', () => {
    renderInRouter(<AgentTable {...tableProps()} />);

    const table = screen.getByRole('table', { name: 'Agent Registry' });
    expect(table).not.toHaveAttribute('role');

    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(6);
    headers.forEach((header) => expect(header).toHaveAttribute('scope', 'col'));

    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(AGENTS.length + 1);
    rows.forEach((row) => expect(row).not.toHaveAttribute('role'));
  });

  it('exposes aria-sort and keeps it in sync with the real sort handler', async () => {
    const user = userEvent.setup();
    renderInRouter(<ControlledSortTable />);

    const table = screen.getByRole('table', { name: 'Agent Registry' });
    const priceHeader = within(table).getAllByRole('columnheader')[2];
    expect(priceHeader).toHaveAttribute('aria-sort', 'none');

    await user.click(within(priceHeader).getByRole('button', { name: /sort by price/i }));
    expect(priceHeader).toHaveAttribute('aria-sort', 'ascending');

    await user.click(within(priceHeader).getByRole('button', { name: /sort by price/i }));
    expect(priceHeader).toHaveAttribute('aria-sort', 'descending');
  });
});

describe('AgentTable - keyboard navigation', () => {
  it('uses roving tabindex and moves focus with Arrow/Home/End while clamping at both ends', async () => {
    const user = userEvent.setup();
    renderInRouter(<AgentTable {...tableProps()} />);

    const [first, second, third] = tableRows();
    expect(first).toHaveAttribute('tabindex', '0');
    expect(second).toHaveAttribute('tabindex', '-1');
    expect(third).toHaveAttribute('tabindex', '-1');

    focusElement(first);
    expect(fireEvent.keyDown(first, { key: 'ArrowDown' })).toBe(false);
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('tabindex', '0');
    expect(first).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{End}');
    expect(third).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(third).toHaveFocus();

    await user.keyboard('{Home}');
    expect(first).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(first).toHaveFocus();
  });

  it('activates the existing row click handler with Enter and Space', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderInRouter(<AgentTable {...tableProps({ onRowClick })} />);

    focusElement(tableRows()[0]);
    await user.keyboard('{Enter} ');

    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenNthCalledWith(1, AGENTS[0]);
    expect(onRowClick).toHaveBeenNthCalledWith(2, AGENTS[0]);
  });

  it('ignores navigation keys from nested interactive children and still lets them activate', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderInRouter(<AgentTable {...tableProps({ onRowClick })} />);

    const details = within(tableRows()[0]).getByRole('button', { name: 'Details' });
    focusElement(details);
    expect(fireEvent.keyDown(details, { key: 'ArrowDown' })).toBe(true);
    expect(details).toHaveFocus();
    expect(tableRows()[1]).not.toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(AGENTS[0]);
  });
});

describe('AgentTable - focus safety across data changes', () => {
  it('renders an empty state and keeps a single-row table clamped', () => {
    const { unmount } = renderInRouter(<AgentTable {...tableProps({ agents: [] })} />);
    expect(screen.getByTestId('agents-empty')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    unmount();

    renderInRouter(<AgentTable {...tableProps({ agents: [AGENTS[0]] })} />);
    const [row] = tableRows();
    focusElement(row);
    expect(fireEvent.keyDown(row, { key: 'End' })).toBe(false);
    expect(fireEvent.keyDown(row, { key: 'ArrowDown' })).toBe(false);
    expect(row).toHaveFocus();
  });

  it('clamps the active row and page when filtering shrinks the dataset', async () => {
    const onRowClick = vi.fn();
    const first = renderInRouter(<AgentTable {...tableProps({ onRowClick })} />);

    focusElement(tableRows()[2]);
    first.rerender(<MemoryRouter><AgentTable {...tableProps({ agents: [AGENTS[0]], onRowClick })} /></MemoryRouter>);

    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(tableRows()[0]).toHaveAttribute('tabindex', '0');
    first.unmount();

    const many = Array.from({ length: 26 }, (_, index) => ({ ...AGENTS[0], id: `agent-${index}` }));
    const second = renderInRouter(<AgentTable {...tableProps({ agents: many, onRowClick })} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    second.rerender(<MemoryRouter><AgentTable {...tableProps({ agents: [AGENTS[0]], onRowClick })} /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument());
    expect(tableRows()).toHaveLength(1);
  });

  it('keeps roving focus valid when a parent filter changes the visible rows', async () => {
    const user = userEvent.setup();
    renderInRouter(<FilterableTable />);

    focusElement(tableRows()[2]);
    await user.type(screen.getByLabelText('Filter by name'), 'alpha');

    await waitFor(() => expect(tableRows()).toHaveLength(1));
    expect(tableRows()[0]).toHaveAttribute('tabindex', '0');
    focusElement(tableRows()[0]);
    await user.keyboard('{ArrowDown}');
    expect(tableRows()[0]).toHaveFocus();
  });
});

describe('AgentTable - modal focus return', () => {
  it('returns focus to the invoking row action after the detail modal closes', async () => {
    const user = userEvent.setup();
    renderInRouter(<ModalHarness />);

    const trigger = within(tableRows()[0]).getByRole('button', { name: 'Details' });
    focusElement(trigger);
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: /Details for Alpha Agent/ });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
