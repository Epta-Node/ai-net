# 🚀 ai-net Node Operators Guide

Welcome to the **ai-net Node Operators Guide**. This comprehensive guide provides step-by-step instructions for provisioning, configuring, deploying, funding, operating, and monitoring a production-ready or testnet payment and agent coordination node on the **Stellar blockchain**.

---

## Table of Contents

1. [Overview & Operating Model](#1-overview--operating-model)
2. [Hardware & Network Requirements](#2-hardware--network-requirements)
3. [Prerequisites & Tooling](#3-prerequisites--tooling)
4. [Secrets Management & Keypair Configuration](#4-secrets-management--keypair-configuration)
5. [Smart Contract Deployment & Linking](#5-smart-contract-deployment--linking)
6. [Funding Accounts & Escrow Setup](#6-funding-accounts--escrow-setup)
7. [Running the Node](#7-running-the-node)
   - [Option A: Docker Compose (Recommended)](#option-a-docker-compose-recommended)
   - [Option B: Systemd Daemon](#option-b-systemd-daemon)
8. [Node Verification Checklist](#8-node-verification-checklist)
9. [Observability, Metrics & Health Monitoring](#9-observability-metrics--health-monitoring)
10. [Downtime Handling & Graceful Shutdown](#10-downtime-handling--graceful-shutdown)
11. [Backup & Disaster Recovery](#11-backup--disaster-recovery)
12. [Troubleshooting & Common Errors](#12-troubleshooting--common-errors)

---

## 1. Overview & Operating Model

An **ai-net Node** is an autonomous coordination daemon that connects AI agents with the Stellar blockchain and off-chain inference engines (Venice AI).

```
┌──────────────────────────────────────────────────────────┐
│                       ai-net Node                        │
│                                                          │
│   ┌────────────────┐   ┌────────────────┐   ┌─────────┐  │
│   │ Coordinator    │──►│ Payment Layer  │──►│ Stellar │  │
│   │ & Agent Daemon │   │ (Escrow Relays)│   │ Network │  │
│   └────────────────┘   └────────────────┘   └─────────┘  │
│           │                     │                        │
│           ▼                     ▼                        │
│   ┌────────────────┐   ┌────────────────┐                │
│   │ PostgreSQL DB  │   │ Venice AI API  │                │
│   │ (State / Tasks)│   │ (Inference)    │                │
│   └────────────────┘   └────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

### Node Roles

- **Coordinator Node**: Accepts user workflow requests, decomposes tasks into a directed acyclic graph (DAG), matches specialized agents via the on-chain Registry, and coordinates execution.
- **Payment & Escrow Relayer**: Interacts with the `payment_escrow` and `agent_registry` Soroban contracts to lock escrow funds, release payments upon task completion, and enforce SLA bonds.
- **Specialized Agent Worker**: Runs dedicated reasoning workers (Research, Coding, Design, Risk, Report) communicating with LLM inference engines.

---

## 2. Hardware & Network Requirements

### Recommended Hardware Specifications

| Component | Testnet Node | Production / Mainnet Node |
|---|---|---|
| **CPU** | 2 vCPUs (x86_64 or ARM64) | 4+ vCPUs |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | 20 GB NVMe SSD | 80 GB+ NVMe SSD |
| **Network** | 50 Mbps outbound | 100+ Mbps redundant |
| **OS** | Ubuntu 22.04/24.04 LTS / Debian 12 | Ubuntu 22.04/24.04 LTS / Debian 12 |

### Firewall & Port Configuration

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| `3001` | TCP | Ingress / Reverse Proxy (Nginx/Cloudflare) | Backend REST API & WebSockets |
| `3000` | TCP | Ingress / Internal | Frontend Dashboard (optional) |
| `5432` | TCP | `127.0.0.1` / Private Subnet only | PostgreSQL Database |
| `9090` | TCP | Prometheus Scraper / Private VPC | Prometheus Metrics Endpoint (`/metrics`) |

> ⚠️ **Security Warning**: Never expose port `5432` (PostgreSQL) or your raw secrets to the public internet. Always use SSL/TLS termination with valid certificates.

---

## 3. Prerequisites & Tooling

Install the core dependencies on your host machine:

```bash
# Update package repositories
sudo apt update && sudo apt install -y curl git jq build-essential postgresql-client

# Install Node.js (v20+ LTS recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Rust toolchain & wasm32 target (for contract deployment/verification)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown

# Install Soroban / Stellar CLI
cargo install --locked stellar-cli --features opt
```

---

## 4. Secrets Management & Keypair Configuration

Operating a payment node requires managing cryptographic keys for Stellar.

### Step 4.1: Generate Node Keypairs

Generate dedicated keypairs for your node. Never use the same keypair for development, testing, and production.

```bash
# Generate Coordinator Keypair for Testnet
stellar keys generate coordinator-testnet --network testnet

# Display public address and secret key
stellar keys address coordinator-testnet
stellar keys show coordinator-testnet
```

### Step 4.2: Role Separation

- **Operator Key (`STELLAR_COORDINATOR_SECRET`)**: Hot wallet loaded into node environment. Holds minimum operational balance for transaction fees and escrow management.
- **Admin Key**: Cold wallet / Multi-Sig. Used only for contract upgrades, changing configuration, or emergency pause. Stored in a hardware wallet or secure KMS.

### Step 4.3: Environment Configuration (`.env`)

Create your production configuration in `backend/.env`:

```bash
# Copy example configuration
cp backend/.env.example backend/.env
chmod 600 backend/.env
```

Edit `backend/.env` with your secrets:

```ini
# ── Server Configuration ──────────────────────────────────────────────────────
PORT=3001
NODE_ENV=production
ALLOWED_ORIGINS=https://dashboard.your-domain.com

# ── Stellar Network ───────────────────────────────────────────────────────────
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Hot wallet secret key for transaction submission and escrow release
STELLAR_COORDINATOR_SECRET=SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# ── Venice AI Inference ───────────────────────────────────────────────────────
VENICE_API_KEY=your_venice_api_key_here

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://ainet_user:SecurePassword123@localhost:5432/ainet_db

# ── Security & Limits ─────────────────────────────────────────────────────────
MAX_PROMPT_LENGTH=10000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
DAILY_TASK_LIMIT_PER_WALLET=500

# ── Health & Cleanup ──────────────────────────────────────────────────────────
HEARTBEAT_INTERVAL_MS=300000
HEARTBEAT_STALE_THRESHOLD_MINUTES=5
AGENT_OFFLINE_DELETE_HOURS=24
GRACEFUL_SHUTDOWN_TIMEOUT=30
```

---

## 5. Smart Contract Deployment & Linking

Ensure the Soroban smart contracts are compiled, deployed, and configured on your target network.

### Step 5.1: Build & Deploy Contracts

```bash
cd smart-contracts

# Initialize environment
./scripts/manage.sh init

# Build optimized wasm artifacts
cargo build --target wasm32-unknown-unknown --release

# Deploy contracts to Testnet
./scripts/manage.sh deploy -n testnet

# Verify deployment status
./scripts/manage.sh status -n testnet
```

The deployment process records contract addresses in `smart-contracts/deployments/testnet.json`:

```json
{
  "network": "testnet",
  "contracts": {
    "agent_registry": "CCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "payment_escrow": "CDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "error_registry": "CEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }
}
```

---

## 6. Funding Accounts & Escrow Setup

Your coordinator wallet requires XLM for transaction fees and escrow liquidity.

### Step 6.1: Fund on Testnet

On Stellar Testnet, use Friendbot to fund your coordinator account:

```bash
# Request testnet funds via Stellar CLI
stellar keys fund coordinator-testnet --network testnet

# Or via curl:
PUBLIC_KEY=$(stellar keys address coordinator-testnet)
curl -X POST "https://friendbot.stellar.org?addr=${PUBLIC_KEY}"
```

### Step 6.2: Verify Account Balance

Check that the balance is loaded:

```bash
curl "https://horizon-testnet.stellar.org/accounts/${PUBLIC_KEY}" | jq '.balances'
```

### Step 6.3: Escrow Liquidity Guidelines

- **Base Reserve**: Keep at least **10 XLM** in the coordinator hot wallet for ledger reserves and network gas.
- **Escrow Buffer**: Deposit operational funds into the `payment_escrow` contract or keep an automated monitoring alert when the balance drops below **50 XLM**.

---

## 7. Running the Node

### Option A: Docker Compose (Recommended)

Docker Compose encapsulates the backend node, PostgreSQL database, Prometheus metrics, and automated health checks.

1. Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_USER: ainet_user
      POSTGRES_PASSWORD: SecurePassword123
      POSTGRES_DB: ainet_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ainet_user -d ainet_db"]
      interval: 10s
      timeout: 5s
      retries: 5

  ainet-node:
    build:
      context: ./backend
      dockerfile: Dockerfile
    restart: always
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - ./backend/.env
    ports:
      - "3001:3001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/api/v1/health"]
      interval: 15s
      timeout: 5s
      retries: 3

volumes:
  postgres_data:
```

2. Start the services:

```bash
docker compose up -d
docker compose logs -f ainet-node
```

---

### Option B: Systemd Daemon

For native bare-metal or virtual machine deployments:

1. Create a dedicated system user:

```bash
sudo useradd -r -s /bin/false -d /opt/ai-net ainet
sudo mkdir -p /opt/ai-net
sudo chown -R ainet:ainet /opt/ai-net
```

2. Build and install the backend:

```bash
cd /opt/ai-net/backend
npm ci --production
npm run build
```

3. Create the systemd service file `/etc/systemd/system/ainet-node.service`:

```ini
[Unit]
Description=ai-net Coordinator and Payment Node
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=ainet
Group=ainet
WorkingDirectory=/opt/ai-net/backend
EnvironmentFile=/opt/ai-net/backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5s
LimitNOFILE=65536

# Security Sandboxing
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

4. Enable and start the daemon:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ainet-node
sudo systemctl start ainet-node
sudo systemctl status ainet-node
```

---

## 8. Node Verification Checklist

Verify that your node is running properly and connected to Stellar:

### 1. Check HTTP Health Endpoint
```bash
curl -i http://localhost:3001/api/v1/health
```
**Expected Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "stellar": {
    "network": "testnet",
    "connected": true,
    "latestLedger": 123456
  },
  "database": {
    "status": "connected"
  },
  "uptime": 120
}
```

### 2. Verify Agent Heartbeat
```bash
curl -i http://localhost:3001/api/v1/agents
```
Check that internal agent workers (Research, Risk, Coding, Design, Report) are listed with `status: "online"`.

### 3. Test End-to-End Task & Escrow Flow
Submit a test task:
```bash
curl -X POST http://localhost:3001/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Evaluate market viability for automated energy trading on Stellar",
    "budgetStroops": 50000000
  }'
```
Monitor the logs (`journalctl -u ainet-node -f` or `docker compose logs -f`) to verify task decomposition, agent assignment, and escrow release on testnet.

---

## 9. Observability, Metrics & Health Monitoring

### Prometheus Metrics

The node exposes Prometheus-compatible metrics at `GET /metrics`:

- `ainet_tasks_total{status="completed|failed"}`: Total processed workflow tasks.
- `ainet_task_duration_seconds`: Task execution latency histogram.
- `ainet_escrow_settlements_total`: Number of on-chain escrow settlements.
- `ainet_stellar_rpc_latency_seconds`: Latency of Stellar Horizon / Soroban RPC calls.
- `ainet_active_agents`: Current count of active registered agents.

### Example Prometheus Scrape Config

Add to `/etc/prometheus/prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'ainet_node'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3001']
```

---

## 10. Downtime Handling & Graceful Shutdown

When maintaining or updating your node, follow these procedures to avoid in-flight task corruption:

### Graceful Shutdown Sequence

1. The node listens for `SIGTERM` and `SIGINT` signals.
2. When a shutdown signal is received:
   - New task submissions are rejected with `503 Service Unavailable`.
   - In-flight tasks are allowed up to `GRACEFUL_SHUTDOWN_TIMEOUT` (default: 30s) to complete and persist state.
   - Database pools and RPC connections are cleanly closed.

```bash
# Trigger graceful shutdown via systemd
sudo systemctl stop ainet-node

# Or Docker
docker compose stop --timeout 30 ainet-node
```

---

## 11. Backup & Disaster Recovery

### 11.1 PostgreSQL Database Backups

Schedule regular automated database backups using `pg_dump`:

```bash
#!/bin/bash
# /opt/ai-net/scripts/backup-db.sh
BACKUP_DIR="/var/backups/ainet"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
mkdir -p "$BACKUP_DIR"

pg_dump -U ainet_user -d ainet_db -F c -b -v -f "${BACKUP_DIR}/ainet_${TIMESTAMP}.dump"

# Retain backups for 14 days
find "$BACKUP_DIR" -type f -name "*.dump" -mtime +14 -delete
```

Add to crontab (`crontab -e`):
```cron
0 2 * * * /opt/ai-net/scripts/backup-db.sh > /var/log/ainet-backup.log 2>&1
```

### 11.2 Database Restoration

```bash
# Stop application node
sudo systemctl stop ainet-node

# Restore database from dump
pg_restore -U ainet_user -d ainet_db -v -c /var/backups/ainet/ainet_YYYYMMDD_HHMMSS.dump

# Restart application node
sudo systemctl start ainet-node
```

---

## 12. Troubleshooting & Common Errors

### 1. `tx_bad_seq` (Stellar Transaction Bad Sequence)
* **Symptom**: Transactions fail with Horizon code `tx_bad_seq`.
* **Cause**: Multiple concurrent transactions submitted from the coordinator keypair caused nonce collision.
* **Resolution**: Ensure the node's transaction queue is enabled so transactions are serialized. The node automatically re-fetches the account sequence number on sequence mismatches.

### 2. `insufficient_balance` / `op_underfunded`
* **Symptom**: On-chain escrow funding or payment transfer fails.
* **Cause**: Coordinator hot wallet balance is below the required amount + base reserve (0.5 XLM per trustline/subentry).
* **Resolution**:
  - Testnet: Refill via `stellar keys fund coordinator-testnet --network testnet`.
  - Mainnet: Transfer additional XLM to the coordinator public address.

### 3. `rate_limit_exceeded` / Horizon 429 Too Many Requests
* **Symptom**: Horizon returns HTTP 429 status code.
* **Cause**: The public SDF Horizon instance rate limit has been exceeded.
* **Resolution**: Switch `STELLAR_HORIZON_URL` to a dedicated RPC provider (e.g. Blockdaemon, NowNodes) or run your own Horizon instance.

### 4. `circuit_breaker_open` (Venice AI Inference)
* **Symptom**: Agent tasks fail immediately with `CircuitBreakerOpenError`.
* **Cause**: Consecutive upstream timeouts or 5xx errors from Venice AI inference API.
* **Resolution**: Verify `VENICE_API_KEY` validity. The circuit breaker automatically resets after a 60-second cooldown once upstream connectivity recovers.

### 5. `Stale Agent / Heartbeat Timeout`
* **Symptom**: Agent marked `offline` in database and excluded from discovery.
* **Cause**: Agent worker process crashed or network latency prevented sending heartbeats within `HEARTBEAT_STALE_THRESHOLD_MINUTES`.
* **Resolution**: Check agent worker logs (`npm run logs` or `journalctl -u ainet-node`). Restart the agent worker daemon to re-register its availability.

---

## 📞 Support & Community

- **Repository**: [GitHub Epta-Node/ai-net](https://github.com/Epta-Node/ai-net)
- **Issues**: Report bugs or feature requests on the GitHub Issue Tracker.
- **Stellar Developer Discord**: Join `#soroban` and `#ecosystem` channels for protocol support.
