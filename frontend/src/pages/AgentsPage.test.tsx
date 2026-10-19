import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import AgentsPage from './AgentsPage'
import type { AgentRecord } from '../types/api'

const { getAgents, getPagination } = vi.hoisted(() => ({ getAgents: vi.fn(), getPagination: vi.fn() }))

vi.mock('../services/api', () => ({
  getAgentsPage: async (cursor?: string) => ({
    items: await getAgents(cursor),
    pagination: getPagination(cursor),
  }),
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
  getPagination.mockReset()
  getPagination.mockReturnValue({ limit: 100, nextCursor: null, hasNextPage: false })
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

  it('shows the dedicated page skeleton while loading', () => {
    getAgents.mockReturnValue(new Promise(() => {})) // never resolves
    renderPage()
    expect(screen.getByTestId('agents-page-skeleton')).toBeInTheDocument()
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
    expect(screen.queryByTestId('agents-page-skeleton')).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-skeleton-row')).not.toBeInTheDocument()
    expect(getAgents).toHaveBeenCalledTimes(2)
  })
})


describe('AgentsPage - cursor navigation', () => {
  it('replaces the current page and allows returning to the first page', async () => {
    getPagination.mockImplementation((cursor?: string) => ({
      limit: 100, nextCursor: cursor ? null : 'second-page', hasNextPage: !cursor,
    }))
    getAgents.mockImplementation(async (cursor?: string) => cursor ? [AGENTS[2]] : [AGENTS[0]])
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByTestId('agent-row-agent-audit-003')
    expect(screen.queryByTestId('agent-row-agent-research-001')).not.toBeInTheDocument()
    expect(getAgents).toHaveBeenLastCalledWith('second-page')
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'First page' }))
    await screen.findByTestId('agent-row-agent-research-001')
    expect(getAgents).toHaveBeenLastCalledWith(undefined)
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled()
  })
})

describe('AgentsPage - search, capability tags, sort and empty state (#823)', () => {
  it('filters agents by fuzzy search and highlights matched characters in agent cards', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')

    const searchInput = screen.getByTestId('agent-search-input')
    fireEvent.change(searchInput, { target: { value: 'smart' } })

    // Advance 300ms debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    await waitFor(() => {
      expect(screen.queryByTestId('agent-row-agent-research-001')).not.toBeInTheDocument()
      expect(screen.getByTestId('agent-row-agent-coding-002')).toBeInTheDocument()
    })

    // Check card with highlight mark element
    const card = screen.getByTestId('agent-card-agent-coding-002')
    expect(card.querySelector('mark')).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('filters agents by capability tag filter pills (OR logic)', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')

    const auditPill = screen.getByTestId('filter-capability-audit')
    fireEvent.click(auditPill)

    await waitFor(() => {
      expect(screen.queryByTestId('agent-row-agent-research-001')).not.toBeInTheDocument()
      expect(screen.queryByTestId('agent-row-agent-coding-002')).not.toBeInTheDocument()
      expect(screen.getByTestId('agent-row-agent-audit-003')).toBeInTheDocument()
    })
  })

  it('changes sort order immediately without refetching from the API', async () => {
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')
    const initialCallCount = getAgents.mock.calls.length

    const sortSelect = screen.getByTestId('agent-sort-select')
    fireEvent.change(sortSelect, { target: { value: 'price_asc' } })

    // No additional fetch should occur
    expect(getAgents.mock.calls.length).toBe(initialCallCount)
    // Check URL updated
    expect(screen.getByTestId('location-search').textContent).toContain('sortBy=price_asc')
  })

  it('renders empty state echoing query with a clear filters button when no agents match', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage()
    await screen.findByTestId('agent-row-agent-research-001')

    const searchInput = screen.getByTestId('agent-search-input')
    fireEvent.change(searchInput, { target: { value: 'blockchain auditing' } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    const emptyBox = await screen.findByTestId('agents-empty')
    expect(emptyBox).toHaveTextContent("No agents match 'blockchain auditing'")

    const clearBtn = screen.getByTestId('clear-filters-btn')
    expect(clearBtn).toBeInTheDocument()

    // Clicking clear filters resets search
    fireEvent.click(clearBtn)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })

    await waitFor(() => {
      expect(screen.getByTestId('agent-row-agent-research-001')).toBeInTheDocument()
    })

    vi.useRealTimers()
  })
})

