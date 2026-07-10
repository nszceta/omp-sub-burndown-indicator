# OMP Subscription Burndown Indicator Plan

## Objective

Create a standalone OMP plugin that renders one persistent, highly space-efficient segmented row immediately above the editor/status area. Each segment represents one subscription and reports whether its **shortest-duration usage-limit window** is ahead of or behind a linear quota burndown.

“Ahead” is quota-safe: the subscription has consumed less than the linear pace permits. “Behind” means consumption is greater than the linear pace permits.

Example, subject to theme and symbol settings:

```text
Cl ▲12 · Ox ▼4 · Gm =0
```

- `Cl`, `Ox`, `Gm`: stable compact subscription labels.
- `▲12`: 12 percentage points ahead of linear pace; quota-safe.
- `▼4`: 4 percentage points behind linear pace.
- `=0`: on pace within the configured tolerance.
- Separators make the single row visually segmented without spending a row per subscription.

## Clarified decisions

- Deliverable: a **new standalone OMP plugin repository**, not a modification to OMP internals.
- Host surface: OMP’s supported extension API.
- Placement: `ctx.ui.setWidget(..., { placement: "aboveEditor" })`.
- Layout: exactly one thin segmented row.
- Subscription model: provider-agnostic.
- Window selection: the eligible window with the **shortest positive duration**, independent of reset order or remaining quota.
- Signal: deviation from linear percent burndown.
- Sign semantics: positive/ahead is quota-safe; negative/behind is over pace.
- Data policy: use information exposed by OMP whenever possible; otherwise query supported usage endpoints.
- Platform policy: support the terminal/mode behavior provided by OMP’s public UI abstractions.

## Verified OMP constraints

The plan must preserve these host boundaries:

1. OMP extensions are TS/JS default-exported factories registered through `ExtensionAPI` from `@oh-my-pi/pi-coding-agent`.
2. Installed packages declare extension entry points through `package.json` → `omp.extensions`.
3. Interactive OMP supports `setWidget` above or below the editor. `setHeader` and `setFooter` are no-ops and are not valid alternatives.
4. RPC supports string-array widgets but not component-factory widgets. ACP stubs widgets out; headless/subagent contexts have no usable UI. Exact `aboveEditor` placement is therefore guaranteed only by interactive OMP.
5. `ctx.models.list()` exposes authenticated models and `ctx.models.current()` exposes the current model. Neither exposes subscription usage windows.
6. `ctx.getContextUsage()` reports model context-window use, not account/subscription quotas, and must not be used for this feature.
7. `after_provider_response` exposes response status, headers, and request ID. It does not identify an account and does not directly provide a normalized subscription usage report.
8. OMP’s public `@oh-my-pi/pi-ai` package exports provider-agnostic `UsageReport`, `UsageLimit`, `UsageWindow`, `resolveUsedFraction`, provider usage adapters, and broker client support.
9. An OMP auth broker or auth gateway exposes authenticated `GET /v1/usage`, returning normalized usage reports. This is the preferred complete source when configured.
10. The extension API does not expose OMP’s local credential store or auth-storage usage cache. The plugin must never import those coding-agent internals, open `agent.db`, inspect auth cache files, or patch OMP.

Reference contracts used during implementation:

- OMP extension API and mode behavior: `omp://extensions.md`
- Extension loading/package discovery: `omp://extension-loading.md`
- Broker usage endpoint: OMP `docs/auth-broker-gateway.md`
- Public normalized usage model: `@oh-my-pi/pi-ai` exports from `packages/ai/src/usage.ts`

## Scope

### In scope

- New Bun/TypeScript package installable as an OMP plugin.
- Public OMP extension integration only.
- Discovery of candidate providers from public OMP model context.
- Normalized aggregation of subscription usage reports.
- OMP broker/gateway usage retrieval.
- Opportunistic ingestion of supported provider rate-limit response headers.
- Direct supported usage-endpoint fallback through public `@oh-my-pi/pi-ai` adapters when the plugin has explicitly configured credentials.
- Deterministic selection of one shortest-duration window per subscription.
- Linear burndown calculation.
- One-line width-aware rendering with Unicode and ASCII-safe symbols.
- Refresh, caching, stale-data, cancellation, and unavailable-data behavior.
- Focused unit, integration, and interactive smoke coverage.
- Installation and configuration documentation after the plugin works.

