# Application shell

The single layout every in-app page renders inside. Introduced for the
responsive layout system (frontend issue #19) and unified for
[#352](https://github.com/Epta-Node/ai-net/issues/352), which consolidated the
per-route variations into one shell.

## Files

### Components
- `src/components/layout/AppShell.tsx` — the shell; owns sidebar/drawer state
- `src/components/layout/TopNav.tsx` — header: page title, notifications, theme, language, wallet
- `src/components/layout/Sidebar.tsx` — collapsible grouped sidebar (desktop)
- `src/components/layout/MobileDrawer.tsx` — slide-over navigation (below 1024px)
- `src/components/layout/Breadcrumb.tsx` — breadcrumb trail
- `src/components/layout/navigation.ts` — **single source of truth for nav items and groups**
- `src/components/layout/index.ts` — barrel export

### Styling
Each component has a sibling `.css` file. `AppShell.css` defines the layout
custom properties (`--sidebar-width`, `--sidebar-width-collapsed`,
`--topnav-height`) that the others consume.

## Structure

```
App
└── / ......................... LandingPage (public, renders bare)
└── /* ........................ AppShell
                                ├── TopNav (fixed header)
                                ├── Sidebar (≥1024px)
                                ├── MobileDrawer (<1024px, when open)
                                └── main
                                    ├── Breadcrumb
                                    └── page content
```

`/` is the public marketing page and is deliberately outside the shell. Every
other route — including the 404 — renders inside `AppShell`, so the navigation
is assembled once rather than per route. The command palette is mounted once
beside the route tree so Ctrl/Cmd+K works everywhere without remounting on
navigation.

## Navigation config

`navigation.ts` is the only place nav items are declared. The sidebar, the
mobile drawer, the breadcrumb labels, and the command palette's page results all
read from it.

```ts
NAV_GROUPS  // grouped, in sidebar order: Overview / Work / Account
NAV_ITEMS   // flat list of every item
isNavItemActive(currentPath, itemPath)
```

Before #352 each surface carried its own copy, which is how the drawer ended up
with hardcoded English labels while the sidebar was translated, and how the
sidebar's "Dashboard" ended up pointing at `/` (the public landing page) rather
than `/dashboard`.

**Active state** is an exact match or a descendant of it, so `/tasks/new/step-2`
highlights "New Task" while `/tasks/abc-123` — a detail page with no nav entry —
correctly highlights nothing.

## Responsive behaviour

| Viewport | Navigation | Content |
|---|---|---|
| ≥ 1024px | Top nav + collapsible sidebar | Offset by the sidebar rail |
| < 1024px | Top nav + hamburger → slide-over drawer | Full width |

The breakpoint lives in two places that must agree: `MOBILE_BREAKPOINT_QUERY` in
`AppShell.tsx` decides which navigation renders, and the `@media (max-width:
1023px)` blocks decide the layout. Change one, change the other.

The drawer enters from the **left**, the same side the sidebar occupies on
desktop, so navigation appears in one place at every width. Drag it left or
flick to dismiss.

## Sidebar state persistence

Collapsed state is stored per user:

```
sidebar_collapsed:<publicKey>   // connected wallet
sidebar_collapsed               // signed out
```

The unscoped key is also the key the app used before scoping existed, so no
existing preference is dropped. Reads and writes are wrapped in `try/catch`:
private-mode browsers throw on storage access, and the shell falls back to an
expanded sidebar rather than failing to render.

## Accessibility

- `role="banner"` on the top nav, `role="navigation"` on the sidebar and drawer
- `aria-current="page"` on the active nav item
- `aria-expanded` on the sidebar toggle and the hamburger
- Skip-to-content link, visible on focus
- Collapsing the sidebar hides labels and group headings **visually only** —
  they stay in the accessibility tree via `.visually-hidden`
- Drawer: focus trap, restores focus on close, Escape and backdrop-click dismiss
- `prefers-reduced-motion` disables the sidebar and nav transitions

## Tests

- `AppShell.test.tsx` — shell structure, ARIA, grouping, per-wallet persistence,
  active-state matching, drawer Escape
- `MobileDrawer.test.tsx` — rendering, close paths, focus trap, nav config
- `Breadcrumb.test.tsx` — trail construction, labelling, non-navigable segments
- `TopNav.test.tsx` / `TopNav.i18n.test.tsx` — title derivation, key truncation,
  language switching
