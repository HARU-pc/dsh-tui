# ADR-0001: DSH SDK stdio transport
- Status: superseded by ADR-0002
- Date: 2026-11-25

## Context
DSH 0.2.0-rc.2 no longer serves the web contract used by this TUI. User explicitly selected SDK rather than porting the web API.
## Options and evaluation
Web migration is excluded by user decision. SDK stdio provides a typed, local child-process boundary; evaluate by handshake, notification rendering, graceful shutdown, and fake-server error/lifecycle tests. The installed protocol/server README and lib/types are primary evidence; real smoke is limited to one prompt.
## Decision
Spawn one SDK runtime per TUI, initialize with cwd/provider/model, mint session ids locally, reuse existing event folding. Unsupported host-only operations fail explicitly. An SDK status idle after observed running defines the single-flight CLI completion interval; no per-prompt completion is promised.
## Consequences
No browser/history/resume/cancel or approvals transport; runtime profile controls tools and permission behavior. Child abnormal exit is fatal. No automatic restart, retry or replay (a failed handshake on a live child may be retried explicitly by the caller). Shutdown never leaves the child: after the shutdown timeout it is terminated (SIGTERM, then SIGKILL); this is shutdown cleanup, not cancellation.
## Validation
SDK fixture transport/conversation/lifecycle tests passed. Full npm test passed at each review round (current count: see the workstream record), npm run check passed. One authorized real SDK prompt returned OK with exit code 0 after shutdown.

Follow-up (2026-11-25, independent review fixes): shutdown waits for exit and force-terminates, interactive UI renders before the handshake, `run --json` keeps the legacy schema; fake-server tests extended (`test/sdk.test.js`).
