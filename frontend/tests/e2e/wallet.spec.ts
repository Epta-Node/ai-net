import { test, expect } from '@playwright/test';

const VALID_SECRET = 'SCEU5HVW73GXX2Y5XWXTXOBRBAHG2KNKKL2WXW2F6OFMRPGZ5EQHUDUE';
const VALID_PUBKEY = 'GDEUVS2EDX2ENN2RYHFIWJXT6XHXMOXI7EUKMU2YDF637JLJAOX4UT3J';
const VALID_DESTINATION = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';

async function mockHorizonBalance(page) {
  await page.addInitScript(() => {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input;
      if (typeof url === 'string' && url.includes('horizon-testnet.stellar.org/accounts/')) {
        return new Response(
          JSON.stringify({ balances: [{ asset_type: 'native', balance: '10000.0000000' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    };
  });
}

test.describe('Wallet Connection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/wallet');
    await page.evaluate(() => {
      localStorage.removeItem('wallet_pubkey');
      localStorage.removeItem('walletAddress');
      localStorage.removeItem('wallet_connection_method');
    });
    await page.reload();
  });

  test('fails correctly on invalid secret key input', async ({ page }) => {
    await page.fill('#secret-key-input', 'invalid-secret-key-123');
    await page.click('#btn-connect-secret-key');

    const errorEl = page.locator('#connect-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toContainText('invalid encoded string');
  });

  test('connects successfully with a valid testnet secret key', async ({ page }) => {
    await page.fill('#secret-key-input', VALID_SECRET);
    await page.click('#btn-connect-secret-key');

    const navKeyEl = page.locator('#wallet-pubkey-display');
    await expect(navKeyEl).toBeVisible({ timeout: 5000 });

    // The truncated-key shape is the real signal that a wallet is connected;
    // it also rules out the disconnected placeholder without depending on its copy.
    const navKeyText = await navKeyEl.innerText();
    expect(navKeyText).toMatch(/^G[A-Z0-9]{3}\.\.\.[A-Z0-9]{3}$/);
  });

  test('persists wallet connection after page refresh', async ({ page }) => {
    await page.fill('#secret-key-input', VALID_SECRET);
    await page.click('#btn-connect-secret-key');

    await expect(page.locator('#wallet-pubkey-display')).toBeVisible({ timeout: 5000 });
    const beforeKey = await page.locator('#wallet-pubkey-display').innerText();

    await page.reload();

    await expect(page.locator('#wallet-pubkey-display')).toBeVisible({ timeout: 5000 });
    const afterKey = await page.locator('#wallet-pubkey-display').innerText();
    expect(afterKey).toBe(beforeKey);
  });

  test('shows connect form when wallet session is cleared', async ({ page }) => {
    await page.fill('#secret-key-input', VALID_SECRET);
    await page.click('#btn-connect-secret-key');

    await expect(page.locator('#wallet-pubkey-display')).toBeVisible({ timeout: 5000 });
    expect(await page.locator('#wallet-pubkey-display').innerText()).toMatch(/^G/);

    await page.evaluate(() => {
      localStorage.removeItem('wallet_pubkey');
      localStorage.removeItem('walletAddress');
      localStorage.removeItem('wallet_connection_method');
    });
    await page.reload();

    await expect(page.locator('#secret-key-input')).toBeVisible({ timeout: 5000 });
    // Not the copy: the placeholder is translated, and what this test cares about
    // is that the display no longer shows a key.
    await expect(page.locator('#wallet-pubkey-display')).not.toHaveText(/^G[A-Z0-9]{3}\.\.\./);
  });

  test('opens confirmation modal before sending XLM', async ({ page }) => {
    await page.goto('/wallet');
    await page.evaluate((pubkey) => {
      localStorage.setItem('wallet_pubkey', pubkey);
      localStorage.setItem('walletAddress', pubkey);
      localStorage.setItem('wallet_connection_method', 'secret-key');
    }, VALID_PUBKEY);

    await page.reload();

    await mockHorizonBalance(page);
    await page.reload();

    await expect(page.locator('#wallet-pubkey-display')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#send-destination')).toBeVisible({ timeout: 5000 });

    await page.fill('#send-destination', VALID_DESTINATION);
    await page.fill('#send-amount', '1.5');

    await page.click('#btn-send-xlm');

    const modal = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(modal).toBeVisible({ timeout: 5000 });
    await expect(modal.locator('#confirm-title')).toBeVisible();
    await expect(modal.locator('#btn-confirm-payment')).toBeVisible();
    await expect(modal.locator('#btn-cancel-payment')).toBeVisible();

    await modal.locator('#btn-cancel-payment').click();
    await expect(modal).not.toBeVisible();
  });
});
