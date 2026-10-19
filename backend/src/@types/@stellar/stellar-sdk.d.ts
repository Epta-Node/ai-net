declare module '@stellar/stellar-sdk' {
  export class Keypair {
    static fromSecret(secret: string): Keypair;
    static fromPublicKey(publicKey: string): Keypair;
    static random(): Keypair;
    publicKey(): string;
    verify(data: Buffer, signature: Buffer): boolean;
    sign(data: Buffer): Buffer;
  }

  export class NotFoundError extends Error {}

  export class Memo {
    static text(text: string): Memo;
    static hash(data: Buffer | string): Memo;
    static id(id: string): Memo;
    toXDRObject(): unknown;
  }

  export class Server {
    constructor(serverURL: string);
    loadAccount(publicKey: string): Promise<AccountResponse>;
    submitTransaction(tx: Transaction): Promise<HorizonResponse>;
    claimableBalances(): ClaimableBalanceCallBuilder;
    transactions(): TransactionCallBuilder;
    fetchBaseFee(): Promise<number>;
  }

  export namespace Horizon {
    export class Server {
      constructor(serverURL: string);
      loadAccount(publicKey: string): Promise<AccountResponse>;
      submitTransaction(tx: Transaction): Promise<HorizonResponse>;
      claimableBalances(): ClaimableBalanceCallBuilder;
      transactions(): TransactionCallBuilder;
      fetchBaseFee(): Promise<number>;
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

  /**
   * Transaction call builder.
   *
   * `forClaimableBalance` is what lets reconciliation find the transaction that
   * actually claimed an escrow, which is the authoritative proof that a
   * `released` payment really moved on-chain (issue #496).
   */
  export class TransactionCallBuilder {
    forAccount(accountId: string): TransactionCallBuilder;
    forClaimableBalance(balanceId: string): TransactionCallBuilder;
    forSigner(accountId: string): TransactionCallBuilder;
    order(direction: 'asc' | 'desc'): TransactionCallBuilder;
    limit(limit: number): TransactionCallBuilder;
    call(): Promise<TransactionPage>;
    transaction(hash: string): TransactionRecordBuilder;
  }

  export class TransactionRecordBuilder {
    call(): Promise<TransactionRecord>;
  }

  export interface TransactionRecord {
    hash: string;
    successful: boolean;
    ledger?: number;
    ledger_seq?: number;
    source_account: string;
  }

  export interface TransactionPage {
    records: TransactionRecord[];
    next(): Promise<TransactionPage>;
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
    addMemo(memo: Memo): this;
    setTimeout(timeout: number): this;
    build(): Transaction;
  }

  export interface TransactionBuilderOptions {
    fee: string;
    networkPassphrase: string;
  }

  export class Transaction {
    constructor(envelopeXdr: string, networkPassphrase?: string);
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
    payment(opts: {
      source?: string;
      destination: string;
      asset: Asset;
      amount: string;
      memo?: Memo;
    }): Operation;
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
