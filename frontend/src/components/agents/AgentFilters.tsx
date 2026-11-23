import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X, SlidersHorizontal } from 'lucide-react'
import type { AgentSortOption } from '../../hooks/useAgentRegistry'

interface AgentFiltersProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedCapabilities: string[]
  onToggleCapability: (capability: string) => void
  availableCapabilities: string[]
  sortBy: AgentSortOption
  onSortChange: (sort: AgentSortOption) => void
  resultCount: number
  onReset?: () => void
  className?: string
}

/** How long typing must pause before the search query is applied (#888). */
export const SEARCH_DEBOUNCE_MS = 300

const SORT_OPTIONS: Array<{ value: AgentSortOption; label: string }> = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'price_asc', label: 'Price (low → high)' },
  { value: 'price_desc', label: 'Price (high → low)' },
  { value: 'reputation', label: 'Reputation score' },
]

export const AgentFilters: React.FC<AgentFiltersProps> = ({
  searchQuery,
  onSearchChange,
  selectedCapabilities,
  onToggleCapability,
  availableCapabilities,
  sortBy,
  onSortChange,
  resultCount,
  onReset,
  className = '',
}) => {
  // The input is controlled by local state so every keystroke shows at once;
  // only the (expensive) filter update is debounced (#888).
  const [localInput, setLocalInput] = useState(searchQuery)

  // The pending debounce timer lives in a ref, so re-renders never restart or
  // drop it. The previous effect-based version re-armed the timer on every
  // parent render (`onSearchChange` is an inline arrow in AgentsPage).
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Always call the latest callback without making it a timer dependency.
  const onSearchChangeRef = useRef(onSearchChange)
  useEffect(() => {
    onSearchChangeRef.current = onSearchChange
  }, [onSearchChange])

  // The last query this component sent up. When the parent echoes it back as
  // `searchQuery`, the input must not be reset, or keystrokes typed after the
  // timer fired would be wiped.
  const lastEmitted = useRef(searchQuery)

  const cancelPendingSearch = useCallback(() => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
  }, [])

  const emitSearch = useCallback((value: string) => {
    lastEmitted.current = value
    onSearchChangeRef.current(value)
  }, [])

  // Adopt changes that come from outside (Reset, Clear filters, URL edits).
  useEffect(() => {
    if (searchQuery === lastEmitted.current) return
    cancelPendingSearch()
    lastEmitted.current = searchQuery
    setLocalInput(searchQuery)
  }, [searchQuery, cancelPendingSearch])

  // Never fire after unmount.
  useEffect(() => cancelPendingSearch, [cancelPendingSearch])

  const handleSearchInput = (value: string) => {
    setLocalInput(value)
    cancelPendingSearch()
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null
      if (value !== lastEmitted.current) emitSearch(value)
    }, SEARCH_DEBOUNCE_MS)
  }

  const clearSearch = () => {
    cancelPendingSearch()
    setLocalInput('')
    emitSearch('')
  }

  return (
    <div className={`sticky top-0 z-20 space-y-3 rounded-2xl border border-[var(--border-subtle,#262626)] bg-[var(--surface-sunken,#121212)]/95 p-4 backdrop-blur-md shadow-md ${className}`}>
      {/* Top row: Search bar + Sort dropdown */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search
            size={18}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted,#737373)]"
            aria-hidden="true"
          />
          <input
            type="search"
            id="agent-search-input"
            data-testid="agent-search-input"
            value={localInput}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder="Search agents by name, ID or capability…"
            aria-label="Search agents"
            className="w-full rounded-xl border border-[var(--border-subtle,#2a2a2a)] bg-[var(--surface-sunken-hover,#181818)] py-2.5 pl-10 pr-9 text-sm text-[var(--text-primary,#fff)] placeholder-[var(--text-muted,#737373)] focus:border-[var(--primary,#9333ea)] focus:outline-none focus:ring-1 focus:ring-[var(--primary,#9333ea)]"
          />
          {localInput && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted,#737373)] hover:text-white"
              aria-label="Clear search query"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Sort Dropdown */}
        <div className="flex items-center gap-2">
          <label htmlFor="agent-sort-select" className="text-xs font-medium text-[var(--text-muted,#737373)] flex items-center gap-1">
            <SlidersHorizontal size={14} />
            <span>Sort:</span>
          </label>
          <select
            id="agent-sort-select"
            data-testid="agent-sort-select"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as AgentSortOption)}
            className="rounded-xl border border-[var(--border-subtle,#2a2a2a)] bg-[var(--surface-sunken-hover,#181818)] px-3 py-2 text-xs font-medium text-[var(--text-primary,#fff)] focus:border-[var(--primary,#9333ea)] focus:outline-none focus:ring-1 focus:ring-[var(--primary,#9333ea)]"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {onReset && (selectedCapabilities.length > 0 || localInput) && (
            <button
              type="button"
              onClick={() => {
                // Drop any half-typed query too, even one that was never sent.
                cancelPendingSearch()
                lastEmitted.current = ''
                setLocalInput('')
                onReset()
              }}
              className="rounded-xl border border-transparent px-2.5 py-1.5 text-xs text-purple-400 hover:text-purple-300"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Capability tag filter pills */}
      {availableCapabilities.length > 0 && (
        <div
          role="group"
          aria-label="Filter by capability"
          className="flex flex-wrap items-center gap-1.5 pt-1"
        >
          <span className="text-xs text-[var(--text-muted,#737373)] mr-1">Capabilities:</span>
          {availableCapabilities.map((cap) => {
            const isSelected = selectedCapabilities.includes(cap)
            return (
              <button
                key={cap}
                type="button"
                data-testid={`filter-capability-${cap}`}
                aria-pressed={isSelected}
                onClick={() => onToggleCapability(cap)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  isSelected
                    ? 'border border-[var(--primary,#9333ea)] bg-[var(--primary,#9333ea)] text-white shadow-sm'
                    : 'border border-[var(--border-subtle,#2a2a2a)] bg-[var(--surface-sunken-hover,#181818)] text-[var(--text-secondary,#a3a3a3)] hover:border-gray-500 hover:text-white'
                }`}
              >
                {cap}
              </button>
            )
          })}
        </div>
      )}

      {/* Accessible live region for screen reader result count */}
      <div role="status" aria-live="polite" className="sr-only">
        {resultCount} {resultCount === 1 ? 'agent' : 'agents'} found
      </div>
    </div>
  )
}

export default AgentFilters
