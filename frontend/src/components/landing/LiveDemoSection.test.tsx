import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import LiveDemoSection from './LiveDemoSection'
import type { NetworkStats } from '../../types/api'

const { getStats } = vi.hoisted(() => ({ getStats: vi.fn() }))

vi.mock('../../services/api', () => ({
  getStats,
}))

const STATS: NetworkStats = {
  totalAgents: 12,
  totalTasks: 347,
  totalXLMTransacted: 1250.75,
  uptimePercent: 99.98,
}

describe('LiveDemoSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the example workflow steps immediately, without waiting on the API', () => {
    getStats.mockReturnValue(new Promise(() => {})) // never resolves
    render(<LiveDemoSection />)

    expect(screen.getByTestId('demo-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('demo-step-research')).toBeInTheDocument()
    expect(screen.getByTestId('demo-step-risk')).toBeInTheDocument()
    expect(screen.getByTestId('demo-step-report')).toBeInTheDocument()
  })

  it('shows a loading state while fetching live stats', () => {
    getStats.mockReturnValue(new Promise(() => {}))
    render(<LiveDemoSection />)

    expect(screen.getByTestId('demo-stats-loading')).toBeInTheDocument()
  })

  it('renders real stats from the API once loaded', async () => {
    getStats.mockResolvedValue(STATS)
    render(<LiveDemoSection />)

    await waitFor(() => {
      expect(screen.getByTestId('demo-stats')).toBeInTheDocument()
    })

    expect(screen.getByText('347')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('100.0%')).toBeInTheDocument() // 99.98 rounded to 1 decimal
  })

  it('falls back to an unavailable message when the stats request fails', async () => {
    getStats.mockRejectedValue(new Error('network error'))
    render(<LiveDemoSection />)

    await waitFor(() => {
      expect(screen.queryByTestId('demo-stats-loading')).not.toBeInTheDocument()
    })

    expect(screen.queryByTestId('demo-stats')).not.toBeInTheDocument()
  })
})
