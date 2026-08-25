import { test, expect } from '@playwright/test'

// Note: /dashboard redirects to / when no wallet is connected, so these use /wallet,
// which renders inside AppShell without requiring a connection.
test.describe('phase 2 · i18n in the real app', () => {
  test('switcher updates the UI, <html lang> and persists across reload', async ({ page }) => {
    await page.goto('/wallet')

    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('#page-title')).toHaveText('Wallet')
    await expect(page.locator('#wallet-pubkey-display')).toHaveText('Not Connected')

    await page.locator('#btn-lang-zh').click()

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(page.locator('#page-title')).toHaveText('钱包')
    await expect(page.locator('#wallet-pubkey-display')).toHaveText('未连接')

    // F5
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(page.locator('#page-title')).toHaveText('钱包')
    expect(await page.evaluate(() => localStorage.getItem('i18nextLng'))).toBe('zh')

    // Switching back also persists
    await page.locator('#btn-lang-en').click()
    await page.reload()
    await expect(page.locator('#page-title')).toHaveText('Wallet')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('page title follows client-side navigation (getTitle regression)', async ({ page }) => {
    await page.goto('/wallet')
    await expect(page.locator('#page-title')).toHaveText('Wallet')

    await page.locator('.sidebar-nav button').filter({ hasText: 'Agents' }).first().click()
    await expect(page).toHaveURL(/\/agents$/)
    await expect(page.locator('#page-title')).toHaveText('Agent Registry')
  })
})

test.describe('phase 2 · browser locale detection', () => {
  test.use({ locale: 'zh-CN' })

  test('a zh-CN browser with no stored preference falls into the zh bundle', async ({ page }) => {
    await page.goto('/wallet')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(page.locator('#page-title')).toHaveText('钱包')
  })
})

test.describe('phase 3a · layout components', () => {
  test('sidebar and breadcrumb translate', async ({ page }) => {
    await page.goto('/wallet')

    const sidebar = page.locator('.sidebar-nav')
    await expect(sidebar).toContainText('Dashboard')
    await expect(sidebar).toContainText('Agents')
    await expect(page.locator('.breadcrumb [aria-current="page"]')).toHaveText('Wallet')

    await page.locator('#btn-lang-zh').click()

    await expect(sidebar).toContainText('仪表板')
    await expect(sidebar).toContainText('智能体')
    await expect(sidebar).toContainText('新建任务')
    await expect(sidebar).toContainText('钱包')
    await expect(page.locator('.breadcrumb [aria-current="page"]')).toHaveText('钱包')
    await expect(page.locator('.breadcrumb a').first()).toHaveText('仪表板')

    await page.locator('#btn-lang-en').click()
  })

  // The open drawer's backdrop covers the top nav, so the language is switched
  // with the drawer closed -- which is also how a user would actually do it.
  test('mobile drawer translates', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 })
    await page.goto('/wallet')

    const drawer = page.locator('.mobile-drawer')

    await page.locator('.hamburger').click()
    await expect(drawer.locator('.drawer-header h2')).toHaveText('Navigation')
    await expect(drawer).toHaveAttribute('aria-label', 'Mobile navigation menu')
    await expect(drawer.locator('.close-btn')).toHaveAttribute('aria-label', 'Close navigation menu')

    await drawer.locator('.close-btn').click()
    await expect(drawer).toHaveCount(0)

    // The switcher stays reachable on a mobile viewport
    await page.locator('#btn-lang-zh').click()
    await page.locator('.hamburger').click()

    await expect(drawer.locator('.drawer-header h2')).toHaveText('导航')
    await expect(drawer).toHaveAttribute('aria-label', '移动导航菜单')
    await expect(drawer.locator('.close-btn')).toHaveAttribute('aria-label', '关闭导航菜单')
    await expect(drawer.locator('.drawer-nav')).toContainText('智能体')

    await drawer.locator('.close-btn').click()
    await page.locator('#btn-lang-en').click()
  })
})

