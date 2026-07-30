# Screen

Screen provides sparse foreground activity evidence: App session metadata,
OCR, and local full-resolution and preview image paths. Use it when a
`screen.activity` Communication is relevant to the Agent's responsibility.

## Commands

- `screen activity <id>` reads the activity referenced by an Event.
- `screen current` reads the latest retained activity.

Prefer the Event's exact activity ID. Query only when the evidence is useful;
do not repeatedly load the same activity without a reason.

## Consequences

The command reads private local screen-derived data. It does not change the
Swarm, Agent workspace, or Ledger. Image bytes are not automatically added to
context or the Ledger; the result contains local paths that may be inspected
only when necessary.
