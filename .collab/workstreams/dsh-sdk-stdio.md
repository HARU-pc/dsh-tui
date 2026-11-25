# Workstream: dsh-sdk-stdio
- Status: active
- Branch: feat/dsh-sdk-stdio
- Worktree: <worktree>/dsh02-sdk-r2 (Orca workspace)
- Implementer: Codex (Orca task_e29e34199d89); review fixes: Claude (Orca task_dbea36727a61)
- Reviewer: independent review (DeepSeek) via coordinator; fixes re-reviewed by coordinator before commit
- Created: 2026-11-25
- Lease review date: 2026-11-25

## Objective
Replace web transport with DSH 0.2.0-rc.2 SDK stdio, preserve Ink rendering.
## Write scope
lib/index.js, ui/components.js, lib/client.js, lib/session.js, lib/live.js, lib/stream.js, lib/types/index.d.ts, test/types-consumer.ts, bin/tui.js, bin/interactive.js, README.md, docs/dsh-0.2-sdk.md, docs/adr/, test/client.test.js, test/fixtures/, test/stream.test.js, test/sdk.test.js, package.json, .gitignore, this record.
## Dependencies
Installed SDK protocol/server README and lib type contracts; no global configuration changes.
## Acceptance criteria
npm test and npm run check pass; one real SDK prompt displays response; graceful shutdown and failure tested; commit locally.
## Checkpoints
56cb5fb618bd4d6c9dc79c299b0886e918ec30a8 is clean starting checkpoint.
## Risks and rollback
SDK has no cancellation/history/list; disable explicitly. Revert implementation commit to restore previous web client.

## Validation and self review
- Initial implementation: npm test 210 passed, 0 failed; npm run check: exit 0 (superseded by counts below).
- One real SDK prompt: OK, exit 0, no retry. Fake-server PTY: composer, response display, SIGTERM/shutdown passed.
- Self-review finding SDK-1: session switching must detach old listeners; fixed and regression tested.
- Self-review finding SDK-2: shutdown during a CLI conversation left its completion waiter until timeout; fixed with closed notification and regression test.
- Staged secret scan and patch scan passed; no credential files read. User-supplied worktree path is audit metadata; no additional personal data introduced.
- Independent review not performed: dispatched task explicitly prohibits helpers; commit pending coordinator direction under high-impact review rule.

## Review fixes (2026-11-25, Orca task_dbea36727a61)
- Shutdown always awaits child exit; SIGTERM→SIGKILL after timeout. run: original error wins over shutdown error. Interactive renders before initialize; early input queued behind the handshake. MuxStream ends on normal close. `run --json` legacy schema restored.
- Low items: -32601 for server requests, exit code/signal in crash errors, clear missing-cwd error, retryable handshake + listener detach, turn/end completion fallback, subagent policy documented/tested, provider/model kept (required by protocol), fatal invalid stdout kept and justified in docs.
- New tests: test/sdk.test.js (15), test/stream.test.js (+1); npm test 226/226, npm run check and check:types pass. Not committed (coordinator directs commit after review).

## Review round 2 fixes (2026-11-25, Orca task_d9af4dfd35d0)
- shutdown before spawn sets closing first and blocks initialize/spawn; interactive never renders/initializes after exit began; fatal recorded only by the call that starts exiting.
- converse settles on turn/end whenever running is unobserved (idle-before-end); fixture exits after stdout flush; PTY test asserts echoed prompt text/order with explicit insert mode.
- run: SIGINT/SIGTERM → 130/143 without spurious error; text output restored to legacy `(无回复)` fallback; types restrict request/respond to SDK surface; legacy web README moved to docs/legacy-web-readme.md.
- Tests: npm test 231/231 (test/sdk.test.js 20), npm run check and check:types pass. Not committed.

## T524 review response (Orca task_ac44f0181919)
- Implementer: Codex; Reviewer: cc-peer (DeepSeek), no helper workers.
- Scope: existing write scope plus package-lock.json (root version metadata), tmp/T524-review-response.md (ignored).
- Recovery point: HEAD 56cb5fb; existing index retained as tmp/T524-initial-staged.patch before edits.
- Goal: resolve M1–M4/L1–L5, test/check/types, independent re-review, local commit only. No push/PR.
- Validation: npm test 241 passed / 0 failed / 0 skipped, npm run check and check:types exit 0. Original staged implementation fails all 8 selected new regression checks in an isolated tmp/ copy. No additional real SDK/network smoke. ADR-0002 supersedes completion/retry clauses; original transport decisions retained by reference.
- cc-peer / DeepSeek re-review: no high; 2 medium and 6 low. Addressed R3/R4/R5/R6/R8; R1 intentionally retains the documented shared shutdown budget, R2 verified all 3 CLI/UI callers omit presets, R7 verified the fixture delays only initialize (600 ms). Full rationale and raw review are in ignored tmp/T524-review-response.md. Final suite after fixes: 241 passed, 0 failed/skipped; check/types pass.
- Final cc-peer review: no functional high/medium; F1 indentation fixed; F2 rejected because idle is read when delayed turn/end arrives; F3 version/fixture references verified locally. All findings resolved or declined with evidence; no unresolved items. Staged patch/manual secret scans and personal-data self-review passed; local commit only.
