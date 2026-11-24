import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect } from 'vitest'
import Footer from './Footer'

const renderFooter = () =>
  render(
    <MemoryRouter>
      <Footer />
    </MemoryRouter>
  )

describe('Footer Component', () => {
  test('renders brand logo and tagline', () => {
    renderFooter()
    expect(screen.getByText('ai-net')).toBeInTheDocument()
    expect(
      screen.getByText(/Autonomous AI agents that hire, collaborate, and pay each other on-chain./i)
    ).toBeInTheDocument()
  })

  test('renders product links with internal routes', () => {
    renderFooter()
    const dashboardLink = screen.getByRole('link', { name: /dashboard/i })
    expect(dashboardLink).toHaveAttribute('href', '/dashboard')

    const agentsLink = screen.getByRole('link', { name: /agents/i })
    expect(agentsLink).toHaveAttribute('href', '/agents')

    const tasksLink = screen.getByRole('link', { name: /tasks/i })
    expect(tasksLink).toHaveAttribute('href', '/tasks/new')

    const walletLink = screen.getByRole('link', { name: /wallet/i })
    expect(walletLink).toHaveAttribute('href', '/wallet')
  })

  test('renders external resources with target="_blank" and secure rel', () => {
    renderFooter()
    const docLinks = screen.getAllByRole('link', { name: /documentation/i })
    expect(docLinks[0]).toHaveAttribute('target', '_blank')
    expect(docLinks[0]).toHaveAttribute('rel', 'noopener noreferrer')

    const smartContractLink = screen.getByRole('link', { name: /smart contracts/i })
    expect(smartContractLink).toHaveAttribute('target', '_blank')
    expect(smartContractLink).toHaveAttribute('href', 'https://github.com/Epta-Node/ai-net/tree/main/smart-contracts')

    const stellarExplorerLink = screen.getByRole('link', { name: /stellar explorer/i })
    expect(stellarExplorerLink).toHaveAttribute('target', '_blank')
    expect(stellarExplorerLink).toHaveAttribute('href', 'https://stellar.expert/explorer/testnet')
  })

  test('renders social links with accessible aria labels and valid URLs', () => {
    renderFooter()
    const githubLinks = screen.getAllByRole('link', { name: 'GitHub' })
    expect(githubLinks.length).toBeGreaterThanOrEqual(1)
    expect(githubLinks.some((l) => l.getAttribute('href') === 'https://github.com/Epta-Node/ai-net')).toBe(true)

    const twitterLinks = screen.getAllByRole('link', { name: /twitter/i })
    expect(twitterLinks.length).toBeGreaterThanOrEqual(1)
    expect(twitterLinks.some((l) => l.getAttribute('href') === 'https://x.com/GuildNet_')).toBe(true)

    const discordLinks = screen.getAllByRole('link', { name: /discord/i })
    expect(discordLinks.length).toBeGreaterThanOrEqual(1)
    expect(discordLinks.some((l) => l.getAttribute('href') === 'https://discord.gg/stellar')).toBe(true)
  })

  test('renders copyright notice with current year', () => {
    renderFooter()
    const currentYear = new Date().getFullYear().toString()
    expect(screen.getByText(new RegExp(currentYear))).toBeInTheDocument()
  })
})
