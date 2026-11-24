# ai-net Design System

The design system is driven by `frontend/src/styles/tokens.css` and exposed to Tailwind through `frontend/tailwind.config.js`. Components should consume semantic tokens instead of raw colors, radii, shadows, or spacing values.

## Token Groups

| Group | Examples | Usage |
|---|---|---|
| Surface | `--surface-canvas`, `--surface-primary`, `--surface-raised`, `--surface-overlay` | Page backgrounds, panels, popovers, scrims |
| Text | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-inverse` | Body copy, labels, metadata, text on filled accents |
| Border | `--border-primary`, `--border-subtle`, `--border-muted`, `--border-strong` | Input, panel, table, and divider borders |
| Accent | `--accent`, `--accent-info`, `--accent-text`, `--accent-surface`, `--accent-border` | Primary actions, focus states, selected states |
| Status | `--status-success-*`, `--status-warning-*`, `--status-danger-*` | Success, pending, warning, failed, destructive states |
| Agent | `--agent-research`, `--agent-risk`, `--agent-coding`, `--agent-design`, `--agent-report` | Agent labels, badges, timeline markers |
| Layout | `--space-*`, `--radius-*`, `--shadow-*`, `--focus-ring` | Component spacing, shape, elevation, focus treatment |

## Theme Model

The dark theme is defined on `:root` and `.theme-dark`; `.theme-light` overrides the same semantic variables. Components should not branch manually for light and dark themes. Prefer:

```css
.panel {
  background: var(--surface-primary);
  color: var(--text-primary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
```

Tailwind names mirror the semantic layer:

```tsx
<section className="bg-surface-primary text-text-primary border border-border-subtle rounded-lg shadow-sm">
  ...
</section>
```

## Component Conventions

Buttons use semantic accent and status tokens. Primary actions use `--gradient-primary` or `--accent`; destructive actions use `--status-danger` and `--status-danger-surface`. Disabled controls use `--text-muted` or `--text-disabled`.

Form fields use `--surface-primary`, `--border-primary`, `--focus-ring`, and status tokens for validation. Use `--radius-lg` or `--radius-xl`; avoid one-off pixel radii.

Cards are for repeated items, modals, and framed tools only. Keep card radius at `--radius-lg` or `--radius-xl`; page sections should be full-width bands or unframed layouts.

Tables, lists, timelines, and dashboards should use `--surface-*`, `--border-*`, and `--text-*` tokens for dense, scan-friendly operational UI.

Agent visuals use the `--agent-*` token set. Do not hard-code agent hex colors in components.

Shadows and glow effects use `--shadow-*`, `--glow-*`, or `--info-glow-*`. Do not add raw `rgba()` shadows in component CSS.

## Reduced motion (#721)

All `framer-motion` animation runs inside `MotionProvider`
(`frontend/src/components/common/MotionProvider.tsx`), which sets
`MotionConfig reducedMotion="user"` so page transitions, toast/notification
entrances, drawer slides, and DAG tooltips freeze automatically when the OS
requests reduced motion. Shared variants live in
`frontend/src/utils/animationPresets.ts` — do not define inline variants.

For JS-driven effects outside `motion.*`, use `useMotionSafe()` (same file)
or `usePrefersReducedMotion()` (`frontend/src/hooks/usePrefersReducedMotion.ts`)
and render the final state immediately:

```tsx
const reduced = useMotionSafe();
const display = reduced ? target : useAnimatedCounter(target);
```

CSS keyframes (toast slide-in, skeleton shimmer, status `animate-pulse` /
`animate-spin` dots) each carry a `@media (prefers-reduced-motion: reduce)`
override that disables the animation. Skeleton shimmer is decorative; the
placeholder shape stays visible.

## Review Checklist

Before merging UI changes:

1. Check new CSS/TSX for raw `#hex`, `rgb()`, `rgba()`, one-off shadow values, and arbitrary radii.
2. Confirm any remaining raw values are user content, canvas drawing internals, or a new value that belongs in `tokens.css`.
3. Verify light and dark themes inherit from the same semantic token names.
4. Prefer Tailwind semantic names over arbitrary values when the token exists.
