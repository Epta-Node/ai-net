/**
 * Jest global setup — runs once before ALL test suites.
 *
 * Responsibilities:
 *  - Set required environment variables for unit tests
 *  - Log a marker so CI output is easy to grep
 *  - Deploy shared contracts (when RUN_SHARED_DEPLOY=true)
 *
 * Uses CommonJS `module.exports` because Jest's `globalSetup` runs
 * in a plain Node context before `ts-jest` transformation is applied.
 */

/** Mark CI output for easy scanning */
function logBanner(label: string): void {
  console.log(
    `\n${'═'.repeat(60)}\n  ${label}\n${'═'.repeat(60)}`
  );
}

async function setup(): Promise<void> {
  logBanner('Jest globalSetup — smart-contracts');

  // ── Environment defaults for unit tests ──────────────────────────────
  // Provide safe fallbacks so tests don't fail on missing env vars.
  // Note: individual tests that need to verify missing-key behaviour
  // delete these vars within their own scope, so this doesn't mask issues.
  if (!process.env.STELLAR_NETWORK) {
    process.env.STELLAR_NETWORK = 'testnet';
  }

  // ── Shared contract deployment (CI optimisation) ──────────────────────
  if (process.env.RUN_SHARED_DEPLOY === 'true') {
    logBanner('Deploying shared contracts');
    // When Soroban JS test utilities are wired in, deploy contracts here:
    //   const { deployContracts } = require('./fixtures/deploy');
    //   const fixtures = await deployContracts();
    //   process.env.__CONTRACT_FIXTURES__ = JSON.stringify(fixtures);
  }

  logBanner('globalSetup complete');
}

module.exports = setup;
