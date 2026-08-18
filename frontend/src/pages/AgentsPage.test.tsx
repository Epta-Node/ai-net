import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AgentsPage from './AgentsPage'
import type { AgentRecord } from '../types/api'

const { getAgents } = vi.hoisted(() => ({ getAgents: vi.fn() }))

vi.mock('../services/api', () => ({
  getAgents,
}))

const AGENTS: AgentRecord[] = [
  {
    id: 'agent-research-001',
    name: 'Research Specialist',
    capabilities: ['research', 'report'],
    price: 0.5,
    reputation: 4.8,
    status: 'active',
    registrationTxHash: 'abc123def456',
  },
  {
    id: 'agent-coding-002',
    name: 'Smart Contract Dev',
    capabilities: ['coding'],
    price: 1.2,
    reputation: 4.9,
    status: 'active',
  },
  {
    id: 'agent-audit-003',
    name: 'QA Audit Agent',
    capabilities: ['coding', 'audit'],
    price: 0.8,
    reputation: 4.2,
    status: 'inactive',
  },
]

// Surfaces the current URL search string so tests can assert URL persistence.
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-search">{location.search}</div>
}

function renderPage(initialEntries = ['/agents']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AgentsPage />
      <LocationProbe />
    </MemoryRouter>
  )
}

beforeEach(() => {
  getAgents.mockReset()
  getAgents.mockResolvedValue(AGENTS)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentsPage - rendering', () => {
  it('renders all agents from GET /api/agents', async () => {
    renderPage()
    expect(await screen.findByTestId('agent-row-agent-research-001')).toBeInTheDocument()
    expect(screen.getByTestId('agent-row-agent-coding-002')).toBeInTheDocument()
    expect(screen.getByTestId('agent-row-agent-audit-003')).toBeInTheDocument()
  })

  it('shows a 5-row skeleton while loading', () => {
    getAgents.mockReturnValue(new Promise(() => {})) // never resolves
    renderPage()
    expect(screen.getAllByTestId('agent-skeleton-row')).toHaveLength(5)
  })

  it('renders the empty state when the API returns []', async () => {
    getAgents.mockResolvedValue([])
    renderPage()
    expect(await screen.findByTestId('agents-empty')).toBeInTheDocument()
  })
})

describe('AgentsPage - filtering', () => {
  it('hides non-matching agents when a capability is selected', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')

    fireEvent.click(screen.getByRole('button', { name: 'research', pressed: false }))

    await waitFor(() => {
      expect(screen.queryByTestId('agent-row-agent-coding-002')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('agent-row-agent-research-001')).toBeInTheDocument()
  })

  it('filters by the price slider without calling the API again', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-coding-002')
    expect(getAgents).toHaveBeenCalledTimes(1)

    // Lower the max price below the most expensive agent (1.2 XLM).
    const slider = screen.getByLabelText('Maximum price') as HTMLInputElement
    fireEvent.change(slider, { target: { value: '0.9' } })

    await waitFor(() => {
      expect(screen.queryByTestId('agent-row-agent-coding-002')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('agent-row-agent-research-001')).toBeInTheDocument()
    // No extra fetch triggered by client-side filtering.
    expect(getAgents).toHaveBeenCalledTimes(1)
  })

  it('filters by status toggle', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-audit-003')

    fireEvent.click(screen.getByRole('button', { name: 'Inactive' }))

    await waitFor(() => {
      expect(screen.queryByTestId('agent-row-agent-research-001')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('agent-row-agent-audit-003')).toBeInTheDocument()
  })
})

describe('AgentsPage - URL persistence', () => {
  it('writes filter state to the URL query string', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')

    fireEvent.click(screen.getByRole('button', { name: 'research', pressed: false }))

    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).toContain('caps=research')
    })
  })

  it('hydrates filter state from the URL query string', async () => {
    renderPage(['/agents?status=inactive'])
    await screen.findByTestId('agent-row-agent-audit-003')

    expect(screen.queryByTestId('agent-row-agent-research-001')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inactive' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('writes sort state to the URL when a column header is clicked', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')

    fireEvent.click(screen.getByRole('button', { name: /sort by price/i }))

    await waitFor(() => {
      const search = screen.getByTestId('location-search').textContent || ''
      expect(search).toContain('sort=price')
    })
  })
})

describe('AgentsPage - detail modal', () => {
  it('opens the modal with the registration tx hash linked to Stellar Explorer', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('agent-row-agent-research-001'))

    const modal = await screen.findByTestId('agent-detail-modal')
    const link = within(modal).getByTestId('registration-tx-link')
    expect(link).toHaveAttribute(
      'href',
      'https://stellar.expert/explorer/testnet/tx/abc123def456'
    )
  })

  it('shows "Not available" when there is no registration tx hash', async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId('agent-row-agent-coding-002'))

    const modal = await screen.findByTestId('agent-detail-modal')
    expect(within(modal).getByText('Not available')).toBeInTheDocument()
  })
})

describe('AgentsPage - auto-refresh', () => {
  it('updates the table on the 30s poll without showing the skeleton again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage()

    await screen.findByTestId('agent-row-agent-research-001')
    expect(getAgents).toHaveBeenCalledTimes(1)

    // Second poll returns an extra agent.
    getAgents.mockResolvedValue([
      ...AGENTS,
      {
        id: 'agent-new-004',
        name: 'New Agent',
        capabilities: ['design'],
        price: 0.3,
        reputation: 5,
        status: 'active',
      },
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    await waitFor(() => {
      expect(screen.getByTestId('agent-row-agent-new-004')).toBeInTheDocument()
    })
    // Refresh must not flash the loading skeleton.
    expect(screen.queryByTestId('agent-skeleton-row')).not.toBeInTheDocument()
    expect(getAgents).toHaveBeenCalledTimes(2)
  })
})
