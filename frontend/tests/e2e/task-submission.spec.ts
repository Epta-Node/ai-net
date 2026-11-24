import { test, expect } from '@playwright/test';

test.describe('Task Submission Wizard', () => {
  test('walks through all four steps and submits the task', async ({ page }) => {
    await page.goto('/tasks/new');

    // ── Step 1: describe goal ───────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Describe your goal' })).toBeVisible();
    await expect(page.getByLabel('Step 1: current')).toBeVisible();

    await page.fill('#prompt', 'Build a decentralized agent network testing suite.');
    await page.getByRole('button', { name: 'Next' }).click();

    // ── Step 2: choose agents/capabilities ──────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeVisible();
    // Progress indicator highlights which step is completed and which is current.
    await expect(page.getByLabel('Step 1: done')).toBeVisible();
    await expect(page.getByLabel('Step 2: current')).toBeVisible();

    await page.check('#pref-research');
    await page.check('#pref-coding');
    await page.check('#pref-report');
    await page.getByRole('button', { name: 'Next' }).click();

    // ── Step 3: review budget & live DAG preview ────────────────────────────
    await expect(page.getByRole('heading', { name: 'Review budget & DAG' })).toBeVisible();
    await page.fill('#maxBudgetXLM', '2.5');

    // The DAG preview reflects the selected agents in real time.
    const dagNodes = page.locator('#dag-preview .dag-node');
    await expect(dagNodes).toHaveCount(3);
    await expect(page.locator('#research')).toBeVisible();
    await expect(page.locator('#coding')).toBeVisible();
    await expect(page.locator('#report')).toBeVisible();

    await page.getByRole('button', { name: 'Next' }).click();

    // ── Step 4: submit ──────────────────────────────────────────────────────
    await expect(page.getByRole('heading', { name: 'Submit' })).toBeVisible();
    await page.click('#btn-submit-task');

    // Redirect to the task detail route (mock returns mock-task-e2e-123).
    await page.waitForURL('**/tasks/mock-task-e2e-123');
    expect(page.url()).toContain('/tasks/mock-task-e2e-123');

    // Detail page DAG renders the queued execution graph.
    const detailNodes = page.locator('#dag-preview .dag-node');
    await expect(detailNodes).toHaveCount(3);
    await expect(page.locator('#node-research')).toBeVisible();
    await expect(page.locator('#node-coding')).toBeVisible();
    await expect(page.locator('#node-report')).toBeVisible();
  });

  test('updates the DAG preview in real time as agent selections change', async ({ page }) => {
    await page.goto('/tasks/new');
    await page.fill('#prompt', 'Build a decentralized agent network testing suite.');
    await page.getByRole('button', { name: 'Next' }).click();

    // Start with a single agent and verify the preview shows exactly one node.
    await expect(page.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeVisible();
    await page.check('#pref-research');
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByRole('heading', { name: 'Review budget & DAG' })).toBeVisible();
    await expect(page.locator('#dag-preview .dag-node')).toHaveCount(1);
    await expect(page.locator('#research')).toBeVisible();

    // Go back, add another agent, and confirm the preview re-renders with a
    // new node and a dependency edge between the two.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeVisible();
    await page.check('#pref-coding');
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.locator('#dag-preview .dag-node')).toHaveCount(2);
    await expect(page.locator('#research')).toBeVisible();
    await expect(page.locator('#coding')).toBeVisible();
  });

  test('prevents skipping ahead to later steps on invalid input', async ({ page }) => {
    await page.goto('/tasks/new');

    // Empty goal: advancing must be blocked with inline feedback.
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Describe your goal' })).toBeVisible();
    await expect(page.getByText('Prompt is required')).toBeVisible();

    // Provide a goal but no agents: step 2 blocks advancement.
    await page.fill('#prompt', 'Build a decentralized agent network testing suite.');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Choose at least one agent')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose agents & capabilities' })).toBeVisible();
  });
});
