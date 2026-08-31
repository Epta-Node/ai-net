import { z } from 'zod';
import { Keypair } from '@stellar/stellar-sdk';

export function isValidStellarAddress(address: string): boolean {
  try {
    Keypair.fromPublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export const walletTransferSchema = z.object({
  destination: z
    .string()
    .trim()
    .min(1, 'Destination address is required')
    .refine(isValidStellarAddress, 'Invalid Stellar address. Must start with G and be 56 characters.'),
  amount: z
    .preprocess((value) => {
      if (typeof value === 'string') {
        return Number(value);
      }
      return value;
    }, z.number().min(0.0000001, 'Amount must be a positive number')),
  memo: z.string().max(28, 'Memo must be 28 characters or less').optional(),
});

export type WalletTransferValues = z.infer<typeof walletTransferSchema>;