### Explicitly out of scope

- Changes to the OMP repository, status-line internals, auth storage, credential ranking, provider implementations, or settings schema.
- Reading OMP’s SQLite database, encrypted broker snapshot, token files, or other private implementation state.
- Treating context-window token usage as subscription quota usage.
- Estimating limits from chat token counts when no authoritative quota report exists.
- Redeeming reset credits, changing credentials, or performing any write against provider or broker APIs.
- Multiple widget rows, historical charts, popovers, or a dashboard.
- A compatibility shim around undocumented OMP internals.

## Feasibility boundary

A complete “each subscription” view is possible without OMP internal access only when at least one authoritative public source can identify the subscription/account and its limit windows:

1. configured OMP auth broker/gateway `/v1/usage`; or
2. a supported provider usage endpoint with credentials explicitly supplied to the plugin; or
3. response rate-limit headers containing enough provider/window data to normalize safely.

`ctx.models.list()` alone is not sufficient: it identifies authenticated models, not accounts, quota windows, reset timestamps, or usage fractions. If none of the three sources is available for a provider, the plugin must show that subscription/provider as unavailable or omit it according to configuration. It must not invent a quota.

## Proposed repository layout

```text
package.json
bun.lock
tsconfig.json
biome.json
src/
  index.ts
  config.ts
  domain/
    types.ts
    normalize.ts
    burndown.ts
  sources/
    source.ts
    coordinator.ts
    omp-models.ts
    omp-broker.ts
    response-headers.ts
    provider-endpoints.ts
  render/
    labels.ts
    symbols.ts
    row.ts
  runtime/
    controller.ts
    refresh-loop.ts
test/
  burndown.test.ts
  normalize.test.ts
  source-coordinator.test.ts
  broker-source.test.ts
  response-headers.test.ts
  row.test.ts
  extension.test.ts
README.md
```

Responsibilities must stay narrow:

- `src/index.ts`: register lifecycle/event handlers and construct the controller; no quota math.
- `src/config.ts`: read and validate environment configuration; redact secrets in errors.
- `src/domain/*`: pure normalized data and burndown/window-selection functions.
- `src/sources/*`: source-specific I/O, identity authority, and freshness merging.
- `src/render/*`: pure one-row layout and width degradation.
- `src/runtime/*`: refresh lifecycle, single-flight control, last-good state, and widget updates.

## Normalized domain model

Use public `@oh-my-pi/pi-ai` usage types at the I/O boundary, then map them into a minimal plugin-owned view model. Do not duplicate provider wire schemas in rendering code.

```ts
type UsageSourceId = "omp-broker" | "omp-response" | "provider-endpoint";

interface LimitObservation {
  limit: UsageLimit;
  measurementSource: UsageSourceId;
  fetchedAt: number;          // measurement time, never HTTP response time
  stale: boolean;
}

interface SubscriptionSnapshot {
  id: string;                 // stable provider + account/project identity
  provider: string;
  accountLabel?: string;
  identitySource: UsageSourceId;
  limits: LimitObservation[];
}

interface BurndownSegment {
  subscriptionId: string;
  label: string;
  windowId?: string;
  resetsAt?: number;
  usedFraction?: number;
  elapsedFraction?: number;
  paceDelta?: number;         // elapsedFraction - usedFraction when known
  state: "ahead" | "on-pace" | "behind" | "exhausted" | "unknown";
  stale: boolean;
}
```

### Stable subscription identity

Build `SubscriptionSnapshot.id` from the strongest available non-secret scope:

1. provider + account ID;
2. provider + project/org ID;
3. provider + broker-supplied stable account key in normalized metadata;
4. provider-only only when the source proves there is one unambiguous subscription.

Never use access tokens, API keys, raw credential hashes, mutable display labels, or array positions as IDs. Retain a source-local ID only when that source supplies a stable non-secret key. If multiple same-provider reports cannot be assigned stable identities, exclude them from merge/render and expose an ambiguity diagnostic rather than merge or reorder them incorrectly.

