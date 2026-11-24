/**
 * Search debounce — Issue #888
 *
 *  - the input shows every keystroke immediately
 *  - the search callback fires once, 300ms after typing pauses
 *  - the pending timer survives parent re-renders (it lives in a ref)
 *  - echoing the sent query back from the parent never wipes newer keystrokes
 *  - clear, reset, external query changes and unmount cancel a pending search
 */
import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React, { useState } from 'react'
import { AgentFilters, SEARCH_DEBOUNCE_MS } from './AgentFilters'

const baseProps = {
  selectedCapabilities: [] as string[],
  onToggleCapability: () => {},
  availableCapabilities: [] as string[],
  sortBy: 'relevance' as const,
  onSortChange: () => {},
  resultCount: 0,
}

function renderFilters(searchQuery = '', extra: { onReset?: () => void } = {}) {
  const onSearchChange = vi.fn()
  const view = render(
    <AgentFilters {...baseProps} {...extra} searchQuery={searchQuery} onSearchChange={onSearchChange} />,
  )
  const input = () => screen.getByTestId('agent-search-input') as HTMLInputElement
  const type = (value: string) => fireEvent.change(input(), { target: { value } })
  const rerender = (query: string, cb: (q: string) => void = onSearchChange) =>
    view.rerender(<AgentFilters {...baseProps} {...extra} searchQuery={query} onSearchChange={cb} />)
  return { onSearchChange, input, type, rerender, unmount: view.unmount }
}

/** Mirrors AgentsPage: the parent stores the query and passes a fresh inline callback every render. */
function Parent({ onQuery }: { onQuery: (q: string) => void }) {
  const [query, setQuery] = useState('')
  const [, setTick] = useState(0)
  return (
    <>
      <button type="button" data-testid="rerender" onClick={() => setTick((n) => n + 1)} />
      <AgentFilters
        {...baseProps}
        searchQuery={query}
        onSearchChange={(q) => {
          onQuery(q)
          setQuery(q)
        }}
      />
    </>
  )
}

describe('AgentFilters search debounce (#888)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a 300ms delay', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300)
  })

  it('updates the input immediately on every keystroke', () => {
    const { input, type, onSearchChange } = renderFilters()
    type('r')
    expect(input().value).toBe('r')
    type('re')
    expect(input().value).toBe('re')
    expect(onSearchChange).not.toHaveBeenCalled()
  })

  it('fires once, 300ms after the last keystroke, with the final value', () => {
    const { type, onSearchChange } = renderFilters()
    type('r')
    act(() => vi.advanceTimersByTime(200))
    type('re')
    act(() => vi.advanceTimersByTime(200))
    type('res')
    act(() => vi.advanceTimersByTime(299))
    expect(onSearchChange).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(onSearchChange).toHaveBeenCalledTimes(1)
    expect(onSearchChange).toHaveBeenCalledWith('res')

    act(() => vi.advanceTimersByTime(1000))
    expect(onSearchChange).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst of keystrokes into a single search', () => {
    const { type, onSearchChange } = renderFilters()
    'research'.split('').forEach((_, i, chars) => {
      type(chars.slice(0, i + 1).join(''))
      act(() => vi.advanceTimersByTime(50))
    })
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onSearchChange.mock.calls).toEqual([['research']])
  })

  it('does not search when the text ends up unchanged', () => {
    const { type, onSearchChange } = renderFilters('abc')
    type('abcd')
    type('abc')
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onSearchChange).not.toHaveBeenCalled()
  })

  it('keeps the pending timer across parent re-renders with a new callback', () => {
    const { type, rerender, onSearchChange } = renderFilters()
    type('abc')
    act(() => vi.advanceTimersByTime(200))
    const latest = vi.fn()
    rerender('', latest) // re-render with a fresh inline callback
    act(() => vi.advanceTimersByTime(100))
    // Still fires at 300ms from the keystroke, through the latest callback.
    expect(latest).toHaveBeenCalledWith('abc')
    expect(onSearchChange).not.toHaveBeenCalled()
  })

  it('does not wipe keystrokes typed after a search was sent and echoed back', () => {
    const onQuery = vi.fn()
    render(<Parent onQuery={onQuery} />)
    const input = screen.getByTestId('agent-search-input') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'abc' } })
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onQuery).toHaveBeenLastCalledWith('abc')

    fireEvent.change(input, { target: { value: 'abcd' } })
    fireEvent.click(screen.getByTestId('rerender'))
    expect(input.value).toBe('abcd')

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onQuery.mock.calls).toEqual([['abc'], ['abcd']])
    expect(input.value).toBe('abcd')
  })

  it('clear button searches for "" at once and cancels the pending search', () => {
    const { type, onSearchChange, input } = renderFilters()
    type('abc')
    fireEvent.click(screen.getByLabelText('Clear search query'))
    expect(input().value).toBe('')
    expect(onSearchChange.mock.calls).toEqual([['']])

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onSearchChange.mock.calls).toEqual([['']])
  })

  it('Reset cancels a pending search and empties the input', () => {
    const onReset = vi.fn()
    const { type, onSearchChange, input } = renderFilters('', { onReset })
    type('abc')
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('')

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onSearchChange).not.toHaveBeenCalled()
  })

  it('adopts an external query change and cancels the pending search', () => {
    const { type, rerender, onSearchChange, input } = renderFilters('old')
    type('olde')
    rerender('from-url')
    expect(input().value).toBe('from-url')

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onSearchChange).not.toHaveBeenCalled()
  })

  it('never fires after unmount', () => {
    const { type, unmount, onSearchChange } = renderFilters()
    type('abc')
    unmount()
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS))
    expect(onSearchChange).not.toHaveBeenCalled()
  })
})
