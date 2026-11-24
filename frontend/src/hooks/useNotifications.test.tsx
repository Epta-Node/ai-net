import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNotifications } from './useNotifications'

it('fails explicitly when the notification provider is missing', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(() => renderHook(() => useNotifications())).toThrow('NotificationProvider')
  } finally {
    consoleError.mockRestore()
  }
})