## Data-source design

Define one small interface:

```ts
interface UsageSource {
  readonly id: string;
  refresh(signal: AbortSignal): Promise<SubscriptionSnapshot[]>;
}
```

### Source 1: OMP broker/gateway — preferred

`OmpBrokerUsageSource` is authoritative when configured.

- Read broker/gateway URL and bearer token from environment configuration.
- Prefer existing OMP environment names when present: `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`.
- Call only the documented read-only `GET /v1/usage` endpoint.
- Use `AuthBrokerClient.fetchUsage(signal)` and the public `UsageResponse`/`usageResponseSchema` from `@oh-my-pi/pi-ai` when available; otherwise implement the small HTTP call and validate the same `{ generatedAt, reports: UsageReport[] }` envelope before reading `.reports`. Track `generatedAt` only as broker response time; preserve each `report.fetchedAt` as the measurement timestamp used for merging and staleness. Never depend on the broker-stripped `UsageReport.raw` field.
- Apply an abortable timeout.
- Respect broker caching; do not poll more frequently than the configured minimum.
- Preserve last-good reports on transient timeout, network, 429, and 5xx failures; mark them stale.
- Treat 401/403 and schema failures as visible source errors, not empty usage.
- Never log the bearer token, authorization header, raw credential metadata, or unredacted broker response.

This source can cover multiple credentials/subscriptions without exposing provider credentials to the plugin and should win merge conflicts over less complete sources.

### Source 2: public OMP response metadata — opportunistic

`ResponseHeaderUsageSource` consumes `after_provider_response` events.

- Normalize header names and feed them only to matching public provider header parsers exported by `@oh-my-pi/pi-ai`.
- Associate a response with `ctx.models.current()` only when the provider identity is unambiguous at event time.
- Do not assign an account identity unless the public event/header data supplies one.
- Ignore unsupported or partial header sets instead of fabricating duration, reset, or account fields.
- Update the affected snapshot immediately and request a render without waiting for the poll interval.
- Treat header-derived data as lower-confidence than an account-identified broker report.

Because the event does not carry a credential/account ID, this source is mainly a freshness improvement for the current provider; it is not the sole solution for multiple accounts on one provider.

### Source 3: supported provider usage endpoints — fallback

`ProviderEndpointUsageSource` is an adapter registry around usage providers publicly exported by `@oh-my-pi/pi-ai`.

- Register only provider adapters that expose a supported read-only usage endpoint or supported rate-limit parser in the installed `@oh-my-pi/pi-ai` version.
- Initial support matrix should be generated from public exports and covered explicitly in tests. Current OMP exports include usage modules for Claude/Anthropic, Gemini, GitHub Copilot, Google Antigravity, Kimi, MiniMax, OpenAI Codex, OpenAI Codex reset data, OpenCode Go, and Z.ai; implementation must verify each adapter’s credential and endpoint requirements before enabling it.
- Reuse the public `UsageProvider.fetchUsage` contract instead of copying endpoint URLs, payload parsing, retry semantics, or provider quirks.
- Obtain credentials only from explicit secret environment variables documented for that adapter. Do not reach into OMP’s credential registry or local files.
- When an adapter defines `supports`, require `supports(params) === true`; otherwise enforce that adapter’s documented credential preconditions before calling `fetchUsage`.
- Use read-only requests, bounded timeouts, abort signals, and the same redaction policy as the broker source.
- A provider discovered through `ctx.models.list()` but lacking broker data or explicitly available endpoint credentials remains unavailable; discovery does not grant credential access.

### Source identity, precedence, and freshness rules

Establish subscription identity in this order:

1. valid, account-identified OMP broker/gateway report;
2. valid, account-identified direct provider endpoint report;
3. response headers only when an already identified subscription can be correlated unambiguously.

Identity authority and measurement freshness are separate. Once the same stable subscription and limit are established, the newest valid complete measurement wins by `fetchedAt`, including an unambiguous response-header measurement observed after a broker poll. A header report must never create or merge an ambiguous account. Do not merge two different accounts merely because their provider IDs match. Keep last-good data during transient failures and attach a stale timestamp. Expire last-good data after a configurable maximum age; after expiry render unknown/unavailable rather than a misleading pace value.