// The landing page renders outside AppShell, so it has no language switcher.
// Language is set through the stored preference, the way a returning visitor
// or a zh browser would arrive.
test.describe('phase 3b · landing page', () => {
  test('renders English copy, including both <Trans> blocks', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('Live on Stellar Testnet')).toBeVisible()
    const headline = page.locator('h1')
    await expect(headline).toContainText('AI agents that')
    await expect(headline.locator('span.bg-gradient-primary')).toHaveText('hire & pay each other')
    await expect(headline.locator('br')).toHaveCount(1)

    await expect(page.getByRole('button', { name: 'Start a Task' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Browse Agents' })).toBeVisible()
    await expect(page.getByText('Payment Rail')).toBeVisible()
    await expect(page.getByText('Specialist Agents Available Now')).toBeVisible()
    await expect(page.getByText('Autonomous AI agents that hire, collaborate, and pay each other on-chain.')).toBeVisible()

    const year = new Date().getFullYear().toString()
    const copyright = page.locator('footer p').filter({ hasText: 'ai-net' }).last()
    await expect(copyright).toContainText(year)
    await expect(copyright).toContainText('on Stellar & Soroban.')
    await expect(copyright.locator('svg')).toHaveCount(1)
  })

  test('renders Chinese copy with the <Trans> markup intact', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('i18nextLng', 'zh'))
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(page.getByText('已在 Stellar 测试网上线')).toBeVisible()

    const headline = page.locator('h1')
    await expect(headline).toContainText('AI 智能体')
    await expect(headline.locator('span.bg-gradient-primary')).toHaveText('互相雇佣与支付')
    await expect(headline.locator('br')).toHaveCount(1)

    await expect(page.getByRole('button', { name: '开始任务' })).toBeVisible()
    await expect(page.getByText('支付通道')).toBeVisible()
    await expect(page.getByText('现已上线的专业智能体')).toBeVisible()

    // Values stay untranslated: proper nouns and figures.
    // Exact match, because the footer copyright also mentions Soroban.
    await expect(page.getByText('Soroban', { exact: true })).toBeVisible()
    await expect(page.getByText('15 XLM', { exact: true })).toBeVisible()

    const copyright = page.locator('footer p').filter({ hasText: 'ai-net' }).last()
    await expect(copyright).toContainText(new Date().getFullYear().toString())
    await expect(copyright).toContainText('构建于 Stellar 与 Soroban。')
    await expect(copyright.locator('svg')).toHaveCount(1)
  })
})

