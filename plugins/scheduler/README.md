# Scheduler Plugin

Scheduler lets each authorized Agent create its own recurring wakeups. A
schedule is Plugin state, not a Swarm Definition entry and not a Ledger Event.

## Agent commands

```bash
scheduler set --name <name> --every <duration> --note <note>
scheduler remove --name <name>
scheduler list
```

Durations are positive integers followed by `s`, `m`, `h`, or `d`. Names use
letters, numbers, underscores, and hyphens. Setting an existing name replaces
that Agent's schedule.

When due, the runtime advances the next firing time and emits one inbound
`communication.sent` Event to the owning Agent. Its `schedule.fired` content
contains the stable name, recurring duration, scheduled time, and Agent-written
note. The note should tell the future turn exactly what to do and why.

## State and limits

Schedules live under `<instance>/state/scheduler/schedules` and persist when
the Instance stops. They are excluded from Snapshots. Only the owning Agent's
CLI environment can configure its schedules, and configuration is disabled in
Fork mock mode.

The default runtime checks once per second. A programmatic deployment may set
`CORAL_SCHEDULER_TICK_MS` for tests or a different polling interval. Scheduler
supports recurring durations only; it has no cron, calendar, or timezone
grammar.
