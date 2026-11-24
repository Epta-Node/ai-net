import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { apiClient } from './services/api'

// Keep the real App, providers, router, shell, bell and progress bar. Stub only
// external connections; an unmatched route avoids fetching page-specific data.
vi.mock('./services/freighter', () => ({ isFreighterAvailable: async () => false }))

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/provider-smoke')
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', class { close() {} })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('App provider wiring', () => {
  it('displays dispatched notifications in the real navigation bell', async () => {
    await act(async () => { render(<App />) })
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new CustomEvent('ai-net-notification', {
        detail: { type: 'system', title: 'Smoke notification', message: 'Provider is connected' },
      }))
    })
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(screen.getByText('Smoke notification')).toBeInTheDocument()
  })

  it.each([true, false])('shows a slow request and hides after success=%s', async (success) => {
    let settle!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { settle = resolve })))
    await act(async () => { render(<App />) })
    const bar = screen.getByRole('progressbar', { hidden: true })
    expect(bar).toHaveAttribute('aria-hidden', 'true')
    let pending!: Promise<unknown>
    act(() => { pending = apiClient.get('/smoke').catch(error => error) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(bar).toHaveAttribute('aria-hidden', 'false')
    await act(async () => {
      settle(new Response('{}', { status: success ? 200 : 500, headers: { 'content-type': 'application/json' } }))
      await pending
    })
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    if (!success) expect(bar.className).toContain('error')
    act(() => { vi.advanceTimersByTime(600) })
    expect(bar).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps progress visible when one of two concurrent requests fails', async () => {
    const resolvers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolvers.push(resolve) })))
    await act(async () => { render(<App />) })
    let first!: Promise<unknown>
    let second!: Promise<unknown>
    act(() => {
      first = apiClient.get('/first').catch(error => error)
      second = apiClient.get('/second')
    })
    await act(async () => {
      resolvers[0](new Response('{}', { status: 500 }))
      await first
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-hidden', 'false')
    await act(async () => {
      resolvers[1](new Response('{}', { headers: { 'content-type': 'application/json' } }))
      await second
    })
    act(() => { vi.advanceTimersByTime(600) })
    expect(screen.getByRole('progressbar', { hidden: true })).toHaveAttribute('aria-hidden', 'true')
  })
})
