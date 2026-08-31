import { test, expect } from '@playwright/test';
import type { WebSocketServer } from 'ws';
import {
  MOCK_TASK_ID,
  mockWalletConnection,
  preparePage,
  setTheme,
  waitForMotionToSettle,
  type ThemeMode,
} from './utils';
import { startMockTaskSocket, stopMockTaskSocket } from './mockTaskSocket';

const THEMES: ThemeMode[] = ['light', 'dark'];

test.describe('Visual regression — landing page', () => {
  for (const theme of THEMES) {
    test(`landing page renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);

      await page.goto('/');
      await expect(page.locator('h1').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`landing-${theme}.png`, { fullPage: true });
    });
  }
});

test.describe('Visual regression — wallet page', () => {
  for (const theme of THEMES) {
    test(`wallet connect page renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);

      await page.goto('/wallet');
      await expect(page.locator('#secret-key-input')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`wallet-${theme}.png`, { fullPage: true });
    });
  }
});

test.describe('Visual regression — dashboard', () => {
  for (const theme of THEMES) {
    test(`dashboard renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto('/dashboard');
      // Wait past the KPI/table skeletons so the snapshot captures the
      // loaded layout, not a transient loading state.
      await expect(page.locator('[data-testid="dashboard-skeleton"]')).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      // The KPI cards count up from 0 via a framer-motion spring; give it
      // time to settle on the fixture's totals before capturing.
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`dashboard-${theme}.png`, { fullPage: true });
    });
  }
});

test.describe('Visual regression — task detail', () => {
  let wss: WebSocketServer;

  test.beforeAll(async () => {
    wss = await startMockTaskSocket();
  });

  test.afterAll(async () => {
    await stopMockTaskSocket(wss);
  });

  for (const theme of THEMES) {
    test(`task detail renders correctly in ${theme} theme`, async ({ page }) => {
      await preparePage(page);
      await setTheme(page, theme);
      await mockWalletConnection(page);

      await page.goto(`/tasks/${MOCK_TASK_ID}`);
      await expect(page.locator('#ws-status')).toHaveAttribute('data-ws-state', 'connected');
      await expect(page.locator('[data-testid="task-detail-skeleton"]')).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      // Lets React Flow finish its post-mount fitView/measure pass.
      await waitForMotionToSettle(page);

      await expect(page).toHaveScreenshot(`task-detail-${theme}.png`, { fullPage: true });
    });
  }
});
