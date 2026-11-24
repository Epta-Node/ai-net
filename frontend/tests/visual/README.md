# Visual regression suite

Screenshot tests for four user-facing routes, each captured in **light and dark**
theme (8 baselines total). They live apart from the functional e2e suite in
`tests/e2e/` because screenshot baselines are pixel-tied to one browser engine,
viewport, and OS — see `frontend/playwright.visual.config.ts` for the rationale.

| Command | Purpose |
| --- | --- |
| `npm run test:visual` | Verify every route against the committed baselines |
| `npm run test:visual:update` | Re-record the baselines after an intentional UI change |

Both run from `frontend/`. The first run boots Vite on
<http://localhost:3000> automatically (`webServer` in the config), so you do not
need `npm run dev` running in another terminal. The HTML report lands in
`frontend/playwright-report-visual/`.

Playwright's Chromium build is required: `npx playwright install chromium`.

## Coverage matrix

Four routes × two themes = 8 baselines, in
`pages.visual.spec.ts-snapshots/`. Every screenshot is `fullPage`, at a
1440×900 viewport.

| Route | Themes | What it covers |
| --- | --- | --- |
| `/` | light, dark | Landing page — hero, live stats bar, value props, footer |
| `/wallet` | light, dark | Wallet connect page |
| `/dashboard` | light, dark | KPI cards, task table — after the loading skeleton clears |
| `/tasks/:id` | light, dark | Task detail, incl. the WebSocket status chip in its `connected` state |

Baselines are named `<name>-visual-chromium-linux.png` — the `visual-chromium`
project name and the `linux` platform are part of the filename, so a baseline
recorded on another OS will not silently satisfy the suite.

## Interpreting a failure

A failing test writes three files under `frontend/test-results/`:

| File | Contents |
| --- | --- |
| `*-actual.png` | What this run rendered |
| `*-diff.png` | Pixel diff, changed pixels highlighted in magenta |
| `*-expected.png` | The committed baseline, copied next to the actual for convenience |

`Error: expect(page).toHaveScreenshot(expected) failed` is followed by a diff
summary, e.g.:

```
Expected an image 1280px by 2055px, received 1280px by 2728px.
888183 pixels (ratio 0.26 of all image pixels) are different.
```

Read it as three separate signals:

- **Different dimensions** means the page's *layout height* changed. Ignore the
  pixel ratio and go look at the `actual` vs `expected` images.
- **A small ratio** means a stray element moved, or a font rendered slightly
  differently.
- **A large ratio** means a real visual change — a section appeared, content
  moved, or a theme token changed.

`test-results/trace.zip` holds a Playwright trace for the failing test:
`npx playwright show-trace test-results/…/trace.zip`.

### The threshold

`expect.toHaveScreenshot.maxDiffPixelRatio` is `0.02` — up to 2% of pixels may
differ before the test fails. That absorbs anti-aliasing and font-rendering
noise between runs on the same image. Anything above 2% is treated as a genuine
visual regression. `animations: 'disabled'` is also set globally, and each test
emulates `prefers-reduced-motion: reduce` (see `utils.ts`), so CSS animation,
the landing page's particle canvas, and framer-motion springs are all frozen
before capture.

## Baselines are tied to the CI image

The committed baselines were recorded inside
`mcr.microsoft.com/playwright:v1.61.0-jammy`, which is the container the
`frontend-visual-regression` job runs in (see `.github/workflows/ci.yml`). That
is deliberate: text rendering depends on the fonts and fontconfig that ship in
the image, so a baseline recorded on a developer laptop will not match CI and
vice versa. It is also why the image tag is pinned to the `@playwright/test`
version in `package-lock.json` — **bump the tag in lockstep whenever
`@playwright/test` is upgraded, and re-record the baselines from the same
image**, because a browser upgrade re-rasterises text.

This is what makes the visual job's baselines refreshable from the same CI image
the job verifies in: because the job already runs the pinned image, a
regeneration triggered from that job produces bytes CI can reproduce, rather
than a machine-specific image that would need re-recording on every runner.

To re-record locally, run the suite inside the pinned image:

```bash
docker run --rm --network host \
  -v "$PWD":/w -w /w \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  bash -lc 'npm ci && npm run test:visual:update'
```

## When a baseline change is expected

**Update the baselines** when the change is intentional and visual:

- Restyling, spacing, colour or typography work.
- Adding, removing, or reordering a visible section.
- A copy change that alters rendered text.
- A deliberate theme-token change.

Say so in the PR description and keep the `*-actual.png` / `*-expected.png` pair
in the Playwright report, so a reviewer can see exactly what moved.

**Do not update the baselines** when the diff is a symptom of a bug. A
regression that shifts layout, hides an element, or drops a theme's contrast is
the suite doing its job — fix the code instead. Re-recording over a real
regression silently deletes the only signal that it happened.

If a diff is ambiguous, open the report and compare the two images by eye before
deciding. A one-pixel text shift on an otherwise identical page is rendering
noise; a moved card or a re-coloured button is not.

## Current status

The scripts, config, and this README are in place, but the suite does **not**
currently pass. Three defects that predate the suite's CI wiring block it, all
verified directly:

1. **The app crashes before rendering.**
   `src/components/common/Toast.tsx` renders `<CheckCircle>`, `<XCircle>`,
   `<AlertTriangle>`, and `<Info>` but never imports them from `lucide-react`.
   Every route throws `ReferenceError: CheckCircle is not defined`, so all four
   pages render blank. `tsc` reports the four missing names, which means
   `npm run build` is also failing. The fix is a one-line import.
2. **The wallet test targets an unreachable element.**
   It waits for `#secret-key-input`, but `/wallet` is wrapped in
   `ProtectedRoute` (`src/App.tsx`). An unconnected visitor is redirected to `/`,
   and a connected one renders the balance view — so the connect form's input is
   never rendered through the router. The test needs to target the connected
   view, or drive the connect flow explicitly.
3. **The baselines are stale.**
   The landing page renders 2728px tall against a 2055px baseline, and the
   dashboard and task-detail diffs are 0.29 and 0.30 — far above the 0.02
   threshold. The committed PNGs predate recent UI changes and need re-recording
   from the pinned CI image.

Until those are addressed, treat a red `frontend-visual-regression` job as
expected. The job is `continue-on-error: true` for the same reason: it is
advisory and must not block merges.
