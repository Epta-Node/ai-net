# 🛠️ AI-Net Developer Onboarding & Local Setup Guide

Welcome to **AI-Net**! This guide takes you from a clean machine checkout to a fully running multi-agent platform and local/testnet development environment in minutes.

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

To test the frontend with on-chain payments:

1. Install the **[Freighter Wallet Extension](https://www.freighter.app/)** for Chrome / Firefox / Brave.
2. In Freighter Settings, toggle the network to **Testnet**.
3. Copy your public key (`G...`) and fund it using Friendbot:
   ```bash
   curl "https://friendbot.stellar.org?addr=<YOUR_FREIGHTER_PUBLIC_KEY>"
   ```
4. Connect Freighter to the frontend at `http://localhost:3001`.

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

All development on Windows must run inside **WSL2**. Native CMD or PowerShell will produce path, symlink, and permission errors that are not supported.

#### Step 1 — Enable WSL2 and Install Ubuntu

Open **PowerShell as Administrator** and run:

```powershell
# Enable WSL and Virtual Machine Platform features
wsl --install

# If wsl --install is unavailable on older Windows 10 builds, enable manually:
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

# After reboot, set WSL 2 as default
wsl --set-default-version 2

# Install Ubuntu 22.04 LTS
wsl --install -d Ubuntu-22.04
```

After installation, launch **Ubuntu** from the Start Menu and complete the initial user setup (username + password). Verify WSL2 is active:

```powershell
wsl -l -v
# Expected output:
#   NAME            STATE           VERSION
#   Ubuntu-22.04    Running         2
```

#### Step 2 — Install Docker Desktop with WSL2 Backend

1. Download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/).
2. During installation, ensure **"Use WSL 2 based engine"** is checked.
3. After installation, open Docker Desktop → **Settings → Resources → WSL Integration**.
4. Enable integration for your Ubuntu distribution.
5. Verify from inside WSL2:

```bash
docker --version
docker compose version
```

> **Important**: Never run `docker` from PowerShell for this project. Always use the WSL2 terminal.

#### Step 3 — Install Node.js inside WSL2

Install Node.js v20 LTS using `nvm` inside the WSL2 Ubuntu shell:

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Reload shell
source ~/.bashrc

# Install and use Node.js 20 LTS
nvm install 20
nvm use 20
nvm alias default 20

# Verify
node --version   # v20.x.x
npm --version    # 10.x.x
```

#### Step 4 — Install Rust and Stellar CLI inside WSL2

```bash
# Install Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Add WASM compilation target
rustup target add wasm32-unknown-unknown

# Install Stellar CLI
cargo install --locked stellar-cli --features opt

# Verify
stellar --version
```

#### Step 5 — Clone and Configure the Repository

Work entirely within the WSL2 filesystem. Cloning into a Windows-mounted path (e.g. `/mnt/c/...`) causes severe I/O performance degradation and inotify watch failures.

```bash
# Clone into the WSL2 home directory — not under /mnt/c
cd ~
git clone https://github.com/Epta-Node/ai-net.git
cd ai-net
```

Configure Git line endings to prevent CRLF corruption in shell scripts:

```bash
git config --global core.autocrlf input
git config --global core.eol lf
```

#### Step 6 — Fix Windows Path Length Limits

Windows enforces a 260-character path limit that breaks deep `node_modules` trees. Enable long paths in PowerShell (run as Administrator):

```powershell
# Enable long path support in Windows registry
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force

# Enable long paths in Git
git config --system core.longpaths true
```

#### Step 7 — Run the Full Setup

From inside WSL2:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

npm install
cd backend && npm install && npm run db:migrate && cd ..
cd frontend && npm install && cd ..

# Start infrastructure
docker compose up -d postgres redis

# Start dev servers
cd backend && npm run dev &
cd frontend && npm run dev
```

#### Common Windows / WSL2 Issues

| Symptom                               | Cause                               | Fix                                                                                             |
| ------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ENOENT` or `EACCES` on `npm install` | Running from `/mnt/c/` Windows path | Re-clone into WSL2 home (`~/ai-net`)                                                            |
| `inotify` watch limit exceeded        | Low default limit                   | Run `echo fs.inotify.max_user_watches=524288 \| sudo tee -a /etc/sysctl.conf && sudo sysctl -p` |
| Docker commands not found in WSL2     | WSL integration disabled            | Enable Ubuntu integration in Docker Desktop → Settings → WSL Integration                        |
| `\r` or `^M` characters in scripts    | CRLF line endings                   | Run `git config --global core.autocrlf input` and re-checkout files                             |
| Rust/cargo slow on `/mnt/c/`          | Windows filesystem overhead         | Always build from the WSL2 native filesystem (`~/`)                                             |
| Port `3000` already in use            | Windows process occupying port      | From PowerShell: `netstat -ano \| findstr :3000` then `taskkill /PID <pid> /F`                  |

#### Using VS Code with WSL2

Install the **[Remote — WSL](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl)** extension. Then open the project from inside WSL2:

```bash
cd ~/ai-net
code .
```

VS Code will attach to the WSL2 environment and use the Linux toolchain automatically. All terminal sessions in the integrated terminal will run inside WSL2.
