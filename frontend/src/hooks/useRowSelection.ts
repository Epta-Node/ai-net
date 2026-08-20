import { useState, useCallback } from 'react'

export function useRowSelection<T>(items: T[], getId: (item: T) => string) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null)

  const toggleSelection = useCallback(
    (id: string, isShiftPressed: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        
        if (isShiftPressed && lastSelectedId) {
          const itemIds = items.map(getId)
          const startIdx = itemIds.indexOf(lastSelectedId)
          const endIdx = itemIds.indexOf(id)
          
          if (startIdx !== -1 && endIdx !== -1) {
            const [start, end] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
            for (let i = start; i <= end; i++) {
              next.add(itemIds[i])
            }
            return next
          }
        }

        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        setLastSelectedId(id)
        return next
      })
    },
    [items, getId, lastSelectedId]
  )

  const selectAll = useCallback((isSelected: boolean) => {
    if (isSelected) {
      setSelectedIds(new Set(items.map(getId)))
    } else {
      setSelectedIds(new Set())
      setLastSelectedId(null)
    }
  }, [items, getId])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setLastSelectedId(null)
  }, [])

  return {
    selectedIds,
    toggleSelection,
    selectAll,
    clearSelection,
  }
}
