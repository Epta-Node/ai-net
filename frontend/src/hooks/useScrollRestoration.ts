import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

export const useScrollRestoration = () => {
  const location = useLocation()
  const scrollPositions = useRef<Record<string, number>>({})

  useEffect(() => {
    const key = location.pathname + location.search
    const scrollContainer = document.querySelector('.main-content')

    if (scrollContainer) {
      if (scrollPositions.current[key] !== undefined) {
        setTimeout(() => {
          scrollContainer.scrollTop = scrollPositions.current[key]
        }, 0)
      } else {
        scrollContainer.scrollTop = 0
      }
    }

    return () => {
      if (scrollContainer) {
        scrollPositions.current[key] = scrollContainer.scrollTop
      }
    }
  }, [location])

  useEffect(() => {
    const main = document.querySelector('main') || document.querySelector('[role="main"]')
    if (main) {
      main.focus()
    }
  }, [location.pathname])
}
