import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect } from 'vitest'
import Breadcrumb from './Breadcrumb'

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumb />
    </MemoryRouter>,
  )

describe('Breadcrumb', () => {
  test('renders nothing on the landing page', () => {
    const { container } = renderAt('/')
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing at the in-app root — the trail would be one link to itself', () => {
    const { container } = renderAt('/dashboard')
    expect(container).toBeEmptyDOMElement()
  })

  test('is exposed as a labelled navigation landmark', () => {
    renderAt('/agents')
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument()
  })

  test('links back to the dashboard from a nested page', () => {
    renderAt('/agents')
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard')
  })

  test('marks the current page with aria-current and does not link it', () => {
    renderAt('/agents')
    const current = screen.getByText('Agents')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument()
  })

  test('labels a segment from the shared nav config', () => {
    renderAt('/tasks/new')
    expect(screen.getByText('New Task')).toBeInTheDocument()
  })

  test('renders the "/tasks" segment as plain text — there is no page at that path', () => {
    renderAt('/tasks/history')
    const tasks = screen.getByText('Tasks')
    expect(tasks).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument()
  })

  test('names a task detail page by its id', () => {
    renderAt('/tasks/abc-123')
    expect(screen.getByText('Task abc-123')).toBeInTheDocument()
  })

  test('falls back to a capitalised segment for an unknown route', () => {
    renderAt('/settings')
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })
})
