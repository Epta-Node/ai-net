# Frontend Contributor Guide

This guide covers the frontend application architecture, conventions, commands, and patterns for contributors working on the ai-net web dashboard.

---

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

The app runs at `http://localhost:5173` by default.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Type-check (`tsc --noEmit`) then production build |
| `npm run test` | Run Vitest unit tests (single pass) |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run test:e2e` | Run Playwright end-to-end tests |

Always run `npm run lint` and `npm run build` before committing.

---

## Project Structure

```
frontend/src/
├── components/       # UI components organized by domain
│   ├── agents/       # Agent table, detail modal, reputation charts
│   ├── auth/         # Authentication flows
│   ├── common/       # Shared: CommandPalette, ImageLightbox, Toast, etc.
│   ├── dashboard/    # Dashboard views
│   ├── landing/      # Landing page
│   ├── layout/       # App shell, sidebar, navigation
│   ├── notifications/# Notification components
│   ├── tasks/        # Task management UI
│   ├── ui/           # Foundation: Button, Card, Table, Modal, etc.
│   └── wallet/       # Wallet connection, export, payment charts
├── context/          # React contexts (WalletContext, etc.)
├── hooks/            # Custom hooks (useContractRead, useTransaction, etc.)
├── i18n/             # Internationalization config and translations
├── mocks/            # MSW handlers for testing
├── pages/            # Route-level page components
├── schemas/          # Zod validation schemas
├── services/         # API client and service layer
├── styles/           # Global CSS and Tailwind config
├── types/            # TypeScript type definitions
└── utils/            # Utility functions (format, amount, etc.)
```

---

## Component Conventions

### CSS Modules

All component styles use CSS Modules (`.module.css` co-located with the component):

```tsx
import styles from './MyComponent.module.css'

export function MyComponent() {
  return <div className={styles.container}>...</div>
}
```

### Naming

- Component files: `PascalCase.tsx` (e.g., `AgentTable.tsx`)
- Test files: `ComponentName.test.tsx` (co-located)
- CSS modules: `ComponentName.module.css` (co-located)
- Hook files: `useHookName.ts` (e.g., `useContractRead.ts`)

### Testing Attributes

Add `data-testid` attributes on interactive or testable elements:

```tsx
<button data-testid="submit-btn" onClick={onSubmit}>Submit</button>
```

### Internationalization

Use `react-i18next` for all user-facing strings:

```tsx
import { useTranslation } from 'react-i18next'

export function MyComponent() {
  const { t } = useTranslation()
  return <h1>{t('myComponent.title')}</h1>
}
```

Translation keys live in `src/i18n/`.

---

## Data-Fetching Patterns

### Smart Contract Reads

Use the foundation hooks for Soroban contract interactions:

```tsx
import { useContractRead } from '../hooks/useContractRead'

const { data, isLoading, error } = useContractRead({
  contractId: AGENT_REGISTRY_ID,
  method: 'get_agent',
  args: [agentId],
})
```

### Transactions

Use `useTransaction` for contract write operations:

```tsx
import { useTransaction } from '../hooks/useTransaction'

const tx = useTransaction()
await tx.submit({
  contractId: AGENT_REGISTRY_ID,
  method: 'register_agent',
  args: [...],
})
```

### Wallet Balance

```tsx
import { useWalletBalance } from '../hooks/useWalletBalance'

const { balance } = useWalletBalance(publicKey)
```

---

## Testing

### Unit Tests (Vitest)

- Framework: Vitest with jsdom environment
- DOM testing: `@testing-library/react` + `@testing-library/user-event`
- Mocking: MSW (`src/mocks/`) for API/contract calls
- Config: `vitest.config.ts` and `vitest.setup.ts`

```bash
npm run test         # single run
npm run test:watch   # watch mode
```

### Test Patterns

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />)
    expect(screen.getByTestId('my-component')).toBeInTheDocument()
  })

  it('handles click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<MyComponent onClick={onClick} />)
    await user.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalled()
  })
})
```

### E2E Tests (Playwright)

```bash
npm run test:e2e
```

Config: `playwright.config.ts`

---

## Design Tokens & Styling

- Tailwind CSS for utility classes
- CSS custom properties for design tokens (defined in `src/styles/`)
- CSS Modules for component-scoped styles
- `framer-motion` for animations
- `lucide-react` for icons

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `react` / `react-dom` | UI framework |
| `react-router-dom` | Client-side routing |
| `react-hook-form` + `zod` | Form management and validation |
| `@stellar/stellar-sdk` | Soroban contract interaction |
| `@stellar/freighter-api` | Wallet connection |
| `i18next` | Internationalization |
| `recharts` | Charts and data visualization |
| `reactflow` | DAG / workflow visualization |
| `jspdf` | PDF export |

---

## Links

- [Root CONTRIBUTING.md](../CONTRIBUTING.md) — branch naming, commit conventions, PR workflow
- [AGENTS.md](../AGENTS.md) — verification commands, architectural principles
