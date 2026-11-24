import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";

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
    .min(1, "Destination address is required")
    .refine(isValidStellarAddress, "Invalid Stellar address"),
  amount: z.preprocess((value) => {
    if (typeof value === "string") {
      return Number(value);
    }
    return value;
  }, z.number().positive("Amount must be a positive number")),
  memo: z.string().max(28, "Memo must be 28 characters or less").optional(),
});

export function walletTransferSchemaWithBalance(
  balance: number,
  message: string,
) {
  return walletTransferSchema.superRefine(({ amount }, context) => {
    if (Number.isFinite(balance) && amount > balance) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message,
      });
    }
  });
}

export type WalletTransferValues = z.infer<typeof walletTransferSchema>;
