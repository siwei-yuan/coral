# Screen Plugin

Screen records sparse foreground activity on macOS. It stores app/window
metadata, local Apple Vision OCR, a full-resolution PNG, and a compressed JPEG
preview. The Ledger receives only an activity ID.

## Requirements and privacy

- macOS with `/usr/bin/swiftc`
- ScreenCaptureKit, Vision, AppKit, and CoreGraphics
- Screen Recording and any macOS input-observation permission requested by the
  system

Screen content can include credentials, private conversations, and personal
data. Run it only in a trusted local Instance and protect or delete that
Instance when it is no longer needed.

## Capture pipeline

- foreground app/window changes request a capture after 300 ms;
- input activity is debounced for 1.2 seconds, with an 8-second maximum wait;
- non-forced captures are limited to one every 2 seconds;
- visual checks run every 5 seconds while active, every 30 seconds while idle,
  and suspend after 5 minutes without activity;
- visually unchanged frames are discarded by the native helper;
- captures from one foreground context are grouped into an activity, which
  closes after 10 seconds of quiet or after 10 minutes;
- finalizing an activity emits one inbound `communication.sent` Event carrying
  `{ type: "screen.activity", activityId }`.

The runtime compiles its small native helper once per source hash inside Plugin
state. Capture and OCR happen locally.

## Agent commands

```bash
screen activity <activity-id>
screen current
```

The command returns JSON containing app metadata, OCR, timestamps, and local
image paths. Screenshot bytes are never placed in the Ledger or automatic
Agent context; the Agent explicitly reads an activity when relevant.

## State and retention

State lives under `<instance>/state/screen`. Completed activities are retained
for at most seven days and a total of 2 GiB; the oldest activities are removed
first. The Default View loads history 20 captures at a time and lazy-loads
previews. Opening the View is not what starts capture—the live Plugin runtime
starts it with the Swarm.

Set `CORAL_SCREEN_DISABLED=1` when running `coral create` or `coral start` to
run the Screen View without native capture. Programmatic deployments may pass
the same value in the Screen Plugin's environment.
