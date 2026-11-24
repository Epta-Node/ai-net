import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, test, expect, vi } from 'vitest'
import Navbar from './Navbar'
import { WalletProvider } from '../../context/WalletContext'

// Suppress framer-motion warning in jsdom
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => <div ref={ref} {...props}>{children}</div>
      ),
      button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
        ({ children, ...props }, ref) => <button ref={ref} {...props}>{children}</button>
      ),
      nav: React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
        ({ children, ...props }, ref) => <nav ref={ref} {...props}>{children}</nav>
      ),
    },
  }
})

const renderNavbar = () =>
  render(
    <MemoryRouter>
      <WalletProvider>
        <Navbar />
      </WalletProvider>
    </MemoryRouter>
  )

describe('Landing Navbar Component', () => {
  test('renders logo and wordmark', () => {
    renderNavbar()
    expect(screen.getByText('ai-net')).toBeInTheDocument()
  })

  test('renders marketing navigation links on desktop', () => {
    renderNavbar()
    expect(screen.getByRole('button', { name: /agents/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /tasks/i })).toBeInTheDocument()

    const docsLink = screen.getByRole('link', { name: /docs/i })
    expect(docsLink).toHaveAttribute('target', '_blank')
    expect(docsLink).toHaveAttribute('href', expect.stringContaining('docs.google.com'))

    const githubLink = screen.getByRole('link', { name: /github/i })
    expect(githubLink).toHaveAttribute('target', '_blank')
    expect(githubLink).toHaveAttribute('href', 'https://github.com/Epta-Node/ai-net')
  })

  test('renders search input and network status', () => {
    renderNavbar()
    expect(screen.getByPlaceholderText(/search agents, tasks/i)).toBeInTheDocument()
    expect(screen.getByText('Stellar Testnet')).toBeInTheDocument()
  })

  test('renders connect wallet trigger button', () => {
    renderNavbar()
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument()
  })

  test('toggles mobile menu drawer on hamburger click', () => {
    renderNavbar()
    const hamburger = screen.getByRole('button', { name: /toggle mobile menu/i })
    expect(hamburger).toBeInTheDocument()

    fireEvent.click(hamburger)
    expect(screen.getByText('Agent Network')).toBeInTheDocument()
  })
})
