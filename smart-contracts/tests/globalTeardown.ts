/**
 * Jest global teardown — runs once after ALL test suites finish.
 *
 * Responsibilities:
 *  - Clean up temporary files / fixtures
 *  - Log test run summary markers
 *  - Future: tear down shared contract instances
 *
 * Uses CommonJS `module.exports` for Jest globalSetup/globalTeardown
 * compatibility.
 */

function logBanner(label: string): void {
  console.log(
    `\n${'═'.repeat(60)}\n  ${label}\n${'═'.repeat(60)}`
  );
}

async function teardown(): Promise<void> {
  logBanner('Jest globalTeardown — smart-contracts');

  // ── Future: tear down shared contract instances ───────────────────────
  // When shared deployment is active, cleanup resources here.

  logBanner('globalTeardown complete');
}

module.exports = teardown;
