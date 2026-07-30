# Scheduler

Scheduler gives an Agent durable recurring wakeups for work that genuinely
benefits from periodic review, consolidation, or follow-up.

## Commands

- `scheduler set --name <name> --every <duration> --note <note>`
- `scheduler remove --name <name>`
- `scheduler list`

Durations use values such as `30s`, `10m`, `6h`, or `1d`. Give each schedule a
stable name and write a note that tells the future Agent turn exactly what to
do and why.

## Consequences

A schedule persists across turns. Every firing creates a new inbound
Communication and may cause another Agent turn, so unnecessary schedules spend
ongoing resources and create noise. List schedules before duplicating one and
remove schedules that are no longer useful. Configuration is available only in
live mode and is not a Ledger Event.