## Window selection and burndown algorithm

### Eligibility

For each subscription:

1. Resolve `usedFraction` with public `resolveUsedFraction(limit)`.
2. Keep limits with a finite used fraction, finite `window.resetsAt`, and positive finite `window.durationMs`.
3. Ignore reset-credit counters and non-window quotas.
4. Ignore windows whose reset is older than a small clock-skew tolerance.
5. Clamp display calculations, but retain overage (`usedFraction > 1`) long enough to classify exhaustion correctly.

If no eligible window exists, produce `unknown`; do not silently select a no-reset or malformed window.

### Select the required window

Choose the eligible limit with the smallest positive `durationMs`.

Tie-breakers, in order:

1. earlier future `resetsAt`;
2. stable `limit.id` lexical order.

This makes the result deterministic and implements “shortest window” exactly.

### Linear pace

For selected limit $L$ at time $t$:

$$
\text{start} = \text{resetsAt} - \text{durationMs}
$$

$$
\text{elapsedFraction} = \operatorname{clamp}\left(\frac{t - \text{start}}{\text{durationMs}}, 0, 1\right)
$$

$$
\text{paceDelta} = \text{elapsedFraction} - \text{usedFraction}
$$

Display the delta in rounded percentage points:

$$
\Delta_{pp} = \operatorname{round}(100 \times \text{paceDelta})
$$

Classification:

- `exhausted`: used fraction is at least 1, regardless of pace delta;
- `ahead`: pace delta is greater than the on-pace tolerance;
- `on-pace`: absolute pace delta is within the tolerance;
- `behind`: pace delta is less than the negative tolerance;
- `unknown`: required fields are unavailable or invalid.

Default tolerance: one percentage point. Make it configurable, bounded to a sensible range, and test the exact boundary.

Example: 60% of a window elapsed and 45% consumed gives `+15 pp`: ahead/quota-safe. 60% elapsed and 72% consumed gives `-12 pp`: behind.

## One-row rendering contract

Use a public component-factory widget:

```ts
ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new BurndownRowComponent(theme), {
  placement: "aboveEditor",
});
```

`BurndownRowComponent.render(width)` receives the current host width and returns exactly zero or one rendered line. This provides resize-aware, cell-accurate degradation in interactive OMP without touching status-line internals. RPC supports only string-array widgets and ACP stubs widgets, so these modes must degrade to no indicator without throwing; headless/subagent contexts also render nothing.

### Segment forms

Render each subscription using the richest form that fits the current width budget:

1. Full compact: `Claude ▲12 2h`.
2. Compact: `Cl ▲12`.
3. Minimal: `C▲12`.
4. If not every segment can fit, retain the most urgent subscriptions and append `+N` for hidden segments.

All forms remain on one row. Reset countdown is secondary and drops before the pace signal. The pace direction and magnitude must never be dropped before decorative separators or reset text.

### Ordering

Sort segments by user risk so truncation preserves actionable data:

1. exhausted;
2. most behind;
3. on pace;
4. least ahead to most ahead;
5. unknown/stale;
6. stable subscription ID tie-breaker.

### Symbols and color

- Unicode: `▲` ahead, `▼` behind, `=` on pace, `!` exhausted, `?` unknown, `~` stale.
- ASCII fallback: `+`, `-`, `=`, `!`, `?`, `~`.
- Ahead uses OMP theme success color; behind uses warning/error according to magnitude; unknown/stale uses dim.
- Sign/glyph remains authoritative. Color is redundant, so color-blind and no-color terminals retain the meaning.
- Use OMP theme methods; do not hard-code ANSI color numbers.

### Width accounting

- Use the `width` passed to the component’s `render(width)` method; do not infer interactive width from `process.stdout.columns`.
- Measure visible cell width, not JavaScript string length; ANSI escapes and wide glyphs must not count as ordinary characters.
- Never wrap and never emit more than one line.
- Build each candidate form once per render, then choose forms deterministically; avoid repeated string allocation in nested fit loops.
- If no meaningful segment with direction and magnitude fits, clear the rendered line instead of emitting a broken or misleading fragment.