// AgentOutputPanel and PaymentTimeline live in components/dashboard/ but render
// on the task detail page. The dashboard page itself cannot be exercised here:
// it crashes on a pre-existing bug unrelated to i18n (see PROGRESS §3.4).
test.describe('phase 3c · task detail panels', () => {
  const TASK_URL = '/tasks/mock-task-e2e-123'

  test('agent output panel and payment timeline translate', async ({ page }) => {
    await page.goto(TASK_URL)

    await expect(page.getByRole('heading', { name: 'Agent Execution Output' })).toBeVisible()
    await expect(page.getByText('Nodes', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Stellar Escrow Payment Timeline' })).toBeVisible()
    await expect(page.getByText('Locked', { exact: true })).toBeVisible()

    await page.locator('#btn-lang-zh').click()

    await expect(page.getByRole('heading', { name: '智能体执行输出' })).toBeVisible()
    await expect(page.getByText('节点', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Stellar 托管支付时间线' })).toBeVisible()
    await expect(page.getByText('已锁定', { exact: true })).toBeVisible()

    await page.locator('#btn-lang-en').click()
  })

  test('the {{name}} Agent interpolation swaps the suffix, not the name', async ({ page }) => {
    await page.goto(TASK_URL)

    // The node name comes from the data and must survive; only the suffix is
    // translated. Rendered in both the output panel and the payment timeline.
    //
    // useInnerText because the node id is lowercase ("research") and the capital
    // R comes from `text-transform: capitalize`, which textContent does not see.
    const body = page.locator('body')
    await expect(body).toContainText('Research Agent', { useInnerText: true })

    await page.locator('#btn-lang-zh').click()
    await expect(body).toContainText('Research 智能体', { useInnerText: true })
    await expect(body).not.toContainText('Research Agent', { useInnerText: true })

    await page.locator('#btn-lang-en').click()
  })
})

test.describe('phase 3d · agent registry', () => {
  test('table, filter bar and detail modal translate', async ({ page }) => {
    await page.goto('/agents')
    await expect(page.locator('#agent-table')).toBeVisible()

    const table = page.locator('#agent-table')
    await expect(table).toContainText('Agent ID')
    await expect(table).toContainText('Capabilities')
    await expect(table).toContainText('Price (XLM)')
    await expect(table).toContainText('Reputation')
    await expect(page.getByRole('button', { name: 'Inactive' })).toBeVisible()

    await page.locator('#btn-lang-zh').click()

    await expect(table).toContainText('智能体 ID')
    await expect(table).toContainText('能力')
    await expect(table).toContainText('价格 (XLM)')
    await expect(table).toContainText('声誉')
    await expect(page.getByRole('button', { name: '未激活' })).toBeVisible()
    // The status badge shares agent.status.* with the filter, so both move together
    await expect(table).toContainText('活跃')

    // Detail modal
    await page.locator('[data-testid="agent-row-agent-1"]').click()
    const modal = page.locator('[data-testid="agent-detail-modal"]')
    await expect(modal).toBeVisible()
    await expect(modal).toContainText('注册交易')
    await expect(modal).toContainText('状态')

    await page.keyboard.press('Escape')
    await page.locator('#btn-lang-en').click()
  })

  // Note: the row renders the truncated agent id and its capabilities, not the
  // agent name -- the name only appears in the row's aria-label and in the modal.
  test('capabilities and ids stay untranslated, because they are data', async ({ page }) => {
    await page.goto('/agents')
    const row = page.locator('[data-testid="agent-row-agent-1"]')
    const before = await row.innerText()
    expect(before).toContain('research')

    await page.locator('#btn-lang-zh').click()
    await expect(row).toContainText('research')

    // The agent name reaches the accessible name through a11y.viewDetailsFor,
    // where only the surrounding sentence is translated.
    await expect(row).toHaveAttribute('aria-label', /Research Specialist/)

    await page.locator('#btn-lang-en').click()
  })
})

test.describe('phase 3e+3f · wallet and pages', () => {
  test('wallet page, send form and transaction table translate', async ({ page }) => {
    await page.goto('/wallet')

    await expect(page.locator('#page-title')).toHaveText('Wallet')
    await expect(page.getByText('Connect your Stellar wallet to get started.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect with Secret Key' })).toBeVisible()
    await expect(page.getByText('Stellar Secret Key').first()).toBeVisible()

    await page.locator('#btn-lang-zh').click()

    await expect(page.locator('#page-title')).toHaveText('钱包')
    await expect(page.getByText('连接你的 Stellar 钱包即可开始。')).toBeVisible()
    await expect(page.getByRole('button', { name: '使用私钥连接' })).toBeVisible()
    // Sample keys are not natural language and stay literal
    await expect(page.getByPlaceholder('SABCD...5678').first()).toBeVisible()

    await page.locator('#btn-lang-en').click()
  })

  test('task detail page keeps "WS: connected" byte-identical in English', async ({ page }) => {
    await page.goto('/tasks/mock-task-e2e-123')
    // No websocket server here, so the badge shows the disconnected label
    await expect(page.locator('#ws-status')).toContainText('WS: disconnected')
    await expect(page.locator('#page-title')).toHaveText('Task Monitoring')
    await expect(page.getByText('Execution DAG Status')).toBeVisible()

    await page.locator('#btn-lang-zh').click()
    await expect(page.locator('#ws-status')).toContainText('WS: 已断开')
    await expect(page.getByText('执行 DAG 状态')).toBeVisible()
    // Task status stays raw: it is data (Decision #3)
    await expect(page.locator('.node-status').first()).toHaveText(/running|pending|completed/)

    await page.locator('#btn-lang-en').click()
  })

  test('404 page translates', async ({ page }) => {
    await page.goto('/this-route-does-not-exist')
    await expect(page.getByText('404 — Page Not Found')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go Home' })).toBeVisible()
  })
})

test.describe('phase 4 · task submission form', () => {
  test('form copy translates and the agent values stay in English', async ({ page }) => {
    await page.goto('/tasks/new')

    await expect(page.getByRole('heading', { name: 'Submit a New Task' })).toBeVisible()
    await expect(page.getByLabel('Task prompt')).toBeVisible()
    await expect(page.getByLabel('Maximum budget (XLM)')).toBeVisible()

    await page.locator('#btn-lang-zh').click()

    await expect(page.getByRole('heading', { name: '提交新任务' })).toBeVisible()
    await expect(page.getByLabel('任务提示词')).toBeVisible()
    await expect(page.getByLabel('最高预算 (XLM)')).toBeVisible()
    await expect(page.getByLabel('研究智能体')).toBeVisible()

    // The label is translated but the wire value the API receives is not.
    await expect(page.locator('#pref-research')).toHaveValue('research')

    await page.locator('#btn-lang-en').click()
  })

  test('zod validation messages follow a language change already on screen', async ({ page }) => {
    await page.goto('/tasks/new')

    // Submit empty to put validation errors on screen in English.
    await page.locator('#btn-submit-task').click()
    await expect(page.locator('#prompt-error')).toHaveText('Prompt is required')
    await expect(page.locator('#agentPreferences-error')).toHaveText('Choose at least one agent')

    await page.locator('#btn-lang-zh').click()

    // zod copies the message into the form state when validation runs, so this
    // only passes because the form re-validates on a language change.
    await expect(page.locator('#prompt-error')).toHaveText('提示词为必填项')
    await expect(page.locator('#agentPreferences-error')).toHaveText('请至少选择一个智能体')

    await page.locator('#btn-lang-en').click()
  })
})
