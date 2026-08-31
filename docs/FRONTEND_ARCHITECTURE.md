# Frontend Architecture & Component Conventions

This document defines the folder structure, naming rules, state management
patterns, and conventions for the ai-net frontend.

---

## Folder Structure

```
frontend/src/
├── components/          # Reusable UI components
│   ├── common/          # Generic, domain-agnostic (Toast, Skeleton, ErrorBoundary)
│   ├── layout/          # App shell, navigation, sidebar
│   ├── landing/         # Public landing page components
│   ├── dashboard/       # Dashboard widgets (KPI cards, tables, charts)
│   ├── tasks/           # Task-related UI (filter, timeline, comparison)
│   ├── notifications/   # Notification center and items
│   └── wallet/          # Wallet wizard, transaction table, charts
├── context/             # React Context providers (Wallet, Theme, Toast, Notifications)
├── hooks/               # Custom React hooks (useWallet, useTheme, useTaskWebSocket, etc.)
├── i18n/                # Internationalization config and locale JSON files
│   └── locales/         # en.json, zh.json, etc.
├── mocks/               # MSW mock handlers for development/testing
├── pages/               # Route-level page components
│   └── tasks/           # Task sub-pages (NewTaskPage, TaskHistoryPage)
├── schemas/             # Zod validation schemas (wallet, task)
├── types/               # TypeScript type definitions (agent, api, notification)
└── utils/               # Pure utility functions (format, time, agentRegistry)
```

---

## Naming Rules

### Files

| Kind | Pattern | Example |
|------|---------|---------|
| Component | `PascalCase.tsx` | `AgentCard.tsx`, `TaskFilterBar.tsx` |
| CSS Module | `PascalCase.module.css` | `AgentCard.module.css` |
| Plain CSS | `PascalCase.css` | `Toast.css` |
| Hook | `camelCase.ts` (prefix `use`) | `useWallet.ts`, `useTaskWebSocket.ts` |
| Type | `camelCase.ts` | `agent.ts`, `api.ts` |
| Schema | `camelCase.ts` | `wallet.ts`, `task.ts` |
| Utility | `camelCase.ts` | `format.ts`, `time.ts` |
| Test | `*.test.ts` / `*.test.tsx` | `useNodeState.test.ts` |
| i18n test | `*.i18n.test.tsx` | `RecentTasksTable.i18n.test.tsx` |

### Components

- **One component per file.** File name matches the default export.
- **Named exports** for types/interfaces (`AgentData`, `AgentCardProps`).
- **No default export for hooks or utilities** — use named exports.
- **Co-locate tests** next to the component: `AgentCard.tsx` → `AgentCard.test.tsx`.

### CSS

- **CSS Modules** for component-scoped styles (`.module.css`).
- **Plain CSS** only for global resets or third-party overrides.
- Use Tailwind utility classes inline when possible; CSS Modules for complex
  animations or pseudo-elements.

---

## State Management

### React Context (Global State)

Used for cross-cutting concerns that many components need:

| Context | Purpose |
|---------|---------|
| `WalletContext` | Stellar wallet connection, signing, balance |
| `ThemeContext` | Dark/light mode toggle |
| `ToastContext` | Global toast notifications |
| `NotificationContext` | In-app notification feed |

### Custom Hooks (Component State)

Data fetching and component-local state live in custom hooks:

| Hook | Purpose |
|------|---------|
| `useWallet` | Wallet connection and signing |
| `useWalletBalance` | Balance polling |
| `useTaskWebSocket` | Real-time task status via WS |
| `useAgentRegistry` | Agent discovery and registration |
| `useTaskSubmit` | Task submission flow |
| `useNotifications` | Notification polling |
| `useTheme` | Theme preference persistence |
| `useNetworkStats` | Network health metrics |

### Rules

1. **No Redux or Zustand.** Context + hooks is the pattern.
2. **Lift state up** only when two sibling components need the same data.
3. **Prefer colocation** — keep state close to where it's used.
4. **Memoize expensive computations** with `useMemo`/`useCallback`.

---

## Adding New Components

1. Create `ComponentName.tsx` in the appropriate `components/<category>/` folder.
2. Create `ComponentName.module.css` if custom styles are needed.
3. Create `ComponentName.test.tsx` for unit tests.
4. Export the component as default from the file.
5. Use the `PascalCase` naming convention.

## Adding New Pages

1. Create `PageName.tsx` in `pages/` (or `pages/<section>/` for sub-pages).
2. Create `PageName.module.css` if needed.
3. Add the route in `App.tsx`.
4. Add i18n keys in `i18n/locales/en.json` (and other locales).

## Adding New Hooks

1. Create `useHookName.ts` in `hooks/`.
2. Create `useHookName.test.ts` for unit tests.
3. Export as a named export.
4. Prefix with `use`.

---

## Verification

Before submitting changes:

```bash
cd frontend
npm run lint
npm run build
```

Lint catches naming violations (unused imports, type issues). Build verifies
the full bundle compiles without errors.