## Runtime lifecycle

`IndicatorController` owns all mutable state.

### Startup

On `session_start`:

1. Return immediately when `ctx.hasUI` is false, while keeping event handlers safe.
2. Read validated config.
3. Discover candidate providers from `ctx.models.list()`.
4. Initialize configured usage sources.
5. Render a compact loading state only if the first refresh is not immediate.
6. Start one refresh cycle and one scheduler.

### Refresh triggers

- Poll broker/direct endpoints on a configurable interval with a conservative default aligned to upstream caching.
- Refresh immediately on `session_start` and after relevant configuration/session changes.
- Ingest `after_provider_response` headers immediately without starting a second poller.
- Re-render when data changes and when the passage of time changes the rounded pace delta or reset countdown; do not redraw on every clock tick when output would be identical.

### Concurrency and shutdown

- Only one source refresh may be in flight per source; concurrent triggers join or skip the current refresh.
- Every refresh receives an `AbortSignal`.
- `session_switch` and `session_tree` cancel timers and requests owned by the prior session, advance the generation guard, then initialize one refresh loop for the new active session context.
- `session_shutdown` cancels all work and clears the widget with `setWidget(WIDGET_KEY, undefined)` where UI exists.
- Late promises must check generation/session identity before mutating state.
- Source failures are isolated; one provider cannot blank healthy subscriptions.

### Diagnostics

Register a slash command such as `/burndown-status` that reports, without secrets:

- enabled sources;
- last successful refresh per source;
- stale age and last error category;
- discovered providers versus subscriptions with authoritative reports;
- why a provider is unavailable (no broker report, no supported adapter, or missing explicit endpoint credential).

Do not spend persistent widget space on verbose errors. Render a compact `?` or stale marker and leave detail to the command/log.

## Configuration

The current public `ExtensionAPI` does not expose the installed plugin manager’s persisted setting values. Do not import the internal plugin loader to call `getPluginSettings`, and do not claim that `omp.settings` values are readable until OMP publishes that accessor.

Read configuration from environment variables in `src/config.ts`:

- `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` for the preferred OMP broker/gateway source;
- `OMP_SUB_BURNDOWN_REFRESH_SECONDS`;
- `OMP_SUB_BURNDOWN_STALE_AFTER_SECONDS`;
- `OMP_SUB_BURNDOWN_PACE_TOLERANCE_PERCENT`;
- `OMP_SUB_BURNDOWN_SYMBOLS=auto|unicode|ascii`;
- `OMP_SUB_BURNDOWN_SHOW_RESET=true|false`;
- provider-native secret environment variables only for verified direct endpoint adapters.

Configuration rules:

- Broker source auto-enables only when URL and token are both present.
- A half-configured source is a diagnostic error, not an unauthenticated request.
- Direct endpoint sources are opt-in when required secret environment variables are present.
- Defaults must produce no network requests to unknown or guessed URLs.
- Validate and bound every numeric/enum value before starting I/O.
- The plugin never persists secrets. It must redact tokens, credentials, authorization headers, URLs containing credentials, and raw error bodies from logs and diagnostics.
- If OMP later adds a documented extension setting accessor, a future implementation may declare masked `omp.settings`; that is not part of the initial contract.

## Implementation sequence

### Phase 1 — package and public host contract

1. Create the Bun/TypeScript package, strict compiler config, Biome config, and test scripts.
2. Add compatible peer/dependencies on `@oh-my-pi/pi-coding-agent`, public `@oh-my-pi/pi-ai`, and `@oh-my-pi/pi-tui` for the widget component contract and cell-width utilities.
3. Declare `omp.extensions: ["./src/index.ts"]` in `package.json` and document the environment configuration contract.
4. Implement a minimal extension factory that sets and clears one component-factory widget through public APIs.
5. Add a fake `ExtensionAPI` integration test proving registration, `aboveEditor` placement, one-line component rendering, width propagation, and shutdown cleanup.

