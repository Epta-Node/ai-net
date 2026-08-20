import { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SortDir, SortKey } from '../utils/agentRegistry'

export function useTableSort(defaultSortKey: SortKey = 'reputation', defaultSortDir: SortDir = 'desc') {
  const [searchParams, setSearchParams] = useSearchParams()
  
  const sortKey = (searchParams.get('sort') as SortKey) || defaultSortKey
  const sortDir = (searchParams.get('order') as SortDir) || defaultSortDir

  const handleSort = useCallback((key: SortKey) => {
    setSearchParams((prev) => {
      const isAsc = prev.get('sort') === key && prev.get('order') === 'asc'
      prev.set('sort', key)
      prev.set('order', isAsc ? 'desc' : 'asc')
      return prev
    })
  }, [setSearchParams])

  return { sortKey, sortDir, handleSort }
}
