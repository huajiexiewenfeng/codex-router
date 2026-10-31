# Desktop Router port selection fix

## Symptom and evidence

An existing Windows installation could not start: its old service heartbeat and
locks survived a dead process, while its persisted port was in the Windows
default ephemeral range (49152–65535) and was now bound by another process.
These are separate blockers; changing port alone does not recover stale locks.

`prepareDesktopEndpoint` previously used `listen(0)` and persisted the OS-assigned
ephemeral port. It now probes 29080–29179 on loopback, skipping occupied or denied
ports and saving the first available port. It refuses preparation if all fail.
This reduces collisions with default ephemeral allocation; it does not reserve
a port permanently or guarantee availability after the probe closes. Custom OS
dynamic ranges and other services may still conflict.

## Scope and acceptance

- Only first-time endpoint selection changes. Existing nonzero endpoints are
  preserved even when occupied; startup must not silently change Worker URLs.
- No changes to requests, prompts, credentials, model catalogs or routing rules.
- Regression checks cover first allocation, occupied preferred port, exhausted
  range, saved endpoint stability, locks and existing Worker protection.
- Existing installations need an explicit backed-up migration of the Router
  config port and its dedicated Codex provider URL, with no service/model request
  automatically started. Worker IDs and ledgers remain unchanged.

## Local migration boundary

Close the Router management window before migration. Verify the old service PID
is absent and no new Router owns its state. Preserve a verified backup of the
exact pre-migration files. Only archive locks belonging to the confirmed dead
service (including ledger locks); never stop an unrelated port owner. Reopen the
manager and restart Codex to load the new endpoint. Local configuration recovery
is not proof that upstream models work or that the next installer includes this
source fix.

## Verification

- Endpoint tests: 8 passed; the first-allocation and occupied-preferred-port
  regressions failed against the original implementation before the fix.
- Related config bridge, service control and provider installation tests: 43 passed.
- Local migration transformation checks: 3 passed.
- One explicitly authorized local installation was migrated after closing its
  manager. The new port was bindable, dedicated provider URL matched, all four
  Worker ledgers validated, and installed status logic reported `not_started`.
  UI control logic allowed Start and disallowed Stop. No real service or model
  request was started as part of this migration.
- The first-allocation source change is not yet in a rebuilt installer. Existing
  local config migration does not require installing that change.