Exit check: install/load the package in OMP and display a static one-line widget without any OMP source change.

### Phase 2 — pure domain behavior

1. Implement normalization and stable subscription identity.
2. Implement used-fraction resolution through the public helper.
3. Implement eligibility, shortest-duration selection, deterministic tie-breakers, and stale handling.
4. Implement linear elapsed fraction, signed pace delta, tolerance, exhaustion, and unknown states.
5. Cover all boundary cases with deterministic clocks.

Exit check: focused domain tests prove the exact user-selected semantics.

### Phase 3 — authoritative OMP data

1. Implement broker/gateway configuration and redaction.
2. Implement `GET /v1/usage` retrieval, schema validation, timeout, abort, and error classification.
3. Normalize multiple account reports without collapsing subscriptions by provider.
4. Implement source cache, single-flight refresh, and last-good stale behavior.
5. Add a local HTTP test server for success, malformed response, 401, 429, timeout, abort, multiple accounts, and last-good preservation.

Exit check: a fake broker with two subscriptions drives two correct domain segments.

### Phase 4 — OMP events and endpoint fallback

1. Discover provider candidates from `ctx.models.list()` without treating them as quota reports.
2. Wire `after_provider_response` and verified public header parsers.
3. Guard provider/account association and reject ambiguous headers.
4. Inventory public `@oh-my-pi/pi-ai` usage adapters and document their credential requirements.
5. Add only verified supported endpoint adapters, using explicit plugin/env credentials and public fetcher contracts.
6. Implement deterministic identity authority plus newest-valid-measurement merging.

Exit check: broker data establishes account identity, endpoint data fills broker gaps, and unambiguous newer header data refreshes the same current subscription without cross-account contamination.

### Phase 5 — compact row rendering

1. Implement stable labels and collision disambiguation.
2. Implement risk ordering, full/compact/minimal forms, hidden-count marker, symbol fallback, theme colors, and stale markers.
3. Implement cell-width-aware selection that always returns zero or one line within budget.
4. Connect the renderer to the controller and suppress identical redraws.
5. Test narrow widths, many subscriptions, ANSI styles, Unicode width, duplicate labels, urgent-first truncation, and exact fit boundaries.

Exit check: every tested width stays on one row and preserves the most urgent pace signal.

### Phase 6 — lifecycle and end-to-end behavior

1. Implement refresh scheduling, generation guards, cancellation, and widget cleanup.
2. Add the diagnostic slash command.
3. Run integration tests with fake OMP context plus fake broker/provider sources.
4. Install the package into an interactive OMP session and verify placement above the editor/status area, refresh, narrow-terminal behavior, theme behavior, and session shutdown.
5. Exercise RPC/ACP with the component-factory widget and verify their documented no-display behavior is a safe no-op; verify headless startup skips rendering.

Exit check: the plugin behaves correctly across the public host modes it can support and degrades without errors elsewhere.

### Phase 7 — cleanup and release readiness

Only after the interactive smoke test passes:

1. Remove temporary fixtures/scaffolding and dead adapter experiments.
2. Run focused tests, typecheck, formatter/linter, and package manifest validation.
3. Write `README.md` with installation, broker-first configuration, endpoint fallback, symbol semantics, mode limitations, privacy guarantees, and troubleshooting.
4. Verify the published package includes the extension entry and required source files.
5. Reinstall from the packed artifact and repeat the one-line interactive smoke test.

## Test matrix

### Domain contracts

- Shortest positive duration wins even when another window resets sooner.
- Expired reset is ignored within the documented clock-skew rule.
- Equal durations use earlier future reset and stable ID tie-breakers.
- Explicit used fraction, used/limit, percent-unit used, and remaining fraction follow public precedence.
- 60% elapsed/45% used is `ahead +15 pp`.
- 60% elapsed/72% used is `behind -12 pp`.
- Exact tolerance boundaries classify consistently.
- Exhaustion overrides a superficially positive pace result.
- Missing duration, reset, or used fraction yields unknown.
- Future window start clamps elapsed to zero; clock drift cannot produce invalid output.

### Source contracts

