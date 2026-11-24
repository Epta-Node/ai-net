import { test, expect, type Page } from '@playwright/test';

// Issue #726: keyboard users must be able to bypass the nav, and client-side
// route changes must move focus and announce the new page.
//
// Unknown paths render NotFoundPage inside the AppShell without a wallet, so
// these run without seeding a session (every nav route is wallet-protected).

/** Load a path and wait for the shell to mount before driving the keyboard. */
async function openShell(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#page-title')).toBeVisible();
}

/** Client-side navigation, exactly as react-router sees a link click. */
async function clientNavigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test.describe('a11y · skip link and route focus', () => {
  test('first Tab focuses the skip link and Enter moves focus to <main>', async ({ page }) => {
    await openShell(page, '/a11y-start');

    await page.keyboard.press('Tab');
    const skipLink = page.locator('a.skip-to-content');
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('a fresh page load leaves focus alone', async ({ page }) => {
    await openShell(page, '/a11y-start');
    await expect(page.locator('#main-content')).not.toBeFocused();
    await expect(page.getByTestId('route-announcer')).toHaveText('');
  });

  test('route change focuses <main> and announces the new page', async ({ page }) => {
    await openShell(page, '/a11y-start');

    await clientNavigate(page, '/a11y-next');
    await expect(page).toHaveURL(/\/a11y-next$/);

    await expect(page.locator('#main-content')).toBeFocused();
    const title = (await page.locator('#page-title').textContent())?.trim();
    expect(title).toBeTruthy();
    await expect(page.getByTestId('route-announcer')).toHaveText(`Navigated to ${title}`);
  });
});
