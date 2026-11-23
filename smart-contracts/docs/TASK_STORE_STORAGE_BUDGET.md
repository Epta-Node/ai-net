# Task Store Storage Budget Findings

- **Task index:** each creator may retain 64 task IDs. The oldest-first eviction removes entries beyond the configured limit, and pages remain capped at 20 IDs.
- **Compressed DAG / task result payload:** maximum accepted size is 4,096 bytes. Payloads of 4,097 bytes or more are rejected with `InvalidDag` before state is written.
- **TTL cleanup:** metadata and auxiliary history/counter keys use the task retention window. A one-day task expires at 86,400 seconds and is rejected with `Expired`; persistent entries are archived when their ledger TTL lapses.
- **Baseline operation budgets:** metadata creation is bounded to 5 entries and 1,100 bytes; lifecycle creation is bounded to 5 entries and 1,100 bytes; status updates add 0 entries and 200 bytes; reads are storage-neutral.
