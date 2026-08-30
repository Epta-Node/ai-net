import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastContainer } from '../components/common/Toast'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: ToastType
  duration: number
  count?: number
  action?: ToastAction
  createdAt: number
}

interface ToastOptions {
  duration?: number
  action?: ToastAction
}

interface ToastContextValue {
  toasts: Toast[]
  showToast: (message: string, type?: ToastType, durationOrOptions?: number | ToastOptions) => string
  dismissToast: (id: string) => void
}

const defaultDurations: Record<ToastType, number> = {
  success: 5000,
  info: 5000,
  warning: 7000,
  error: 8000,
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef<Map<string, number>>(new Map())

  const dismissToast = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) {
      window.clearTimeout(t)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', durationOrOptions: number | ToastOptions = defaultDurations[type]) => {
      // Normalize options: allow legacy number or {duration, action}
      let duration: number
      let action: ToastAction | undefined
      if (typeof durationOrOptions === 'number') {
        duration = durationOrOptions
      } else {
        duration = durationOrOptions.duration ?? defaultDurations[type]
        action = durationOrOptions.action
      }

      const trimmed = message.trim()
      if (!trimmed) return ''

      // — Group duplicates: same message + type merges and increments count
      // Find existing toast with same message/type (case-sensitive)
      let grouped = false
      let targetId = ''
      setToasts((prev) => {
        const existingIndex = prev.findIndex((t) => t.message === trimmed && t.type === type)
        if (existingIndex !== -1) {
          grouped = true
          const existing = prev[existingIndex]
          targetId = existing.id
          // clear old timer so it restarts
          const oldTimer = timers.current.get(existing.id)
          if (oldTimer) {
            window.clearTimeout(oldTimer)
            timers.current.delete(existing.id)
          }
          const updated: Toast = {
            ...existing,
            count: (existing.count ?? 1) + 1,
            duration,
            createdAt: Date.now(),
            action: action ?? existing.action,
          }
          // move to end (top of stack visual) for freshness
          const next = [...prev]
          next.splice(existingIndex, 1)
          next.push(updated)
          return next
        }
        return prev
      })

      if (grouped) {
        // schedule dismiss for the grouped toast
        if (duration > 0) {
          const timer = window.setTimeout(() => dismissToast(targetId), duration)
          timers.current.set(targetId, timer)
        }
        return targetId
      }

      const id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2)

      const toast: Toast = {
        id,
        message: trimmed,
        type,
        duration,
        count: 1,
        action,
        createdAt: Date.now(),
      }

      // stacking: keep max 6 visible, drop oldest if exceeded
      setToasts((prev) => {
        const next = [...prev, toast]
        if (next.length > 6) return next.slice(next.length - 6)
        return next
      })

      if (duration > 0) {
        const timer = window.setTimeout(() => dismissToast(id), duration)
        timers.current.set(id, timer)
      }

      return id
    },
    [dismissToast],
  )

  // External dispatch support (used by services/api.ts notifyToast)
  useEffect(() => {
    const handleExternalToast = (event: Event) => {
      const customEvent = event as CustomEvent<{
        message?: string
        type?: ToastType
        duration?: number
        action?: ToastAction
      }>
      const message = customEvent.detail?.message
      if (!message) return
      const t = customEvent.detail?.type ?? 'info'
      const dur = customEvent.detail?.duration ?? defaultDurations[t]
      const act = customEvent.detail?.action
      showToast(message, t, act ? { duration: dur, action: act } : dur)
    }

    window.addEventListener('app-toast', handleExternalToast as EventListener)
    return () => window.removeEventListener('app-toast', handleExternalToast as EventListener)
  }, [showToast])

  // cleanup timers on unmount
  useEffect(() => {
    return () => {
      timers.current.forEach((timer) => window.clearTimeout(timer))
      timers.current.clear()
    }
  }, [])

  const value = useMemo<ToastContextValue>(() => ({ toasts, showToast, dismissToast }), [toasts, showToast, dismissToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    // Fallback for isolated tests without provider (see hooks/useToast)
    return {
      toasts: [],
      showToast: () => '',
      dismissToast: () => {},
    } as unknown as ToastContextValue
  }
  return ctx
}
