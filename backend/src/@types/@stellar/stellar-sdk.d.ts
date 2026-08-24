declare module "@stellar/stellar-sdk" {
  export class Keypair {
    static fromSecret(secret: string): Keypair;
    static fromPublicKey(publicKey: string): Keypair;
    static random(): Keypair;
    publicKey(): string;
    verify(data: Buffer, signature: Buffer): boolean;
    sign(data: Buffer): Buffer;
  }

  export class Server {
    constructor(serverURL: string);
    loadAccount(publicKey: string): Promise<AccountResponse>;
    submitTransaction(tx: Transaction): Promise<HorizonResponse>;
    claimableBalances(): ClaimableBalanceCallBuilder;
  }

  export namespace Horizon {
    export class Server {
      constructor(serverURL: string);
      loadAccount(publicKey: string): Promise<AccountResponse>;
      submitTransaction(tx: Transaction): Promise<HorizonResponse>;
      claimableBalances(): ClaimableBalanceCallBuilder;
    }
  }

  export class ClaimableBalanceRecordBuilder {
    call(): Promise<ClaimableBalanceRecord>;
  }

  export class ClaimableBalanceCallBuilder {
    claimableBalance(balanceId: string): ClaimableBalanceRecordBuilder;
    forAsset(asset: Asset): ClaimableBalanceCallBuilder;
    limit(limit: number): ClaimableBalanceCallBuilder;
    call(): Promise<ClaimableBalancePage>;
    next(): Promise<ClaimableBalancePage>;
  }

  export interface ClaimableBalanceRecord {
    id: string;
    asset: string;
    amount: string;
    sponsor: string;
    claimants?: Array<{ destination: string; predicate?: unknown }>;
  }

  export interface ClaimableBalancePage {
    records: ClaimableBalanceRecord[];
    next(): Promise<ClaimableBalancePage>;
  }

  export interface AccountResponse {
    id: string;
    sequence: string;
  }

  export interface HorizonResponse {
    hash: string;
    [key: string]: unknown;
  }

  export class TransactionBuilder {
    constructor(account: AccountResponse, options: TransactionBuilderOptions);
    addOperation(op: Operation): this;
    setTimeout(timeout: number): this;
    build(): Transaction;
  }

  export interface TransactionBuilderOptions {
    fee: string;
    networkPassphrase: string;
  }

  export interface Transaction {
    sign(keypair: Keypair): void;
    getClaimableBalanceId(opIndex: number): string;
  }

  export type Operation = Record<string, unknown>;

  export const Operation: {
    createClaimableBalance(opts: {
      asset: Asset;
      amount: string;
      claimants: Claimant[];
    }): Operation;
    claimClaimableBalance(opts: { balanceId: string }): Operation;
  };

  export class Asset {
    static native(): Asset;
  }

  export class Claimant {
    constructor(destination: string, predicate: ClaimPredicate);
    static predicateUnconditional(): ClaimPredicate;
  }

  export type ClaimPredicate = Record<string, unknown>;

  export const BASE_FEE: string;

  export const Networks: {
    TESTNET: string;
    PUBLIC: string;
  };
}
