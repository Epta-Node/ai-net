import type { Page } from '@playwright/test';

export type ThemeMode = 'light' | 'dark';

/** A funded-looking Stellar testnet public key, reused across mock fixtures. */
export const MOCK_WALLET_PUBKEY = 'GBXV37U3P5SIH46YI77XQ6WPAUXF3C2EDTYO54PBYU11A7T5F2TY4S25';

/** Task id used by the visual suite; matched by the generic `/api/tasks/:id` MSW handler. */
export const MOCK_TASK_ID = 'visual-task-fixture';

/**
 * `ThemeProvider` reads `theme-mode` from `localStorage` on first render, so
 * this must run before the app's first script executes (`addInitScript`),
 * not after `page.goto()`.
 */
export async function setTheme(page: Page, mode: ThemeMode): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem('theme-mode', value);
  }, mode);
}

/**
 * Seeds the `localStorage` keys `WalletContext` reads on mount so
 * `ProtectedRoute`-gated pages (dashboard, task detail) render their real
 * layout instead of redirecting to "/". Mirrors the keys set in
 * `tests/e2e/wallet.spec.ts`.
 */
export async function mockWalletConnection(page: Page): Promise<void> {
  await page.addInitScript((pubkey) => {
    window.localStorage.setItem('wallet_pubkey', pubkey);
    window.localStorage.setItem('walletAddress', pubkey);
    window.localStorage.setItem('wallet_connection_method', 'secret-key');
    window.localStorage.setItem('wallet_wizard_completed', 'true');
  }, MOCK_WALLET_PUBKEY);
}

/**
 * `WalletPage` gates its connect form behind a first-run `WalletWizard`
 * welcome step until `wallet_wizard_completed` is set, even for a wallet
 * that isn't connected yet. The visual suite wants the actual connect form,
 * not the one-time marketing step, so this must run before the wizard's
 * first render (`addInitScript`).
 */
export async function skipWalletWizard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('wallet_wizard_completed', 'true');
  });
}

/**
 * Common stabilization for every visual test. Sets `prefers-reduced-motion:
 * reduce`, which the app already checks in a few places (e.g. the landing
 * page's particle canvas in `useParticles`, and the CSS in `global.css` /
 * `animations.css` / `micro-interactions.css`) to skip continuous motion
 * that would otherwise make screenshots non-deterministic. Combined with
 * `toHaveScreenshot`'s `animations: 'disabled'` (set globally in
 * `playwright.visual.config.ts`), this covers both CSS and JS-driven motion
 * the app is aware of.
 */
export async function preparePage(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

/**
 * A handful of mount transitions in this app run via framer-motion springs
 * or fixed-duration tweens that don't check `prefers-reduced-motion`
 * (`LandingPage`'s hero fade-in, `StatsBar`'s entrance, and the dashboard
 * KPI cards' `useAnimatedCounter` spring). None take longer than ~1s to
 * settle, so a fixed wait after `networkidle` is a simple, deterministic
 * way to make sure a screenshot is taken after they've come to rest rather
 * than mid-flight.
 */
export async function waitForMotionToSettle(page: Page, ms = 1200): Promise<void> {
  await page.waitForTimeout(ms);
}