- Authoritative broker/direct reports establish stable account/project identity; headers cannot establish an ambiguous identity.
- For the same identified subscription/limit, the newest valid measurement wins across sources while identity provenance remains unchanged.
- A current broker `generatedAt` with an old `report.fetchedAt` remains stale and cannot replace a newer header measurement.
- One failed source does not remove healthy source data.
- Transient failure retains last-good data and marks it stale.
- Expired stale data is no longer shown as current.
- 401/403 is distinguishable from an empty valid report.
- Malformed endpoint data cannot reach the renderer.
- Secrets never appear in thrown messages, diagnostics, snapshots, or logger calls.
- Ambiguous response headers never update the wrong provider/account.
- Adapters with and without an optional `supports` method both enforce their documented credential preconditions.
- Reordered anonymous same-provider reports are excluded with an ambiguity diagnostic rather than assigned unstable IDs.

### Rendering contracts

- Output is zero or one line for every width.
- Visible width never exceeds the supplied budget.
- Most-behind/exhausted subscriptions survive width pressure first.
- Hidden count is correct.
- Unicode and ASCII modes carry equivalent semantics.
- No-color output still distinguishes ahead, behind, on-pace, exhausted, stale, and unknown.
- ANSI/theme styling does not corrupt width calculation.
- Stable input produces byte-identical output and no redundant UI update.

### Runtime contracts

- Only one poller and one in-flight refresh per source exist.
- Session switch/tree abort prior work, leave exactly one restarted loop, and render only the new context; only shutdown permanently clears the widget.
- Late results from an old session cannot render.
- Header events update promptly without duplicating pollers.
- RPC/ACP ignore the component-factory widget without throwing or corrupting session behavior.
- Headless no-UI behavior does not start rendering and does not throw.

## Acceptance criteria

The implementation is complete only when all of the following are true:

1. It installs as a standalone OMP plugin and requires no OMP patch or undocumented internal import.
2. Interactive OMP displays exactly one segmented row through `setWidget` with `placement: "aboveEditor"`.
3. Every authoritative subscription report contributes at most one segment, selected by shortest positive window duration.
4. Segment state is based on `elapsedFraction - usedFraction`; ahead means quota-safe.
5. The row remains within terminal width, preserves urgent subscriptions first, and has Unicode/ASCII plus no-color semantics.
6. The plugin prefers OMP broker/response information and uses only verified supported endpoint fallbacks with explicit credentials.
7. Multiple accounts on one provider are never accidentally merged.
8. Missing authoritative data is represented as unavailable/unknown, never estimated from unrelated token counts.
9. Refreshes are bounded, abortable, single-flight, stale-aware, and cleaned up on session transitions.
10. Focused tests cover domain boundaries, source precedence/errors, rendering widths, lifecycle cancellation, and secret redaction.
11. An installed-package interactive smoke test proves placement, live refresh, narrow-width degradation, and shutdown cleanup.
12. Documentation states the hard data-access limitation: without broker data, supported endpoint credentials, or usable response headers, OMP’s public extension API cannot expose subscription limits.

## Principal risks and mitigations

- **No public local-auth usage accessor:** use broker/gateway first; never inspect OMP internal stores. Clearly show unavailable when no supported source exists.
- **Response headers lack account identity:** accept only unambiguous updates and rank them below account-identified reports.
- **Provider endpoint churn:** delegate parsing and endpoint behavior to public `@oh-my-pi/pi-ai` adapters and pin/test compatible versions.
- **Credential exposure:** prefer broker aggregation; direct adapters are explicit opt-in; mask settings and redact all errors.
- **Narrow terminal widths:** risk-sort, degrade segment forms deterministically, add hidden count, and never wrap.
- **Clock/reset inconsistencies:** inject the clock, tolerate small skew, validate finite timestamps/durations, and mark malformed windows unknown.
- **Mode differences:** use the resize-aware component-factory widget required for interactive width correctness; guarantee placement only in interactive OMP and degrade to no indicator without errors in RPC, ACP, and headless modes.
- **Multiple accounts per provider:** require stable non-secret account scope before merging; never infer identity from provider alone when ambiguous.
