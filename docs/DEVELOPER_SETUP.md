# Developer Setup Guide

This guide is the fastest way to get a local ai-net development environment running on a fresh machine. It covers local development, Stellar testnet funding, Freighter wallet setup, Docker-backed local Stellar nodes, and CI expectations.

## 1. Prerequisites

### macOS / Linux

- Node.js 20 LTS or newer
- npm 10+
- Git
- Docker Desktop or Docker Engine with Compose
- Optional: Stellar CLI (`stellar`), Soroban CLI (`soroban`)

### Windows

- Use Git Bash, WSL 2, or PowerShell with the same Node.js version
- Enable Docker Desktop with WSL integration
- Prefer Unix-compatible shell commands for the project scripts
- If PowerShell is used, keep environment variables in `$env:FOO` format

### Required credentials

- A Venice AI API key: https://venice.ai
- A Stellar testnet account or Friendbot-funded wallet
- Freighter wallet extension for browser-based testing

## 2. Clone and install

```bash
git clone https://github.com/Epta-Node/ai-net.git
cd ai-net
npm install
cd backend && npm install
cd ../frontend && npm install
```

## 3. Environment variables

Create backend and frontend env files from the examples if present.

```bash
cp backend/.env.example backend/.env
cp smart-contracts/.env.example smart-contracts/.env
```

Minimal backend values:

```dotenv
PORT=3000
STELLAR_NETWORK=testnet
DATABASE_URL=sqlite://./dev.db
VENICE_API_KEY=your_venice_key
```

For the frontend, most local UI flows use the browser wallet and the public testnet endpoints; keep any API base URL aligned with the backend server.

## 4. One-command builds

From the repository root:

```bash
npm --prefix backend run build
npm --prefix frontend run build
```

If you want a single script to automate the build steps, add a helper command in your shell:

```bash
npm --prefix backend run build && npm --prefix frontend run build
```

## 5. Start the local backend and frontend

### Backend

```bash
cd backend
npm run dev
```

The backend exposes the API at `http://localhost:3000` and the Swagger docs at `http://localhost:3000/docs`.

### Frontend

```bash
cd frontend
npm run dev
```

The frontend is typically available at `http://localhost:5173`.

## 6. Stellar testnet funding

Create or import a wallet in Freighter or the Stellar laboratory, then fund it with Friendbot:

```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

If you are using the Stellar CLI:

```bash
stellar keys generate --global dev-wallet
stellar account fund --network testnet --source dev-wallet
```

This gives the account enough XLM for small test transactions.

## 7. Freighter wallet setup

1. Install the Freighter extension.
2. Create or import a Stellar account.
3. Switch the network to Testnet.
4. Open the wallet and copy the public key.
5. Use that public key in the backend request headers or in the local wallet flow.
6. For browser-only flows, keep the frontend connected to the `testnet` network and make sure the wallet is unlocked.

## 8. Local Stellar node with Docker Compose

From the repository root, use the local Docker stack when you need an isolated blockchain environment:

```bash
cd docs
# use the project-provided docker-compose or service scripts if present
```

If your local setup includes a compose file, start it with:

```bash
docker compose up -d
```

The local node should expose Horizon and RPC endpoints for the project to point at in local development. Update your environment variables so the backend and smart-contract tooling target the local node instead of public testnet endpoints during local debugging.

## 9. Contract workflow

From the `smart-contracts` directory:

```bash
cd smart-contracts
npm install
./scripts/deploy.sh --network testnet
```

For CI or reproducible builds, prefer the same shell commands used in the project automation rather than ad hoc manual deployment steps.

## 10. Running the e2e suite

A fresh contributor machine should be able to run the project verification flow with:

```bash
cd backend && npm test
cd frontend && npm test
```

If the repo is configured for end-to-end verification, run the repo-local suite:

```bash
npm run test:e2e
```

## 11. CI notes

- Use Node.js 20 LTS in CI runners.
- Install dependencies before running build/test jobs.
- Export `STELLAR_NETWORK=testnet` and any Venice API credentials in the environment.
- Keep Freighter-specific browser tests behind a flag when a real wallet is required.
- Prefer deterministic `npm ci` on CI for lockfile-driven installs.

## 12. Troubleshooting

### Docker is not available

Use WSL 2 or install Docker Desktop and restart the shell before re-running the backend and smart-contract commands.

### Wallet connection fails

- Confirm the wallet is on Testnet.
- Ensure the public key is funded via Friendbot.
- Check the extension permissions and refresh the page.

### Backend cannot reach Horizon or Venice

- Confirm the network variables are set correctly.
- Test with a direct `curl` to the configured Horizon endpoint.
- Verify that the Venice key is valid and not expired.

### Windows shell quirks

Use the same commands in a Unix-like shell for backend and contract scripts; some `.sh` tooling is easier to run under Git Bash or WSL.
