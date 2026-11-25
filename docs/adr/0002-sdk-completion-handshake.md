# ADR-0002: SDK completion and handshake failure boundaries
- Status: accepted
- Date: 2026-11-25
- Level: 3

## Context
Independent review identified premature success when idle precedes turn/end, and ambiguous server state after initialize times out. This supersedes ADR-0001's completion and retry clauses; its transport, limitations and process-cleanup decisions remain unchanged.

## Evaluation criteria
A running → idle → delayed turn/end sequence must retain the final reply and reject an error outcome. A handshake longer than the request timeout must succeed within its own deadline. A timed-out handshake must never be sent again on the same client. Existing lifecycle tests must continue to pass.

## Options
- Keep idle-only completion and retry every handshake failure: lower latency and simpler recovery, but can report failed turns as successful and duplicate an in-flight initialize.
- Require durable turn/end plus idle (either order), retaining the existing no-running settle fallback; use a separate handshake deadline and treat its timeout as fatal: preserves outcome and avoids ambiguous retries, but missing turn/end now waits for the conversation timeout and slow startup has a finite limit.

## Decision
Use the second option. Default initializeTimeoutMs is 120000; ordinary timeoutMs stays 30000. An explicit JSON-RPC initialize rejection remains retryable on a live client; a timeout requires a new client after shutting down the old one. No automatic restart/retry is added.

## Comparison
The same deterministic fixture sequences run against the original staged implementation (isolated under tmp/) and the repaired implementation. Original implementation: 8 selected regression checks failed; repaired implementation: all 8 passed, including both delayed turn/end outcomes, slow handshake and fatal timeout. Full suite: 241 passed, 0 failed, 0 skipped; syntax and type checks passed. This is a contract check, not a performance comparison. Real SDK arrival ordering has not been measured; correctness must not depend on that order.

## Related ADR
- ADR-0001
