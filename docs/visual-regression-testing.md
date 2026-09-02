# Frontend Visual Regression Testing

This document describes the Playwright-based visual regression suite that guards the frontend's key UI surfaces against unintentional CSS/layout changes, in both the light and dark themes.

---

## Overview

The suite lives at `frontend/tests/visual/` and is driven by its own config, `frontend/playwright.visual.config.ts`, kept separate from the functional e2e suite (`frontend/playwright.config.ts`). Screenshot baselines are tied to a single browser engine and OS rendering stack, so the visual suite runs on Chromium only — mixing it into the functional suite's Chromium+Firefox matrix would double the baselines to maintain without adding regression coverage.

Covered surfaces, each captured in `light` and `dark`:

| Surface | Route | Auth state |
|---|---|---|
| Landing page | `/` | Unauthenticated |
| Dashboard | `/dashboard` | Wallet connected (mocked) |
| Task detail | `/tasks/:id` | Wallet connected (mocked), mock WebSocket stream |
| Wallet | `/wallet` | Unauthenticated (connect form) |

The dashboard and task-detail tests seed `localStorage` (`wallet_pubkey`, `walletAddress`, `wallet_connection_method`) before the app boots so `ProtectedRoute` renders the real page instead of redirecting. The task-detail test also starts a local WebSocket listener on port 3001 (mirroring `tests/e2e/task-monitoring.spec.ts`) so the connection-status chip settles on "connected" instead of cycling through reconnect/backoff states.

Dashboard KPI and recent-task data come from two MSW handlers added to `frontend/src/mocks/handlers.ts` (`GET /api/stats`, `GET /api/wallets/:address/tasks`) so the page renders deterministic fixture data instead of an empty/error state — the dev server has no `/api/stats` backend to proxy to.

### Stabilizing screenshots

Two sources of nondeterminism are handled explicitly:

- **CSS transitions/animations** — disabled globally via `expect.toHaveScreenshot.animations: 'disabled'` in `playwright.visual.config.ts`.
- **JS-driven motion** (framer-motion) that doesn't check `prefers-reduced-motion` — the landing page's hero fade-in, the stats bar entrance, and the dashboard KPI cards' spring-animated counters. `tests/visual/utils.ts`'s `preparePage()` sets `prefers-reduced-motion: reduce` (which the app does honor in a few places, e.g. the landing page's particle canvas), and `waitForMotionToSettle()` adds a fixed post-`networkidle` wait so screenshots are taken after the remaining transitions have settled rather than mid-flight.

---

## Running locally

```bash
cd frontend
npm run test:visual
```

This starts the Vite dev server (reusing one already running on `:3000`) and runs every visual spec against it, comparing against the committed baselines under `tests/visual/*-snapshots/`.

### Updating baselines

```bash
cd frontend
npm run test:visual:update
```

Run this whenever an intentional UI change makes existing baselines stale, then review and commit the changed PNGs under `tests/visual/pages.visual.spec.ts-snapshots/`.

**Baselines must be generated on Linux with the same browser build CI uses**, or every diff will be dominated by font/anti-aliasing noise instead of the real change. If you're not on Linux (or want a guaranteed match), generate them through the pinned Playwright Docker image instead — the same image the CI job (`frontend-visual-regression` in `.github/workflows/ci.yml`) runs in:

```bash
docker run --rm -v "$(pwd)/..:/work" -w /work/frontend \
  -e TZ=UTC \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  bash -c "npm ci && npm run test:visual:update"
```

Keep the image tag in sync with the `@playwright/test` version resolved in `frontend/package-lock.json`, and with the tag pinned in `frontend-visual-regression` in `.github/workflows/ci.yml` — a mismatch reintroduces the same rendering drift this setup is meant to avoid.

### Adjusting the diff threshold

The allowed difference is `expect.toHaveScreenshot.maxDiffPixelRatio` in `frontend/playwright.visual.config.ts` (currently `0.02`, i.e. up to 2% of pixels may differ before a test fails — enough headroom for anti-aliasing jitter, not enough to hide a real layout shift). Tighten or loosen it there if it proves too strict or too lax in practice.

---

## CI reporting

The `frontend-visual-regression` job in `.github/workflows/ci.yml`:

1. Runs inside the pinned `mcr.microsoft.com/playwright` image so its rendering matches the flow above.
2. Runs `npm run test:visual`.
3. Uploads the HTML report (`frontend/playwright-report-visual/`) as the `playwright-visual-report` build artifact on every run (pass or fail) — open its `index.html` to see the expected/actual/diff image for every snapshot, including passing ones.
4. On failure, writes a pointer to that artifact into the job's step summary.

The job is `continue-on-error: true`: a visual diff is reported and visible on the PR's checks list and via the artifact, but does not block merging on its own. Treat a red run as a prompt to open the report and confirm whether the diff is an intentional UI change (update baselines) or a regression (fix the code).
