import { describe, expect, it } from 'vitest';
import { isValidStellarAddress, walletTransferSchema } from './wallet';

// Real account ID (public key only) so the checks run against the actual SDK
// Keypair decoder rather than a mock.
const VALID_ADDRESS = 'GCKQTK6ZM3LEH44YPTHFXMXCKEN2TDLGEEKHYPSYHME4U43WBSJNZ4Z3';

describe('isValidStellarAddress', () => {
  it('accepts a valid Stellar account ID', () => {
    expect(isValidStellarAddress(VALID_ADDRESS)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['free text', 'not-an-address'],
    ['a bad checksum', `${VALID_ADDRESS.slice(0, -1)}2`],
    ['a truncated key', VALID_ADDRESS.slice(0, -1)],
    ['a lowercased key', VALID_ADDRESS.toLowerCase()],
    ['a contract address', 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE'],
  ])('rejects %s', (_label, address) => {
    expect(isValidStellarAddress(address)).toBe(false);
  });
});

describe('walletTransferSchema destination', () => {
  it('accepts a valid address, trimming surrounding whitespace', () => {
    const parsed = walletTransferSchema.parse({
      destination: `  ${VALID_ADDRESS}  `,
      amount: 1,
    });
    expect(parsed.destination).toBe(VALID_ADDRESS);
  });

  it('rejects an invalid address with a field error', () => {
    const result = walletTransferSchema.safeParse({
      destination: 'GNOTAREALADDRESS',
      amount: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error?.flatten().fieldErrors.destination).toEqual([
      'Invalid Stellar address',
    ]);
  });
});
