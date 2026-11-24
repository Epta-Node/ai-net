/**
 * Edge cases for rollout bucketing (issue #916): exact percentage boundaries,
 * stable answers per wallet, and the no-wallet and 0% / 100% extremes.
 */
import { clearRuntimeOverrides, isEnabled, rolloutBucket, upsertFlag } from './featureFlags';

const FLAG = 'design_agent';

/** Wallets with a known bucket for FLAG, found by scanning candidate keys once. */
const CANDIDATES = Array.from({ length: 5000 }, (_, i) => `G${String(i).padStart(55, 'B')}`);

function walletInBucket(bucket: number): string {
  const found = CANDIDATES.find((wallet) => rolloutBucket(FLAG, wallet) === bucket);
  if (!found) throw new Error(`no candidate wallet lands in bucket ${bucket}`);
  return found;
}

afterEach(() => {
  clearRuntimeOverrides();
});

describe('rollout boundaries', () => {
  it('enables a wallet whose bucket is below the percentage and not one at or above it', () => {
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 50 }, 'admin');

    expect(isEnabled(FLAG, { walletPublicKey: walletInBucket(49) })).toBe(true);
    expect(isEnabled(FLAG, { walletPublicKey: walletInBucket(50) })).toBe(false);
    expect(isEnabled(FLAG, { walletPublicKey: walletInBucket(51) })).toBe(false);
  });

  it('treats 49%, 50% and 51% rollouts as strictly one bucket apart', () => {
    const wallet49 = walletInBucket(49);
    const wallet50 = walletInBucket(50);

    upsertFlag(FLAG, { enabled: true, rolloutPercent: 49 }, 'admin');
    expect(isEnabled(FLAG, { walletPublicKey: wallet49 })).toBe(false);

    upsertFlag(FLAG, { enabled: true, rolloutPercent: 50 }, 'admin');
    expect(isEnabled(FLAG, { walletPublicKey: wallet49 })).toBe(true);
    expect(isEnabled(FLAG, { walletPublicKey: wallet50 })).toBe(false);

    upsertFlag(FLAG, { enabled: true, rolloutPercent: 51 }, 'admin');
    expect(isEnabled(FLAG, { walletPublicKey: wallet50 })).toBe(true);
  });

  it('keeps a wallet on the same side of a rollout across repeated evaluations', () => {
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 50 }, 'admin');
    const wallet = walletInBucket(12);

    const answers = Array.from({ length: 20 }, () => isEnabled(FLAG, { walletPublicKey: wallet }));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(true);
  });

  it('never enables a partial rollout without a wallet, at any percentage below 100', () => {
    for (const rolloutPercent of [1, 49, 50, 51, 99]) {
      upsertFlag(FLAG, { enabled: true, rolloutPercent }, 'admin');
      expect(isEnabled(FLAG)).toBe(false);
    }
  });

  it('gives an explicit allow-list entry precedence over a 0% rollout', () => {
    const wallet = walletInBucket(0);
    upsertFlag(FLAG, { enabled: true, rolloutPercent: 0, enabledWallets: [wallet] }, 'admin');

    expect(isEnabled(FLAG, { walletPublicKey: wallet })).toBe(true);
  });
});
