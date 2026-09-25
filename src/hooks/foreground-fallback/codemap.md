# src/hooks/foreground-fallback/

## Responsibility
Runtime model fallback system for foreground (interactive) agent sessions. When OpenCode emits failover signals via `message.updated`, `session.error`, or `session.status` events, this manager:
- Classifies retryable conditions with `isFailoverError` (message/transport patterns plus a nested HTTP status-code probe)
- Applies a chain-global retry budget (`fallback.maxRetries`): the first N current-model failures are absorbed, later failures advance the fallback chain
- Absorbs a `session.status: retry` event by letting the host continue its own retry loop (no extra prompt)
- Absorbs a terminal error (`session.error` / `message.updated` error) by actively replaying the current user request on the **current** model
- Aborts and re-prompts the next chain model once the budget is spent, or on demand via the `session.status` abort path
- On v1, withholds `session.abort(X)` while the background job board reports running children of X: held retry events do not seal dedup, exhausted chains still stop intervening, and busy replay errors withdraw any armed handoff when the abort is withheld (explicit refusal admits nothing), and settle it only after a failed abort with unknown outcome. v2 and v1 sessions without running children retain their abort behavior. `session.error` and `message.updated` can re-prompt directly without abort.
- Operates reactively through the event system (cannot wrap `prompt()` directly for interactive sessions)
- Defers terminal job-board bookkeeping for inline 401/410 errors while recovery is still possible (cooperates with task-session-manager's `willAttemptFallback`)

## Design

### Core Abstraction
- **ForegroundFallbackManager**: Class instantiated at plugin initialization; process-local fallback progress is shared across replacement instances
- Per-session state:
  - `sessionModel` / `sessionAgent` / `sessionTried`: current model, agent name, models already attempted
  - `sessionRetries`: chain-global count of absorbed current-model retries (not reset by a model switch)
  - `chainExhaustion`: stage `0` (fresh) / `1` (first exhaustion, sticky fallback) / `2` (terminal, aborted)
  - `lastTrigger` / `lastTriggerModel`: anchor for the stale-retry guard
  - `lastTriggerMap`: identity-based dedup keys → timestamps
  - `retryEpisode`: per-session `session.status` retry episode (model, episode id, seen attempts)
  - `initialDelayScheduled` / `pendingInitialDelay`: one initial-delay trigger per descent
  - `inProgress`: process-global Set of sessions with an active retry/fallback, shared via `globalThis` + `Symbol.for`

### Decision Function
`decideIntervention(sessionID, needsAbort)` consumes one budget unit and returns:
- `'absorb'` — budget remained (terminal path → `retryCurrentModel`, host-retry path → no-op)
- `'fallback-delayed'` — budget spent but `initialRetryDelayMs` scheduled the first delayed trigger
- `'fallback'` — budget spent → `tryFallback` / `tryFallbackWithAbort`

### Retryable Error Detection
- **Patterns**: rate-limit/quota/outage/401/403/410 wording, transport codes (`ECONNRESET`, …) and transport messages
- **Status-code probe** (`probeStatusCode`): priority order `statusCode` → `data.statusCode` → `cause.statusCode` → `status` → `response.status` → `response.statusCode` → `data.status` → `data.response.status` → `cause.status` → `cause.response.status`. `asHttpStatus` accepts only finite `100–599` codes (number or 3-digit numeric string), so arbitrary numeric fields are never mistaken for a status.
- **Diagnostics**: when a status code is found, `isFailoverError` emits one compact `failover status diagnosis` log (direct code, candidate `path=value` list, selected code, verdict). Response bodies, tokens and prompts are never logged.
- **Event coverage**: `message.updated` (message metadata error), `session.error` (session-level error), `session.status` (`retry` status)

### Retry Budget and Exhaustion
- `maxRetries = N` absorbs failures `1..N` on the current model; failure `N+1` (and every later failure) advances the chain. `maxRetries = 0` switches immediately.
- The budget is **chain-global** and is not cleared on a model switch.
- Cleared only on: a completed successful assistant response, `session.deleted`, or a confirmed new user turn.
- **Permanent usage/quota failures** (`isPermanentUsageQuotaError`: 402, explicit spending / personal-team-blocked limits, "coding plan package has expired", fixed-window limit reached/exhausted, explicit quota exhausted, provider billing codes) skip the budget entirely — no same-model replay — and never take the sticky re-fallback; `execFallback` aborts at stage 2 when the chain is spent. Ordinary 429 / rate-limit / short-term "quota threshold" wording keeps using the configured budget.
- `isExhausted` (stage 2) short-circuits every failover event and both `tryFallback`/`tryFallbackWithAbort`, so a spent chain aborts at most once.
- `freshTurnResetHandler` runs on any confirmed new `user` turn (the SDK `UserMessage` nests the model under `info.model`; assistant messages keep it top-level; our own in-flight replay is excluded via `inProgress`): it cancels a pending initial-delay trigger and clears the budget, retry episode, `sessionTried`, dedup anchors and `lastFallbackTime`. Un-sealing the stage-2 terminal guard additionally requires the turn to return to `chain[0]`.

### Deduplication (identity-based)
- No error-text + time-window heuristic: identical text can be the next real failure.
- `message.updated` dedupes by message id; `session.status` dedupes by `retryEpisode` (model + episode id + `seen` attempts, so repeated/out-of-order attempts dedupe but an incremented attempt is processed); terminal events with **no** correlatable id are never deduped.
- Dedup and the `inProgress` guard run **before** budget consumption, so a duplicate or concurrently-dropped event cannot burn a budget slot.

## Flow

### Event Processing Pipeline
```
OpenCode Event (message.updated / session.error / session.status)
    ↓
ForegroundFallbackManager.handleEvent()
    ↓
isExhausted? → return (terminal stage 2)   |   inProgress? → return
    ↓
Identity dedup gate (message id / retry episode / none)
    ↓
decideIntervention() → consume one budget unit
    ↓ absorb (terminal)                    ↓ absorb (host retry)   ↓ fallback
retryCurrentModel()                        no-op                  tryFallback*/execFallback
    ↓                                                              ↓
replayFallbackPrompt(current model)                                replayFallbackPrompt(next model)
    ↓
promptAsync() [tail transcript read → full read fallback]
    ↓
admit background handoff · claim switch (fallback only) · toast
```

### Shared Replay
`replayFallbackPrompt(sessionID, targetModel, fromModel, isModelSwitch, error)` is used by both `execFallback` (model switch) and `retryCurrentModel` (same model):
- Reads only the transcript tail (`FALLBACK_REPLAY_TAIL_MESSAGES`) with a full-read fallback; preserves both read errors.
- Arms the background observation handoff before the admission await and admits it exactly once on acceptance.
- On a busy-session `promptAsync` failure, promotes a foreground waiter, aborts, waits `REPROMPT_DELAY_MS`, and retries **once**. An abort transport failure logs `fallback abort failed`; a rejected second prompt logs `retry prompt failed`. Both convert the armed handoff (never drop it), end the attempt without further retry, and let the caller's `finally` release `inProgress`.

## Integration

### Consumers
- **Primary**: Main plugin initialization (`src/index.ts`) creates the manager and passes `fallback.maxRetries`, `initialRetryDelayMs`, `retryDelayMs`
- **Event source**: OpenCode plugin event system (`message.updated`, `session.error`, `session.status`, `session.deleted`, `session.created`, `subagent.session.created`)

### Dependencies
- **OpenCode SDK**: `PluginInput['client']` via `getClient()` (`src/utils/opencode-client.ts`)
- **Utilities**: `abortSessionWithTimeout()`, `parseModelReference()`, `createInternalAgentTextPart()`, `log()`
- **SessionLifecycle** (`src/hooks/session-lifecycle.ts`): registers `session.deleted` cleanup
- **Message types** (`src/hooks/types.ts`): `isReplayableUserMessage` / `partsFromReplayMessage`
- **Background job board** (`src/index.ts`): supplies a synchronous `hasRunning(sessionID)` child check for the optional v1 abort guard; the failing background job itself is not counted as its own child

### Configuration
- Chains: `Record<string, string[]>` (agent name → ordered model list)
- Live fallback config: `fallback.enabled`, `fallback.maxRetries`, `fallback.initialRetryDelayMs`, `fallback.retryDelayMs`
- Legacy keys (`timeoutMs`, `retry_on_empty`, `runtimeOverride`) are stripped by the schema with a deprecation warning and have no effect

### Memory Management
- `session.deleted` clears every session-level map (models, tried, dedup keys, retry episode, budget, exhaustion, pending timers) so a reused session id starts fresh
- Dedup keys are pruned once outside the 5s window

### Observability
Structured logs at: retry-budget absorb/fallback, delaying initial fallback, failover status diagnosis, switched to fallback model, fallback abort failed, retry prompt failed, chain-exhaustion stage transitions, fresh-turn reset, promptAsync unavailable.

## Error Handling
- **Graceful degradation**: abort/promotion may be slow or incomplete; failures are fail-soft
- **Bounded submission retries**: at most one re-prompt after a busy-session abort; no infinite retry, no permanent `inProgress` leak
- **Exhaustion**: stage 2 is terminal (no repeat abort); a confirmed new user turn restores one fresh descent
- **Invalid model format / missing user message**: the replay is skipped without mutating chain state
