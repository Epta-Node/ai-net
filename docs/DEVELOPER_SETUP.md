# AI-Net Developer Onboarding & Local Setup Guide

Welcome to **AI-Net**! This guide takes you from a clean machine checkout to a fully running multi-agent platform and local/testnet development environment in under 30 minutes — even if you have never used the Stellar blockchain before.

---

## 0. Stellar Crash Course for New Contributors

Skip this section if you are already familiar with Stellar keypairs and the testnet.

### What is Stellar?

Stellar is an open-source blockchain network designed for fast, low-cost financial transactions. Think of it as a global payment rail where anyone can hold and transfer any asset — including its native currency, **XLM (Lumens)** — with transactions settling in 3-5 seconds. AI-Net uses Stellar to hold escrow payments between task submitters and AI agents: when a submitter creates a task, XLM is locked in a Claimable Balance; when the agent delivers, the coordinator releases the balance to the agent.

You do not need to understand the full Stellar protocol to contribute. The payment layer (`smart-contracts/src/payment/payment.ts`) abstracts all network calls, and the rest of the codebase interacts through typed TypeScript functions.

### What is a Keypair?

A Stellar **keypair** is a public/private key pair:

| Key | Starts with | Safe to share? | Purpose |
|---|---|---|---|
| **Public key** | `G...` (56 chars) | Yes — it is your address | Receive XLM, identify your account |
| **Secret key** | `S...` (56 chars) | **Never** — it is your password | Sign transactions; anyone who has it controls your funds |

Think of the public key as your bank account number and the secret key as your PIN. The secret key never leaves your machine.

### Why testnet? How Friendbot works

The **Stellar testnet** is a parallel copy of the network that uses fake XLM with no real value. It resets every few months. You can fund a testnet account for free through **Friendbot**, a faucet operated by the Stellar Development Foundation:

```bash
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
```

This deposits 10,000 test XLM into your account instantly — enough to run all local tests many thousands of times over.

### Freighter browser wallet — install and create a testnet account

[Freighter](https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk) is the recommended browser wallet for AI-Net's frontend:

1. Install **Freighter** from the [Chrome Web Store](https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk).
2. Open Freighter → click **Create New Wallet** → save your recovery phrase somewhere safe.
3. Go to **Settings → Network** → select **Test Net**.
4. Copy your public key (`G...`) from the main screen.
5. Fund it with Friendbot: `curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"`

Your Freighter wallet is now ready to connect to the local frontend.

---

## 1. System Prerequisites

Install the following foundational toolchains before starting:

| Tool                 | Recommended Version        | Purpose                            | Installation Guide                                                |
| -------------------- | -------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| **Node.js**          | `v20.x LTS` (or `v22.x`)   | Backend API & Next.js Frontend     | [nodejs.org](https://nodejs.org/)                                 |
| **npm**              | `v10.x+`                   | Package management                 | Included with Node.js                                             |
| **Rust & Cargo**     | `v1.80.0+`                 | Soroban Smart Contracts            | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **WASM Target**      | `wasm32-unknown-unknown`   | Compiling Rust to WebAssembly      | `rustup target add wasm32-unknown-unknown`                        |
| **Stellar CLI**      | `v21.x+`                   | Soroban contract deployments & RPC | `cargo install --locked stellar-cli --features opt`               |
| **Docker & Compose** | `v24.x+` / Compose `v2.x+` | PostgreSQL, Redis, and local node  | [docker.com](https://www.docker.com/)                             |

---

## 2. Quick Start (All-in-One Local Setup)

### Step 1: Clone Repository

```bash
git clone https://github.com/Epta-Node/ai-net.git
cd ai-net
```

### Step 2: Configure Environment Variables

Copy the example environment configurations:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
```

Default local `.env` values:

```ini
# Backend configuration (.env)
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_net_dev
REDIS_URL=redis://localhost:6379
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
VENICE_API_KEY=mock_local_key
```

### Step 3: Start Infrastructure via Docker Compose

Start PostgreSQL 16 and Redis 7 in the background:

```bash
docker-compose up -d postgres redis
```

### Step 4: Install Dependencies & Run Database Migrations

```bash
# Install root, backend, and frontend packages
npm install
cd backend && npm install && cd ../frontend && npm install && cd ..

# Run backend DB migrations
cd backend && npm run db:migrate && cd ..
```

#### Rolling back a migration

Each migration in `backend/src/db/migrations/` may end with a `-- migrate:down` section holding the SQL that reverses it. `db:rollback` reverts the newest applied migration of the consolidated database (the one `db:migrate:status` reports on); pass `--steps N` to revert more:

```bash
cd backend
npm run db:rollback               # revert the newest migration
npm run db:rollback -- --steps 2  # revert the newest two
```

A migration without a `-- migrate:down` section is irreversible. If any migration a rollback would revert is irreversible, the command exits with an error naming it and reverts nothing. Applied-state tracking lives in the `schema_migrations` table: a reverted migration's row is removed, so `npm run db:migrate:status` shows it as pending again.

The migration test suite rehearses `up -> down -> up` on a scratch in-memory database and asserts the schema is identical afterwards; it runs with the rest of the backend tests in CI (`npm run test:coverage`).

### Step 5: Start Development Servers

```bash
# In Terminal 1 — Backend API:
cd backend && npm run dev

# In Terminal 2 — Frontend Web App:
cd frontend && npm run dev
```

- **Backend API**: `http://localhost:3000` (`http://localhost:3000/health`)
- **Frontend Web App**: `http://localhost:3001` (or `http://localhost:3000`)

---

## 3. Stellar Soroban Smart Contract Development

### 3.1 Build Smart Contracts

Compile all smart contracts to optimized WebAssembly (`.wasm`):

```bash
cd smart-contracts
cargo build --target wasm32-unknown-unknown --release
```

### 3.2 Run Smart Contract Tests

Execute the Rust unit and contract invariant test suite:

```bash
cargo test
```

### 3.3 Deploy to Stellar Testnet

1. **Generate a Developer Keypair**:

   ```bash
   stellar keys generate alice --network testnet
   ```

2. **Fund Keypair via Friendbot Faucet**:

   ```bash
   stellar keys fund alice --network testnet
   # Or using curl:
   curl "https://friendbot.stellar.org?addr=$(stellar keys address alice)"
   ```

3. **Deploy Agent Registry & Escrow Contracts**:
   ```bash
   # Deploy Agent Registry
   stellar contract deploy \
     --wasm target/wasm32-unknown-unknown/release/agent_registry.wasm \
     --source alice \
     --network testnet
   ```

---

## 4. Wallet Setup (Freighter Browser Extension)

See **Section 0** for Freighter installation steps. Once installed and connected to testnet:

1. Open the frontend at `http://localhost:3001`.
2. Click **Connect Wallet** — Freighter will prompt for permission.
3. Approve the connection; your `G...` public key appears in the top-right corner.

---

## 5. Running the Automated Test Suite

AI-Net uses a multi-tier testing pipeline:

```bash
# 1. Run Backend Unit & Integration Tests:
cd backend && npm test

# 2. Run Frontend Unit Tests:
cd frontend && npm test

# 3. Run Smart Contract Tests:
cd smart-contracts && cargo test

# 4. Run End-to-End Pipeline Tests:
cd backend && npm run test:e2e
```

### Regenerating Soroban TypeScript clients

After changing a contract entrypoint, build the contracts and regenerate the
typed clients in one command:

```bash
cd smart-contracts
cargo build --locked --target wasm32v1-none --release
npm run codegen
```

The generator reads the exported contract spec from each built Wasm file and
writes marked generated files under `smart-contracts/src/generated/`. Do not
edit those files by hand. CI regenerates the clients and fails if the
committed output differs from the contract specs.

---

## 6. Operating System Quirks & Troubleshooting

### 🐧 Linux (Ubuntu / Debian / Arch / Fedora)

- **Docker permissions**: Ensure your user is in the `docker` group (`sudo usermod -aG docker $USER && newgrp docker`).
- **File Watcher Limits**: If `npm run dev` fails with `ENOSPC`, increase inotify watchers:
  ```bash
  echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p
  ```

### 🍏 macOS (Apple Silicon M1/M2/M3)

- **Rust WASM target**: Install Xcode command line tools (`xcode-select --install`).
- **Docker Colima / OrbStack**: Ensure port forwarding is enabled for `5432` and `6379`.

### 🪟 Windows (WSL2 Required)

- **Always run inside WSL2 (Ubuntu)**: Avoid running Node/Rust in native Windows CMD/PowerShell to prevent path and symlink issues.
- **Git Line Endings**: Configure autocrlf to prevent newline mismatches in bash scripts:
  ```bash
  git config --global core.autocrlf input
  ```

---

## 7. First Contribution Checklist

Work through this list top-to-bottom. Every item is a prerequisite for the next.

- [ ] **Install Node.js 20 LTS** — `node --version` prints `v20.x`
- [ ] **Install Docker and Docker Compose v2** — `docker compose version` prints `v2.x`
- [ ] **Install Rust 1.80+** — `rustc --version` prints `1.80.0` or higher
- [ ] **Add the WASM target** — `rustup target add wasm32-unknown-unknown`
- [ ] **Install Stellar CLI** — `cargo install --locked stellar-cli --features opt`
- [ ] **Clone the repo** — `git clone https://github.com/Epta-Node/ai-net.git && cd ai-net`
- [ ] **Create a testnet keypair**:
  ```bash
  stellar keys generate mydev --network testnet
  stellar keys show mydev        # prints G... public key
  stellar keys show --show-secret mydev   # prints S... secret key — keep this private
  ```
- [ ] **Fund your testnet account via Friendbot**:
  ```bash
  curl "https://friendbot.stellar.org?addr=$(stellar keys address mydev --network testnet)"
  # Response: {"hash":"..."} — your account now has 10 000 test XLM
  ```
- [ ] **Copy `.env.example` to `.env`** and fill in your keypair:
  ```bash
  cp .env.example .env
  # Edit .env:
  #   STELLAR_SECRET_KEY=S<your-56-char-secret-key>
  #   STELLAR_PUBLIC_KEY=G<your-56-char-public-key>
  #   STELLAR_COORDINATOR_SECRET=S<your-56-char-secret-key>
  #   STELLAR_COORDINATOR_PUBLIC_KEY=G<your-56-char-public-key>
  ```
- [ ] **Start Docker infrastructure** — `docker compose up -d` — wait for all containers to show `healthy`
- [ ] **Install npm dependencies** — `npm install`
- [ ] **Run the full test suite** — `npm test` — all tests green
- [ ] **Run the quality gate** — `npm run gate` — passes with zero errors
- [ ] **Make a small change** (e.g. add a comment) and open a draft PR — confirm CI goes green

Once every box is checked you are ready to pick up a `good first issue` from the issue tracker.

---

## 8. Annotated Environment Variables

Every variable in `.env.example` is documented below with its purpose, valid values, and a note on whether it is required for local development.

### Runtime mode

| Variable | Default | Required | Notes |
|---|---|---|---|
| `NODE_ENV` | `development` | Yes | `development`, `test`, or `production` |
| `PORT` | `3000` | Yes | HTTP port for the backend server |
| `LOG_LEVEL` | `info` | No | `debug`, `info`, `warn`, `error` |

### Database

| Variable | Default | Required | Notes |
|---|---|---|---|
| `DATABASE_URL` | `./data/ai-net.db` | Yes | SQLite path for local dev; PostgreSQL connection string for production |

### CORS and security

| Variable | Default | Required | Notes |
|---|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Yes | Comma-separated list of allowed CORS origins |
| `API_KEYS` | _(empty)_ | No | Comma-separated bearer tokens for API access; empty = no auth |
| `ADMIN_API_KEY` | _(empty)_ | No | Token required for `/api/admin/*` routes |

### Stellar network

| Variable | Default | Required | Notes |
|---|---|---|---|
| `STELLAR_NETWORK` | `testnet` | Yes | `testnet`, `futurenet`, or `public`. Use `testnet` for local dev. |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Yes | Horizon REST API endpoint; leave default for testnet |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Yes | Soroban RPC endpoint for contract deploys |

### Stellar keys

| Variable | Required | Notes |
|---|---|---|
| `STELLAR_COORDINATOR_SECRET` | Yes | `S...` 56-char secret key — the coordinator's signing key. **Never commit.** |
| `STELLAR_COORDINATOR_PUBLIC_KEY` | Yes | `G...` 56-char public key matching the coordinator secret |
| `STELLAR_SECRET_KEY` | Yes (tests) | Alias used by the payment test suite; same value as `STELLAR_COORDINATOR_SECRET` |
| `STELLAR_PUBLIC_KEY` | Yes (tests) | Alias used by the payment test suite; same as `STELLAR_COORDINATOR_PUBLIC_KEY` |
| `STELLAR_TEST_SECRET` | No | Additional throwaway key used in testnet integration tests |

### Venice AI

| Variable | Default | Required | Notes |
|---|---|---|---|
| `VENICE_API_KEY` | _(empty)_ | Yes | Your Venice AI API key from [venice.ai](https://venice.ai). Tests use a mock when `RUN_VENICE_INTEGRATION_TESTS=false`. |
| `VENICE_KEY_COOLDOWN_MS` | `60000` | No | How long (ms) a rate-limited key is skipped before being retried |
| `VENICE_KEY_ERROR_RATE_THRESHOLD` | `0.2` | No | Error rate (0–1) above which a key is placed into cooldown |
| `VENICE_BASE_URL` | `https://api.venice.ai/api/v1` | No | Override to point at a local Venice mock |
| `VENICE_CACHE_TTL_MS` | `86400000` | No | How long general Venice responses are cached (24 h default) |

### Caching

| Variable | Default | Required | Notes |
|---|---|---|---|
| `CACHE_DRIVER` | `lru` | No | `lru` for in-process cache; `redis` for distributed |
| `REDIS_URL` | `redis://localhost:6379` | No | Only used when `CACHE_DRIVER=redis` |

### Rate limits

| Variable | Default | Notes |
|---|---|---|
| `MAX_PROMPT_LENGTH` | `10000` | Maximum character length of a task prompt |
| `DAILY_TASK_LIMIT_PER_WALLET` | `100` | Maximum tasks a single wallet can submit per day |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window (ms) for request rate limiting |
| `RATE_LIMIT_MAX_REQUESTS` | `20` | Maximum requests per window per IP |

### Payment reconciliation

| Variable | Default | Notes |
|---|---|---|
| `RECONCILIATION_INTERVAL_MS` | `60000` | How often the reconciliation daemon runs (60 s) |
| `RECONCILIATION_REMEDIATION_ENABLED` | `true` | Enables automatic refund of expired locked escrows |
| `RECONCILIATION_ESCROW_EXPIRY_MS` | `86400000` | Age (ms) after which a locked escrow on a failed task is refunded (24 h) |
| `RECONCILIATION_WARNING_DRIFT_PERCENT` | `1` | Drift percentage that triggers a warning alert |
| `RECONCILIATION_CRITICAL_DRIFT_PERCENT` | `5` | Drift percentage that triggers a critical alert and webhook call |
| `RECONCILIATION_WEBHOOK_URL` | _(empty)_ | URL that receives a POST when a critical drift is detected |

### Feature flags (opt-in integration tests)

| Variable | Default | Notes |
|---|---|---|
| `RUN_STELLAR_E2E_TESTS` | `false` | Set `true` to run tests that hit the live Stellar testnet |
| `RUN_STELLAR_INTEGRATION_TESTS` | `false` | Set `true` to run Horizon integration tests |
| `RUN_VENICE_INTEGRATION_TESTS` | `false` | Set `true` to run Venice AI integration tests (requires a valid `VENICE_API_KEY`) |
