/**
 * Testnet farm client — drives the Soroban contracts on the LIVE Stellar
 * testnet via the `soroban` CLI, capturing per-operation gas diagnostics.
 *
 * Every host-side mutation is executed as a `soroban contract invoke` call and
 * measured. Gas is captured from the `--print-diag` diagnostic output, which
 * reports CPU instructions and memory instructions consumed by the invocation.
 * These values are the canonical network-side metric for gas (CU).
 *
 * The farm only runs when explicitly enabled (RUN_TESTNET_FARM=true) so it never
 * accidentally spends testnet XLM during routine unit/CI runs.
 */

import { execFile } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── Typed inputs ─────────────────────────────────────────────────────────────

export interface DeployedContracts {
  network: string;
  rpc_url: string;
  horizon_url: string;
  network_passphrase: string;
  contracts: {
    agent_registry: string;
    agent_bidding: string;
    error_registry: string;
    task_store: string;
  };
}

export interface GasMeasurement {
  operation: string;
  cpu_insns: string;
  mem_insns: string;
  fee_stroops?: number;
  committed?: boolean;
}

export interface InvokeResult {
  /** Raw CLI stdout. */
  stdout: string;
  /** Gas captured from --print-diag, or null if diagnostics unavailable. */
  gas: { cpu_insns: string; mem_insns: string } | null;
  /** Fee in stroops parsed from diagnostic output, when present. */
  feeStroops?: number;
}

// ── Config resolution ────────────────────────────────────────────────────────

/** Resolves the Soroban/Stellar CLI binary name (soroban vs stellar). */
function cliBinary(): string {
  const override = process.env.SOROBAN_CLI;
  if (override) return override;
  return process.env.SOROBAN_CLI_BIN ?? 'soroban';
}

/** Reads the deployment metadata produced by scripts/testnet-farm.sh. */
export function loadDeployedContracts(): DeployedContracts {
  const file = process.env.FARM_CONTRACT_FILE ?? resolve(__dirname, '../testnet-farm-output/deployed-contracts.json');
  if (!existsSync(file)) {
    throw new Error(`Deployment metadata not found: ${file}. Run scripts/testnet-farm.sh first.`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as DeployedContracts;
}

function rpcUrl(): string {
  const env = process.env.STELLAR_RPC_URL;
  return env ?? 'https://soroban-testnet.stellar.org';
}

function secretKey(): string {
  if (!process.env.STELLAR_SECRET_KEY) {
    throw new Error('STELLAR_SECRET_KEY is required to run the testnet farm.');
  }
  return process.env.STELLAR_SECRET_KEY;
}

// ── CLI execution ────────────────────────────────────────────────────────────

function runSoroban(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      cliBinary(),
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(`soroban failed (${error.message})\nstdout: ${stdout}\nstderr: ${stderr}`)
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      }
    );
  });
}

/**
 * Parse CPU / memory instructions from `soroban contract invoke --print-diag`
 * output. The diagnostic block reports lines like `CPU: 1000000` and
 * `Mem: 200000` (counts of instructions consumed toward the ledger budget).
 */
function parseDiag(stdout: string, stderr: string): { cpu_insns: string; mem_insns: string } | null {
  const text = `${stdout}\n${stderr}`;

  // Newer soroban-cli writes a diagnostics JSON to .soroban-diag.log or stderr:
  //   {"cost":{"cpuInsns":1234,"memInsns":5678,"inclusionFee":900}, ...}
  const costJson = text.match(/\{"cost":\{"cpuInsns":([0-9]+),"memInsns":([0-9]+)[^}]*\}/);
  if (costJson) {
    return { cpu_insns: costJson[1], mem_insns: costJson[2] };
  }

  // Classic soroban-tools `--print-diag` format.
  const cpu = text.match(/CPU:\s*([0-9]+)/);
  const mem = text.match(/Mem:\s*([0-9]+)/);
  if (!cpu && !mem) {
    const fee = text.match(/fee:\s*([0-9]+)/i);
    if (fee) {
      return { cpu_insns: '0', mem_insns: '0' };
    }
    return null;
  }
  return {
    cpu_insns: cpu ? cpu[1] : '0',
    mem_insns: mem ? mem[1] : '0',
  };
}

/**
 * Invoke a contract function on the live testnet and capture gas.
 *
 * @param contractId On-chain contract ID
 * @param fn         Function/entry point name
 * @param args       Arguments (each passed as a separate token or already-formatted
 *                   `--arg-type:value` tokens)
 * @param opts       Extra CLI flags (e.g. `--fee`)
 */
export async function invoke(
  contractId: string,
  fn: string,
  args: string[] = [],
  opts: string[] = []
): Promise<InvokeResult> {
  const diagFile = resolve(process.cwd(), '.soroban-diag.log');
  const base = [
    'contract',
    'invoke',
    '--id', contractId,
    '--source-account', secretKey(),
    '--rpc-url', rpcUrl(),
    '--print-diag',
  ];
  const full = [...base, ...opts, '--', fn, ...args];
  const { stdout, stderr } = await runSoroban(full);

  let diagnostics = parseDiag(stdout, stderr);
  if (!diagnostics) {
    try {
      if (existsSync(diagFile)) {
        const diag = readFileSync(diagFile, 'utf8');
        diagnostics = parseDiag(diag, '');
      }
    } catch {
      diagnostics = null;
    }
  }

  // Attempt to parse fee from the JSON-ish diagnostics that newer soroban-cli
  // versions print (e.g. `"cost": ..., "fee": ...`).
  let feeStroops: number | undefined;
  const combined = `${stdout}\n${stderr}`;
  const feeMatch = combined.match(/"fee"\s*:\s*"?([0-9]+)"?/);
  if (feeMatch) feeStroops = Number(feeMatch[1]);

  return { stdout, gas: diagnostics, feeStroops };
}

/**
 * Record a gas measurement into the shared farm report JSON.
 */
export function recordGas(measurement: GasMeasurement): void {
  const file = process.env.FARM_GAS_FILE ?? resolve(__dirname, '../testnet-farm-output/gas-measurements.json');
  let entries: GasMeasurement[] = [];
  if (existsSync(file)) {
    try {
      entries = JSON.parse(readFileSync(file, 'utf8')) as GasMeasurement[];
    } catch {
      entries = [];
    }
  }
  entries.push(measurement);
  writeFileSync(file, JSON.stringify(entries, null, 2));
}

/** Loads previously recorded gas measurements (for delta computation). */
export function loadGasMeasurements(): GasMeasurement[] {
  const file = process.env.FARM_GAS_FILE ?? resolve(__dirname, '../testnet-farm-output/gas-measurements.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as GasMeasurement[];
  } catch {
    return [];
  }
}
