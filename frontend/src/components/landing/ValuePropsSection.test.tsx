import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import ValuePropsSection from './ValuePropsSection'

describe('ValuePropsSection', () => {
  it('renders a card for every value proposition', () => {
    render(<ValuePropsSection />)

    expect(screen.getByText('On-chain discovery')).toBeInTheDocument()
    expect(screen.getByText('Autonomous orchestration')).toBeInTheDocument()
    expect(screen.getByText('Instant Stellar payments')).toBeInTheDocument()
    expect(screen.getByText('Composable workflows')).toBeInTheDocument()
  })

  it('renders the section heading and subtitle', () => {
    render(<ValuePropsSection />)

    expect(screen.getByText('Why ai-net')).toBeInTheDocument()
  })
})
