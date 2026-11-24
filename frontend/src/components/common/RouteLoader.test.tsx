import React, { Suspense, lazy } from 'react'
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import RouteLoader from './RouteLoader'

describe('RouteLoader', () => {
  it('renders an accessible loading status', () => {
    render(<RouteLoader />)
    expect(screen.getByRole('status', { name: 'Loading page' })).toBeInTheDocument()
  })

  it('is shown as the route-level fallback while a lazy chunk loads', async () => {
    let resolveChunk!: (mod: { default: React.ComponentType }) => void
    const LazyPage = lazy(
      () =>
        new Promise<{ default: React.ComponentType }>((resolve) => {
          resolveChunk = resolve
        }),
    )

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <Suspense fallback={<RouteLoader />}>
          <Routes>
            <Route path="/agents" element={<LazyPage />} />
          </Routes>
        </Suspense>
      </MemoryRouter>,
    )

    expect(screen.getByTestId('route-loader')).toBeInTheDocument()

    await act(async () => {
      resolveChunk({ default: () => <h1>Agents loaded</h1> })
    })

    expect(await screen.findByText('Agents loaded')).toBeInTheDocument()
    expect(screen.queryByTestId('route-loader')).not.toBeInTheDocument()
  })
})
