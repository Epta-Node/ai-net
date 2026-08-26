import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AgentTable } from './AgentTable'
import type { AgentRecord } from '../../types/api'

vi.mock('../../hooks/useTableSort', () => ({
  useTableSort: () => ({
    sortKey: 'reputation',
    sortDir: 'desc',
    handleSort: vi.fn(),
  }),
}))

const mockAgents: AgentRecord[] = [
  {
    id: 'agent1',
    name: 'Agent 1',
    capabilities: ['data'],
    price: 10,
    reputation: 5,
    status: 'active',
  },
  {
    id: 'agent2',
    name: 'Agent 2',
    capabilities: ['code'],
    price: 20,
    reputation: 4,
    status: 'inactive',
  },
]

describe('AgentTable', () => {
  it('renders correctly', () => {
    const selectedIds = new Set<string>()
    const onToggleSelection = vi.fn()
    const onSelectAll = vi.fn()

    render(
      <AgentTable
        agents={mockAgents}
        loading={false}
        selectedIds={selectedIds}
        onToggleSelection={onToggleSelection}
        onSelectAll={onSelectAll}
      />
    )

    expect(screen.getByText('agent1')).toBeInTheDocument()
    expect(screen.getByText('agent2')).toBeInTheDocument()
  })

  it('handles row selection', () => {
    const selectedIds = new Set<string>()
    const onToggleSelection = vi.fn()
    const onSelectAll = vi.fn()

    render(
      <AgentTable
        agents={mockAgents}
        loading={false}
        selectedIds={selectedIds}
        onToggleSelection={onToggleSelection}
        onSelectAll={onSelectAll}
      />
    )

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBe(3) // 1 select all + 2 agents

    fireEvent.click(checkboxes[1])
    expect(onToggleSelection).toHaveBeenCalledWith('agent1', false)
  })

  it('handles select all', () => {
    const selectedIds = new Set<string>()
    const onToggleSelection = vi.fn()
    const onSelectAll = vi.fn()

    render(
      <AgentTable
        agents={mockAgents}
        loading={false}
        selectedIds={selectedIds}
        onToggleSelection={onToggleSelection}
        onSelectAll={onSelectAll}
      />
    )

    const selectAllCheckbox = screen.getAllByRole('checkbox')[0]
    fireEvent.click(selectAllCheckbox)
    expect(onSelectAll).toHaveBeenCalledWith(true)
  })

  it('handles row expansion', () => {
    const selectedIds = new Set<string>()
    const onToggleSelection = vi.fn()
    const onSelectAll = vi.fn()

    render(
      <AgentTable
        agents={mockAgents}
        loading={false}
        selectedIds={selectedIds}
        onToggleSelection={onToggleSelection}
        onSelectAll={onSelectAll}
      />
    )

    const expandButtons = screen.getAllByRole('button', { name: /Expand details/i })
    expect(expandButtons.length).toBe(2)

    fireEvent.click(expandButtons[0])
    expect(screen.getByTestId('agent-detail-modal')).toBeInTheDocument()
  })
})
