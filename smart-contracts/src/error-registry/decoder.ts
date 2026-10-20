/**
 * Generated TypeScript decoder for error-registry contract error definitions.
 *
 * Decodes XDR-encoded ErrorDefinition values returned by the error-registry
 * contract so off-chain clients can resolve error codes to human-readable
 * messages without an additional on-chain call to the error-resolver.
 *
 * Usage:
 *   import { decodeErrorCode, loadErrorDefinitions } from './decoder';
 *
 *   const defs = await loadErrorDefinitions(server, contractId);
 *   const msg  = decodeErrorCode(defs, 7);
 *   // => "Unauthorized: caller does not hold admin role"
 */

import { Contract, SorobanRpc, xdr } from "@stellar/stellar-sdk";

// ── Types mirroring the on-chain contracttype structs ──────────────────────

export type ErrorSeverity = "Info" | "Warning" | "Error" | "Fatal";

export interface ErrorDefinition {
  code: number;
  contract: string;
  name: string;
  messageTemplate: string;
  severity: ErrorSeverity;
}

export interface ErrorDefinitionSet {
  contract: string;
  definitions: ErrorDefinition[];
  schemaVersion: number;
}

// ── XDR → TS conversion helpers ────────────────────────────────────────────

/**
 * Decode a single ErrorDefinition from an XDR ScVal map.
 * The map must match the field order produced by #[contracttype] derive.
 */
export function decodeErrorDefinition(scVal: xdr.ScVal): ErrorDefinition {
  if (scVal.switch() !== xdr.ScValType.scvMap()) {
    throw new Error(`Expected scvMap, got ${scVal.switch().name}`);
  }

  const map = scVal.map() ?? [];
  const get = (key: string): xdr.ScVal => {
    const entry = map.find(
      (e) =>
        e.key().switch() === xdr.ScValType.scvSymbol() &&
        e.key().sym().toString() === key,
    );
    if (!entry) throw new Error(`Missing field '${key}' in ErrorDefinition`);
    return entry.val();
  };

  const severityMap: Record<number, ErrorSeverity> = {
    0: "Info",
    1: "Warning",
    2: "Error",
    3: "Fatal",
  };

  const severityVal = get("severity");
  const severityOrdinal =
    severityVal.switch() === xdr.ScValType.scvU32()
      ? severityVal.u32()
      : Number(severityVal.i128()?.lo()?.toBigInt() ?? 0);

  return {
    code: get("code").u32(),
    contract: get("contract").address().accountId().toString(),
    name: get("name").sym().toString(),
    messageTemplate: Buffer.from(get("message_template").bytes()).toString(
      "utf8",
    ),
    severity: severityMap[severityOrdinal] ?? "Error",
  };
}

/**
 * Decode an ErrorDefinitionSet returned by `get_error_definitions`.
 */
export function decodeErrorDefinitionSet(scVal: xdr.ScVal): ErrorDefinitionSet {
  if (scVal.switch() !== xdr.ScValType.scvMap()) {
    throw new Error(`Expected scvMap for ErrorDefinitionSet`);
  }

  const map = scVal.map() ?? [];
  const get = (key: string): xdr.ScVal => {
    const entry = map.find(
      (e) =>
        e.key().switch() === xdr.ScValType.scvSymbol() &&
        e.key().sym().toString() === key,
    );
    if (!entry)
      throw new Error(`Missing field '${key}' in ErrorDefinitionSet`);
    return entry.val();
  };

  const defsVec = get("definitions");
  const definitions =
    defsVec.switch() === xdr.ScValType.scvVec()
      ? (defsVec.vec() ?? []).map(decodeErrorDefinition)
      : [];

  return {
    contract: get("contract").address().accountId().toString(),
    definitions,
    schemaVersion: get("schema_version").u32(),
  };
}

// ── High-level API ─────────────────────────────────────────────────────────

/**
 * Fetch all ErrorDefinition entries for a given contract from the registry.
 *
 * @param server     Soroban RPC server instance
 * @param registryId Contract ID of the deployed error-registry
 * @param targetId   Contract ID whose error definitions to fetch
 */
export async function loadErrorDefinitions(
  server: SorobanRpc.Server,
  registryId: string,
  targetId: string,
): Promise<ErrorDefinitionSet> {
  const contract = new Contract(registryId);
  const tx = contract.call(
    "get_error_definitions",
    xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeContract(
        Buffer.from(targetId.replace(/^C/, ""), "hex"),
      ),
    ),
  );

  const result = await server.simulateTransaction(tx as never);
  if (!("result" in result) || !result.result?.retval) {
    throw new Error("Simulation failed or returned no retval");
  }

  return decodeErrorDefinitionSet(result.result.retval);
}

/**
 * Resolve an error code to a human-readable message using a pre-loaded set.
 *
 * @param set   ErrorDefinitionSet loaded via `loadErrorDefinitions`
 * @param code  Numeric error code emitted by the contract
 * @returns     Message template string, or a generic fallback.
 */
export function decodeErrorCode(
  set: ErrorDefinitionSet,
  code: number,
): string {
  const def = set.definitions.find((d) => d.code === code);
  if (!def) return `Unknown error code ${code}`;
  return `[${def.severity}] ${def.name}: ${def.messageTemplate}`;
}

/**
 * Build a lookup map from error code → ErrorDefinition for O(1) access.
 */
export function buildErrorIndex(
  set: ErrorDefinitionSet,
): Map<number, ErrorDefinition> {
  return new Map(set.definitions.map((d) => [d.code, d]));
}
