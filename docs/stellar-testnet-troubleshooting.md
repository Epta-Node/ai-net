# Stellar testnet troubleshooting

Use this checklist when a local client, indexer, or contract deployment cannot reach Stellar testnet.

## Confirm the network

Keep the network passphrase and endpoints together. Stellar testnet uses:

- Network passphrase: `Test SDF Network ; September 2015`
- Horizon: `https://horizon-testnet.stellar.org`
- Soroban RPC: `https://soroban-testnet.stellar.org`

Check that the configured endpoint responds before retrying a transaction:

```bash
curl -fsS https://horizon-testnet.stellar.org >/dev/null
curl -fsS https://soroban-testnet.stellar.org/health
```

A successful HTTP response does not prove that the application is using the right network; verify the passphrase and endpoint in the same environment that runs the command.

## Fund a test account

New testnet accounts need XLM for fees and reserves. Fund only disposable development accounts with the Friendbot:

```bash
curl -X POST "https://friendbot.stellar.org?addr=$STELLAR_ACCOUNT"
```

Never place a secret key in shell history, CI logs, issue reports, or this documentation.

## Common failures

- **`tx_bad_seq`**: another process submitted a transaction for the account. Fetch the latest sequence number, stop competing submitters, rebuild, and submit again.
- **`tx_insufficient_balance`**: fund the account and leave enough XLM for the base reserve and fees.
- **`tx_failed`**: inspect the transaction result and Soroban diagnostic events; the network connection succeeded, but the contract rejected the invocation.
- **RPC timeout or HTTP 429**: retry with bounded exponential backoff, reduce polling frequency, and check the endpoint health response. Do not blindly replay a transaction whose submission result is unknown.
- **Contract not found / wrong network**: confirm the contract ID, RPC URL, and network passphrase all refer to testnet. A contract deployed on another network will not be visible here.
- **Unexpected simulation results**: refresh the latest ledger state and regenerate the transaction before signing. Stale simulation data can invalidate resource estimates.

## Diagnostic checklist

Record the command, timestamp, network passphrase name (never secrets), RPC/Horizon URL, account public key, ledger sequence, transaction hash, and the complete non-secret error response. Then retry once from a clean process. If the issue persists, attach those details to the issue so it can be reproduced without exposing credentials.
