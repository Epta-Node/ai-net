import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonTable,
  SkeletonAvatar,
} from './Skeleton'

describe('Skeleton', () => {
  it('renders an aria-hidden block with the requested dimensions', () => {
    render(<Skeleton width="50%" height="2rem" data-testid="skeleton" />)

    const el = screen.getByTestId('skeleton')
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el).toHaveStyle({ width: '50%', height: '2rem' })
  })

  it('applies the circular variant class for round placeholders', () => {
    render(<Skeleton variant="circular" data-testid="skeleton" />)
    expect(screen.getByTestId('skeleton').className).toContain('circular')
  })

  it('applies the pill variant class for chip placeholders', () => {
    render(<Skeleton variant="pill" data-testid="skeleton" />)
    expect(screen.getByTestId('skeleton').className).toContain('pill')
  })
})

describe('SkeletonText', () => {
  it('renders the requested number of lines', () => {
    render(<SkeletonText lines={4} />)
    expect(screen.getAllByTestId('skeleton-text-line')).toHaveLength(4)
  })

  it('renders the final line shorter than the rest', () => {
    render(<SkeletonText lines={3} lastLineWidth="40%" />)

    const lines = screen.getAllByTestId('skeleton-text-line')
    expect(lines[0]).toHaveStyle({ width: '100%' })
    expect(lines[2]).toHaveStyle({ width: '40%' })
  })
})

describe('SkeletonAvatar', () => {
  it('renders a circular skeleton at the given size', () => {
    render(<SkeletonAvatar size={64} data-testid="avatar" />)

    const el = screen.getByTestId('avatar')
    expect(el).toHaveStyle({ width: '64px', height: '64px' })
    expect(el.className).toContain('circular')
  })
})

describe('SkeletonTable', () => {
  it('renders the requested number of rows', () => {
    render(<SkeletonTable rows={3} columns={4} />)
    expect(screen.getAllByTestId('skeleton-table-row')).toHaveLength(3)
  })
})

describe('SkeletonCard', () => {
  it('renders children inside a card', () => {
    render(
      <SkeletonCard data-testid="card">
        <span data-testid="child" />
      </SkeletonCard>
    )

    expect(screen.getByTestId('card')).toContainElement(screen.getByTestId('child'))
  })
})
