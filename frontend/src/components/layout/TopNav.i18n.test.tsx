import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { createInstance } from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import i18n from 'i18next'
import TopNav from './TopNav'
import { WalletProvider } from '../../context/WalletContext'
import { i18nBaseOptions } from '../../i18n/options'

const renderNav = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <WalletProvider>
        <TopNav onMenuClick={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false} isMobile={false} />
      </WalletProvider>
    </MemoryRouter>
  )

describe('TopNav i18n and language switcher', () => {
  afterEach(async () => { await act(async () => { await i18n.changeLanguage('en') }) })

  it('renders English copy by default', () => {
    renderNav()
    expect(screen.getByText('Not Connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch to English' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Switch to 中文' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('re-renders TopNav copy when the language changes', async () => {
    renderNav()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Switch to 中文' })) })
    await waitFor(() => expect(screen.getByText('未连接')).toBeInTheDocument())
    expect(screen.queryByText('Not Connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换到中文' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('derives the page title from the router location, not window.location', async () => {
    renderNav('/wallet')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wallet')
    await act(async () => { await i18n.changeLanguage('zh') })
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('钱包'))
  })

  it('translates the task monitoring title on nested task routes', () => {
    renderNav('/tasks/abc-123')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Task Monitoring')
  })

  it('persists the chosen language to localStorage (survives F5)', async () => {
    localStorage.removeItem('i18nextLng')
    const app = createInstance()
    await app.use(LanguageDetector).init({
      ...i18nBaseOptions,
      detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'], lookupLocalStorage: 'i18nextLng' },
    })
    await app.changeLanguage('zh')
    expect(localStorage.getItem('i18nextLng')).toBe('zh')

    // Simulate a page reload: fresh instance, same config, no explicit language
    const reloaded = createInstance()
    await reloaded.use(LanguageDetector).init({
      ...i18nBaseOptions,
      detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'], lookupLocalStorage: 'i18nextLng' },
    })
    expect(reloaded.resolvedLanguage).toBe('zh')
    expect(reloaded.t('wallet.notConnected')).toBe('未连接')
    localStorage.removeItem('i18nextLng')
  })
})
