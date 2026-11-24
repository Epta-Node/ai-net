# Security Policy

## Responsible Disclosure

Please report suspected vulnerabilities privately instead of opening a public issue with exploit details.

- Email: security@example.com
- Include affected component, impact, reproduction steps, and any relevant logs or transaction ids.
- Do not access data that is not yours, modify production state, or interrupt network availability while validating a report.
- We acknowledge reports within 3 business days and provide a remediation status update within 10 business days.

## Severity Targets

| Severity | Examples | Target |
| --- | --- | --- |
| Critical | Fund loss, private key exposure, remote code execution | Patch or mitigation within 48 hours |
| High | Auth bypass, task tampering, payment reconciliation bypass | Patch within 7 days |
| Medium | Privilege confusion, sensitive metadata leakage | Patch within 30 days |
| Low | Hardening gaps, low-impact information disclosure | Next regular release |

## Coordinated Release

Security fixes should include tests, migration notes when state changes, and a short advisory that avoids publishing exploit-ready payloads until users have had time to update.
