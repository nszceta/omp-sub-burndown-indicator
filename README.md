# OMP Subscription Burndown Indicator

A standalone [Oh My Pi](https://omp.sh) extension that renders one segmented subscription-quota row immediately above the interactive editor.

```text
Claude ▲12 · Codex ▼4 · Gemini =0
```

Each segment uses the eligible usage window with the shortest positive duration. The number is the rounded percentage-point difference between elapsed time and consumed quota:

```text
pace delta = elapsed fraction - used fraction
```

Positive/ahead means quota-safe: less quota has been consumed than a linear burndown permits. Negative/behind means usage is over pace. An exhausted quota always renders as exhausted regardless of its calculated delta.

## Requirements

- OMP 16.4 or later
- Bun 1.3.14 or later
- An authoritative usage source described below

This package uses only public OMP extension, AI usage, broker, and TUI APIs. It does not patch OMP.

## Install

From a registry release:

```sh
omp plugin install omp-sub-burndown-indicator
```

From a local checkout:

```sh
bun install
omp plugin link .
```

For a one-session trial without installing:

```sh
omp --extension ./src/index.ts
```

Do not combine the trial command with `--no-extensions` on OMP 16.4: that version suppresses explicit extension paths despite older CLI help text stating otherwise.

The package manifest declares:

```json
{
  "omp": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Data sources

Sources are merged by stable, non-secret subscription identity. Identity authority is broker, then direct endpoint. A newer complete header measurement may refresh an already identified limit, but headers never create an ambiguous account.

### 1. OMP auth broker or gateway (preferred)

Configure the documented broker environment variables:

```sh
export OMP_AUTH_BROKER_URL=https://broker.example.test
export OMP_AUTH_BROKER_TOKEN='...'
omp
```

The extension performs only the documented read-only `GET /v1/usage` request through the public `AuthBrokerClient`. OMP itself also consumes these variables when configured.

Plugin-specific aliases are available when testing or when the host must not use the same broker:

```sh
export OMP_SUB_BURNDOWN_BROKER_URL=http://127.0.0.1:8765
export OMP_SUB_BURNDOWN_BROKER_TOKEN='...'
```

`OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` take precedence over the aliases. A URL/token pair must be complete. A half-configured pair produces a diagnostic and no unauthenticated request.

### 2. Provider response headers

The extension listens to public `after_provider_response` metadata and invokes only public `@oh-my-pi/pi-ai` rate-limit parsers. A header report is accepted only when:

- the current model provider has a supported public parser;
- the report contains a complete used fraction, positive duration, and finite reset;
- exactly one authoritative subscription for that provider is already known; and
- the header measurement is newer than the existing limit measurement.

Headers cannot distinguish multiple credentials by themselves and are ignored when correlation is ambiguous.

### 3. Explicit direct endpoint credentials

Direct provider probes are opt-in. They use public `UsageProvider.fetchUsage` adapters and never inspect OMP's credential registry. Set one provider-specific extension variable:

| Provider adapter | Credential type | Environment variables |
| --- | --- | --- |
| Anthropic/Claude | OAuth access token | `OMP_SUB_BURNDOWN_ANTHROPIC_ACCESS_TOKEN`, `OMP_SUB_BURNDOWN_ANTHROPIC_TOKEN`, or `OMP_SUB_BURNDOWN_CLAUDE_ACCESS_TOKEN` |
| Google Gemini CLI | OAuth access token | `OMP_SUB_BURNDOWN_GOOGLE_GEMINI_CLI_ACCESS_TOKEN` or `OMP_SUB_BURNDOWN_GOOGLE_GEMINI_CLI_TOKEN` |
| GitHub Copilot | OAuth access token | `OMP_SUB_BURNDOWN_GITHUB_COPILOT_ACCESS_TOKEN` or `OMP_SUB_BURNDOWN_GITHUB_COPILOT_TOKEN` |
| Google Antigravity | OAuth access token | `OMP_SUB_BURNDOWN_GOOGLE_ANTIGRAVITY_ACCESS_TOKEN` or `OMP_SUB_BURNDOWN_GOOGLE_ANTIGRAVITY_TOKEN` |
| Kimi Code | OAuth access token | `OMP_SUB_BURNDOWN_KIMI_ACCESS_TOKEN`, `OMP_SUB_BURNDOWN_KIMI_TOKEN`, or `OMP_SUB_BURNDOWN_KIMI_CODE_ACCESS_TOKEN` |
| OpenAI Codex | OAuth access token | `OMP_SUB_BURNDOWN_OPENAI_CODEX_ACCESS_TOKEN` or `OMP_SUB_BURNDOWN_OPENAI_CODEX_TOKEN` |
| Z.ai | API key | `OMP_SUB_BURNDOWN_ZAI_API_KEY` or `OMP_SUB_BURNDOWN_ZAI_KEY` |

Each adapter also has an optional `OMP_SUB_BURNDOWN_<PROVIDER>_BASE_URL` variable matching the names in `src/sources/provider-endpoints.ts`. Use it only for a supported compatible endpoint.

The initial matrix intentionally excludes public modules that do not provide an authoritative upstream subscription window for this feature:

- MiniMax currently returns no usage report from its public adapter.
- OpenCode Go derives spend from local observed request costs rather than an upstream subscription window.
- Ollama usage is not a subscription-window quota source.
- Codex reset-credit data is not a usage window and is ignored.

A direct report must expose a stable account, project, organization, or explicit non-secret account key. Multiple anonymous credentials for one provider are excluded rather than assigned by array order.

## Configuration

| Variable | Default | Accepted range or values |
| --- | ---: | --- |
| `OMP_SUB_BURNDOWN_REFRESH_SECONDS` | `300` | 30 through 86400 |
| `OMP_SUB_BURNDOWN_STALE_AFTER_SECONDS` | `1800` | refresh interval through 604800 |
| `OMP_SUB_BURNDOWN_TIMEOUT_SECONDS` | `15` | 1 through 120 |
| `OMP_SUB_BURNDOWN_PACE_TOLERANCE_PERCENT` | `1` | 0 through 25 percentage points |
| `OMP_SUB_BURNDOWN_CLOCK_SKEW_SECONDS` | `30` | 0 through 300 |
| `OMP_SUB_BURNDOWN_SYMBOLS` | `auto` | `auto`, `unicode`, or `ascii` |
| `OMP_SUB_BURNDOWN_SHOW_RESET` | `true` | `true` or `false` |

The public extension API does not expose installed plugin-manager setting values, so configuration is environment-only. Numeric and enum values are validated before I/O.

## Symbols and ordering

| State | Unicode | ASCII | Meaning |
| --- | --- | --- | --- |
| Ahead | `▲12` | `+12` | 12 percentage points under linear consumption pace |
| Behind | `▼4` | `-4` | 4 percentage points over linear consumption pace |
| On pace | `=0` | `=0` | Within configured tolerance |
| Exhausted | `!` | `!` | Used fraction is at least 100% |
| Unknown | `?` | `?` | No eligible authoritative window |
| Stale | `~` prefix | `~` prefix | Last-good data retained after a transient failure |

Color is redundant; the glyph remains authoritative in no-color and color-blind terminals. OMP theme colors are used rather than hard-coded ANSI colors.

Segments are risk-sorted: exhausted, most behind, on pace, least ahead to most ahead, then unknown/stale. Width degradation is deterministic:

1. `Claude ▲12 2h`
2. `Cl ▲12`
3. `C▲12`
4. urgent segments plus `+N` hidden count

The renderer measures visible terminal cells, including ANSI and wide Unicode handling. It emits zero or one line and never wraps. If no meaningful direction and magnitude fit, it emits no row.

## Diagnostics

Run:

```text
/burndown-status
```

The command reports enabled sources, last successful refresh, error category, discovered providers, authoritative reported providers, and why a provider is unavailable. Tokens, authorization headers, raw error bodies, URL credentials, and provider secrets are never included.

## Host modes

- **Interactive OMP:** component-factory widget is rendered with `placement: "aboveEditor"`; resize-aware width and theme behavior are supported.
- **RPC:** OMP 16.4 supports string-array widgets only, so this component widget is ignored safely.
- **ACP:** widget calls are stubbed by the host and produce no indicator.
- **Print/headless/subagent:** `ctx.hasUI` is false; the extension does not start rendering or source refresh work.

Exact placement is guaranteed only in interactive OMP.

## Privacy and security

- No OMP database, `agent.db`, credential store, auth cache, token file, or coding-agent internal module is opened.
- No context-window token usage is treated as account quota usage.
- No quota is estimated from chat token counts.
- Broker and provider operations are read-only, bounded, abortable, and single-flight through the runtime coordinator.
- Secrets are held only in process environment memory and are not persisted by the extension.
- Stable IDs use provider plus account/project/org scope. Tokens, API keys, credential hashes, mutable labels, and array positions are never IDs.
- Different accounts are never merged merely because their provider matches.

## Data-access limitation

OMP's public extension API exposes authenticated models, not local credential identities or subscription usage windows. Without at least one of the following, the extension cannot display an authoritative quota and will show nothing or report the provider as unavailable:

1. broker/gateway `/v1/usage` data;
2. a supported direct endpoint credential explicitly supplied to this extension; or
3. usable public response headers that can be correlated to one already identified subscription.

The extension does not bypass this boundary or invent a quota.

## Troubleshooting

### No row appears

1. Run `/burndown-status`.
2. Confirm a complete broker pair or one supported direct credential is present in the OMP process environment.
3. Confirm the report has a finite reset timestamp, a positive duration, and resolvable used fraction.
4. Remember that provider discovery from `ctx.models.list()` does not grant credential or quota access.
5. Ensure the session is interactive; RPC, ACP, print, and subagent modes intentionally show no component row.

### A row is stale

A transient timeout, network failure, 429, or 5xx preserves last-good data with `~`. After `OMP_SUB_BURNDOWN_STALE_AFTER_SECONDS`, expired observations become unavailable instead of displaying misleading pace.

### Multiple accounts are missing

Each account needs a stable non-secret account/project/org identity from its authoritative report. Anonymous same-provider reports are excluded to prevent cross-account contamination.

## Verification

Repository checks:

```sh
bun test
bun run typecheck
bun run check
bun pm pack
```

Manual interactive smoke test with a configured authoritative source:

1. Install or link the plugin.
2. Start interactive `omp` and confirm one row appears directly above the editor.
3. Resize to narrow and wide terminal widths; confirm the row remains one line and degrades to compact forms with `+N`.
4. Switch themes; confirm semantic glyphs remain readable with and without color.
5. Change the fake or real usage response and confirm the row refreshes.
6. Switch sessions and navigate the session tree; confirm only one refreshed row remains.
7. Exit OMP; confirm shutdown clears the widget and leaves no poller.

The automated suite also covers headless/RPC/ACP-safe no-op behavior through fake public host contexts, cancellation and generation guards, stale expiry, source precedence, and exact rendering widths.
