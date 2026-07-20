# OMP Subscription Burndown Indicator

Keep an eye on your AI subscription allowances while you work. This standalone [Oh My Pi](https://omp.sh) extension places a compact status line immediately above the interactive editor, so you can see whether each provider's quota is being consumed sustainably before it resets. Complete segments wrap onto later indicator lines when space runs out; they are never split.

```text
Anthropic ▲12pp · OpenAI Codex ▼4pp · Google Gemini =0pp
```

At a glance, a segment shows whether usage is ahead of or behind a steady consumption pace for its reset window. The number is the rounded difference, in percentage points, between elapsed time and consumed quota:

```text
pace delta = elapsed fraction - used fraction
```

`▲12pp` means usage is 12 percentage points below the linear consumption pace, so the quota is currently safe; `▼4pp` means it is 4 percentage points over pace. This is deliberately not the provider's `% used` or `% free`: the full form separately shows rounded remaining quota and the reset countdown. An exhausted quota always renders as exhausted regardless of its calculated delta.

Every segment starts with the complete provider brand. The account identifier is omitted when that provider has exactly one account; it is shown only when two or more accounts for the same provider must be distinguished. Required account labels remain complete, including their full email or account text. A true same-provider label collision uses an explicit ordinal such as `hi@adamgradzki.com#2`.

## How quota windows are selected

For each subscription, the extension selects the eligible reported window with the shortest positive duration across distinct nominal windows. If multiple limits report the same nominal window—such as independent 7-day quota buckets—it chooses the one furthest behind pace, so an unused parallel bucket cannot hide an overused one.

## Requirements

- OMP 16.4 or later
- Bun 1.3.14 or later
- A supported usage source described below

This package uses only public OMP extension, AI usage, broker, and TUI APIs. It does not patch OMP.

## Install

This project is not published to the npm registry. npm removed TOTP as a
supported 2FA method, and its passkey-based replacement is incompatible with
the maintainer's password manager.

Install through its GitHub-hosted OMP marketplace:

```sh
omp plugin marketplace add https://github.com/nszceta/omp-sub-burndown-indicator.git
omp plugin install omp-sub-burndown-indicator@nszceta
omp config set marketplace.autoUpdate auto
```

OMP checks stale marketplace catalogs on startup and installs newer catalog versions when `marketplace.autoUpdate` is `auto`. To fetch and install a release immediately:

```sh
omp plugin marketplace update nszceta
omp plugin upgrade omp-sub-burndown-indicator@nszceta
```

For each release, bump both `package.json` and `.omp-plugin/marketplace.json` to the same version before pushing. OMP compares the catalog version when deciding whether to update; a GitHub Release or tag is optional and does not trigger the update.

Alternatively, install from a local checkout:

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

Sources are merged by stable, non-secret subscription identity. Identity authority is OMP's authenticated usage service, then broker, direct endpoint, and finally a provider-only response snapshot. Complete headers remain a supplemental fast path; they never assign one response across multiple same-provider accounts.
Independent quota tiers are separate subscriptions under their stable base account identity. For example, OMP's Codex `spark` tier renders as `OpenAI Codex Spark`; it never replaces the base Codex quota or creates a second account label.

### 1. OMP authenticated usage (default)

The extension calls the public `ctx.modelRegistry.authStorage.fetchUsageReports()` API—the same normalized, cached report path used by OMP's built-in `/usage` command. No duplicate credentials or broker configuration are required. Account IDs and email labels come from OMP's normalized report metadata; credential values are never returned to the extension.

### 2. OMP auth broker or gateway

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

### 3. Provider response headers

The extension listens to public `after_provider_response` metadata and invokes only public `@oh-my-pi/pi-ai` rate-limit parsers. A header report is accepted only when:

- the current model provider has a supported public parser;
- the report contains a complete used fraction, positive duration, and finite reset;
- at most one subscription for that provider is known; and
- when refreshing an existing limit, the header measurement is newer.

When no account-identified subscription exists, complete headers can create a lower-confidence `provider:<provider>` snapshot. If multiple account-identified subscriptions exist, headers are ignored because they cannot identify which credential produced the response. A later unique OMP-auth, broker, or endpoint identity replaces the provisional identity while retaining newer header measurements.

### 4. Explicit direct endpoint credentials

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

The environment variables in this table remain the configuration surface for refresh, source/transport, and other runtime and rendering options. Numeric and enum values are validated before I/O.

Display density is stored only in OMP's user-wide plugin runtime configuration
(normally `~/.omp/plugins/omp-plugins.lock.json`), never in an environment
variable. Compact/dense output is the default. OMP's `plugin config` command
does not currently address marketplace installs; to restore verbose text, add
the following entry to the runtime configuration file's existing `settings`
object, then restart OMP:

```json
{
  "omp-sub-burndown-indicator": {
    "density": "text"
  }
}
```

With the default compact output, `▼4 points behind` becomes `▼4pp`, retaining the direction glyph. The text setting restores `▼4 points behind`; ahead and on-pace signals likewise use `▲12pp` and `=0pp` in compact output or their full text forms when text is selected. Exhausted and unknown behavior, along with existing width fallback forms, is unchanged.


## Symbols and ordering

| State | Unicode full form | ASCII full form | Meaning |
| --- | --- | --- | --- |
| Ahead | `▲12 points ahead` | `+12 points ahead` | Usage is 12 percentage points below linear consumption pace |
| Behind | `▼4 points behind` | `-4 points behind` | Usage is 4 percentage points above linear consumption pace |
| On pace | `=0 points on pace` | `=0 points on pace` | Within configured tolerance |
| Exhausted | `! exhausted` | `! exhausted` | Used fraction is at least 100% |
| Unknown | `? unknown` | `? unknown` | No eligible authoritative window |
| Stale | `~` prefix and `(stale)` suffix | same | Last-good data retained after a transient failure |

The table shows verbose full forms. The default compact rendering shortens only full-form pace rows to glyph + magnitude + `pp` (`▲12pp`, `▼4pp`, `=0pp`); setting `density text` restores the table's verbose pace text. Exhausted and unknown forms are unchanged, and existing width fallback forms remain as documented below.

Color is redundant; the glyph remains authoritative in no-color and color-blind terminals. OMP theme colors are used rather than hard-coded ANSI colors.

Segments are risk-sorted: exhausted, most behind, on pace, least ahead to most ahead, then unknown/stale. A provider with one account renders without an account identifier:

```text
OpenAI Codex ▼61pp · 12% left · 6d4h2m
```

The full form retains days, hours, and minutes when they are nonzero, and rounds a partial minute up so it never understates the remaining reset time.
Independent tiers render as their own provider-brand segments while sharing the same account grouping. For example, a single Codex account with both quotas renders `OpenAI Codex … · OpenAI Codex Spark …` without an email label or a synthetic `#2` account.

When one provider has multiple accounts, width degradation changes only the signal and detail portions; the complete provider brand and required account label stay unchanged:

1. `Anthropic:hi@adamgradzki.com ▲12pp · 64% left · 2h`
2. `Anthropic:hi@adamgradzki.com ▲12 points`
3. `Anthropic:hi@adamgradzki.com ▲12`

Width pressure preserves provider and required account names in full. Each complete segment stays whole and remains in global risk order, moving to a subsequent indicator line when it does not fit. A segment is omitted only when its full-name minimal-signal form cannot fit the available width; every segment whose full-name minimal-signal form fits appears on some indicator line, with no hidden-count marker.

Provider names use complete readable brands (`Anthropic`, `OpenAI Codex`, `Google Gemini`) instead of internal provider IDs and remain verbatim at every width. The renderer measures visible terminal cells, including ANSI and wide Unicode handling. It emits zero or more indicator lines, each within the available width. If no meaningful direction and magnitude fit, it emits no indicator.

## Diagnostics

Run:

```text
/burndown-status
```

The command reports enabled sources, last successful refresh, error category, discovered providers, reported providers, and why a provider is unavailable. In a normal interactive OMP session, `omp-auth-storage` should be enabled and report the same providers as `/usage`. Tokens, authorization headers, raw error bodies, URL credentials, and provider secrets are never included.

## Host modes

- **Interactive OMP:** component-factory widget is rendered with `placement: "aboveEditor"`; resize-aware width and theme behavior are supported.
- **RPC:** OMP 16.4 supports string-array widgets only, so this component widget is ignored safely.
- **ACP:** widget calls are stubbed by the host and produce no indicator.
- **Print/headless/subagent:** `ctx.hasUI` is false; the extension does not start rendering or source refresh work.

Exact placement is guaranteed only in interactive OMP.

## Privacy and security

- The extension uses OMP's public, read-only auth usage API. It does not open `agent.db`, credential files, auth caches, token files, or coding-agent internal modules.
- No context-window token usage is treated as account quota usage.
- No quota is estimated from chat token counts.
- Usage operations are read-only, abortable, and single-flight through the runtime coordinator and OMP's usage cache.
- Host credential values are never returned by the usage API. Explicit endpoint secrets are held only in process environment memory and are not persisted by the extension.
- Stable account IDs use provider plus account/project/org scope. A response-only report uses a clearly provisional provider-only ID until one unique stronger identity is available. Tokens, API keys, credential hashes, mutable labels, and array positions are never IDs.
- Different identified accounts are never merged merely because their provider matches.

## Data-access behavior

OMP's public extension context exposes the model registry's normalized auth usage reports. This is the default source and matches the data used by `/usage`. Broker data, explicit endpoint credentials, and complete response headers remain fallbacks or supplemental measurements.

Providers without an OMP usage adapter or a complete upstream quota window remain unavailable. Response-only data identifies the active provider, not a particular account, so it is accepted only while that provider is unambiguous. The extension does not inspect credential values, estimate quota, or assign anonymous data across multiple accounts.

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

Each account needs a stable non-secret account/project/org identity from an authoritative report. Response headers can provide one provisional provider-level row, but cannot split usage among multiple credentials; ambiguous same-provider headers are ignored to prevent cross-account contamination.

## Verification

Repository checks:

```sh
bun test
bun run typecheck
bun run check
bun pm pack
```

Manual interactive smoke test with OMP authenticated providers:

1. Install or link the plugin.
2. Start interactive `omp` and confirm the subscription indicator appears directly above the editor.
3. Run `/usage`, then `/burndown-status`; confirm `omp-auth-storage` is enabled and the reported providers match eligible `/usage` providers.
4. Resize to narrow and wide terminal widths; confirm complete segments remain whole, retain risk order, and move to subsequent indicator lines when needed; segments whose full-name minimal-signal form cannot fit are omitted rather than summarized by a hidden-count marker.
5. Switch themes; confirm semantic glyphs remain readable with and without color.
6. Change the fake or real usage response and confirm the indicator refreshes.
7. Switch sessions and navigate the session tree; confirm only one refreshed indicator remains.
8. Exit OMP; confirm shutdown clears the widget and leaves no poller.

The automated suite also covers headless/RPC/ACP-safe no-op behavior through fake public host contexts, cancellation and generation guards, stale expiry, source precedence, and exact rendering widths.

## License

MIT License. Copyright (c) 2026 Adam Gradzki. See [LICENSE](LICENSE).
