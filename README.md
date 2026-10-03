# nerfwatch

Find out when your coding agent quietly got worse or more expensive.

nerfwatch reads the session logs that Claude Code and Codex already write on your machine and flags changes you did not make: a different model answered than the one you picked, reasoning effort dropped, the context window shrank, cache writes per turn jumped after a CLI update, the cache hit rate collapsed, or tool calls started failing more often. Everything runs locally. Nothing is uploaded.

It is not a cost meter. Tools like [ccusage](https://github.com/ryoppippi/ccusage) already tell you what you spent. nerfwatch compares your own history across CLI versions and over time, and tells you what changed and when.

## Quickstart

Requires Node.js 20 or newer.

```sh
npx github:Abelo9996/nerfwatch check
```

That reads every Claude Code and Codex session on the machine, prints what changed, and exits with status 1 if any alert fired. Other commands:

```sh
npx github:Abelo9996/nerfwatch scan                          # baselines per CLI version and model
npx github:Abelo9996/nerfwatch check --since 30d --agent claude
npx github:Abelo9996/nerfwatch report --out nerfwatch-report.md   # anonymized, shareable
```

## Example

Output from `nerfwatch check` on the synthetic logs in `scripts/make-demo-data.mjs` (no real data):

```text
claude: 32 session files, 1,280 turns; codex: 24 session files, 720 turns, 2026-08-23 to 2026-10-02

ALERT  claude  claude-sonnet-5  Requested claude-opus-5 but claude-sonnet-5 answered
       requested claude-opus-5                 cli 2.1.272  2026-09-18 to 2026-09-28  n=1,280
       served    claude-sonnet-5 (120 turns)   cli 2.1.272  2026-09-18 to 2026-09-28  n=120
       120 of 1,280 main-thread API responses (9.4%) for sessions configured to use claude-opus-5
       were served by claude-sonnet-5. If you switched models mid-session or use a mode that routes
       some turns to another model on purpose, this is expected. Otherwise you got a different
       model than you chose.

ALERT  claude  claude-opus-5  Cache-creation tokens per turn jumped after CLI 2.1.272
       before    926                cli 2.1.270, 2.1.271  2026-08-23 to 2026-09-16  n=780
       after     3,037              cli 2.1.272  2026-09-19 to 2026-10-01  n=351
       Median cache writes per API call went from 926 to 3,037. Cache writes are billed above the
       normal input price. A jump usually means the cached prefix is being invalidated and rebuilt
       more often.

WARN   claude  claude-opus-5  Cache hit rate collapsed after CLI 2.1.272
       before    97.8%              cli 2.1.270, 2.1.271  2026-08-23 to 2026-09-16  n=780
       after     80.2%              cli 2.1.272  2026-09-19 to 2026-10-01  n=351

WARN   codex  gpt-5.5  Reasoning effort dropped from high to medium after CLI 0.141.0
       before    high (100% of turns)     cli 0.140.0  2026-08-23 to 2026-09-09  n=240
       after     medium (100% of turns)   cli 0.141.0  2026-09-12 to 2026-10-02  n=480

WARN   codex  gpt-5.5  Context window shrank in the last 7 days with no CLI change (0.141.0)
       before    353.4k             cli 0.141.0  2026-09-12 to 2026-09-23  n=240
       after     258.4k             cli 0.141.0  2026-09-26 to 2026-10-02  n=240

2 alert(s), 3 warning(s), 0 info
```

(Explanations trimmed for the last three findings.) To reproduce it:

```sh
node scripts/make-demo-data.mjs /tmp/nw-demo
nerfwatch check --root claude=/tmp/nw-demo/claude/projects --root codex=/tmp/nw-demo/codex/sessions
```

## What it detects

| Check | Finding id | Compares | Warn | Alert |
|---|---|---|---|---|
| Requested model differs from the model that answered | `model-mismatch` | every main-thread API response | 3+ responses or 0.5%+ | 5+ responses and 2%+ |
| Unrecognized or internal-looking model id answered | `hidden-model` | every served model id | any | |
| Default reasoning effort dropped | `effort-drop` | most common effort per CLI version | any drop | |
| Context window shrank | `contextWindow-shift`, `-drift` | reported window (Codex) or prompt size at auto-compaction (Claude Code) | 10% smaller | 40% smaller |
| Uncached input tokens per turn jumped | `newInput-shift`, `-drift` | median of per-session medians | 1.5x | 2x |
| Cache-creation tokens per turn jumped | `cacheCreation-shift`, `-drift` | median of per-session medians | 1.5x | 2x |
| Session startup prompt grew | `firstTurnPrompt-shift` | prompt size of each session's first request | 1.3x | 1.75x |
| Cache hit rate collapsed | `cacheHitRate-shift`, `-drift` | cached prompt tokens / all prompt tokens | 15 points | 30 points |
| Tool call error rate jumped | `toolErrorRate-shift`, `-drift` | failed tool calls / all tool calls | +5 points and 1.5x | +10 points and 2x |
| Agent recorded a model fallback | `model-fallback` | fallback events | info only | |

`-shift` findings fire at a CLI version boundary for the same model. `-drift` findings compare the last 7 days with the 28 days before, using only the same CLI version and model in both windows, so the change cannot come from an update you installed.

Use `--fail-on warn` to make warnings fail scripts too, or `--fail-on never` to always exit 0.

## How it works

1. **Adapters** (`src/adapters/`) find each agent's log files and turn each line into a small canonical record: one per model API response (tokens, CLI version, requested and served model, effort, context window), one per tool result (error or not), plus a few events (fallbacks, compactions, API errors). Prompts and outputs are never read into these records.
2. **Baselines** group responses by (agent, CLI version, model). `nerfwatch scan` prints them.
3. **Detectors** walk each model's versions in order and compare each version (pooled with up to two following versions when it has little data) against the up to three versions before it. When a threshold trips, the baseline restarts at the new version, so one regression is reported once, at the version where it began. A separate pass compares recent and older traffic on the same version.
4. Medians are taken per session first, then across sessions, so one huge session cannot create a finding by itself. Each side of a comparison needs at least 5 sessions and 50 turns (100 tool calls for error rates). The first request of each session is excluded from per-turn token metrics because it always pays a cold cache; it has its own startup metric.

Details per agent:

- **Claude Code** writes one line per content block, so responses are merged by message id and request id, and copies of the same response in resumed sessions are dropped. The requested model comes from the session's model identity record; after a manual `/model` switch it is treated as unknown until the next identity record, so your own switches are not reported. Subagent transcripts are excluded from the model comparison.
- **Codex** reports `input_tokens` including cached tokens; nerfwatch splits them. Repeated `token_count` events are dropped. Current Codex logs record the requested model and effort but rarely the served model, so the requested-vs-served check for Codex only runs when a reroute event is present.

## Privacy

- Local only. nerfwatch reads files under your home directory and prints to your terminal. It makes no network requests and has no telemetry.
- `nerfwatch report` writes aggregate numbers only: token medians, rates, CLI versions, model ids, dates and counts. It contains no prompts, responses, tool output, file paths, project names or session ids. Model ids that look like account-specific deployments (ARNs, URLs, long numeric ids) are replaced with a hash. The test suite plants sentinel strings in synthetic logs and fails if any of them reach a report.
- Read the report before you share it. It is plain markdown or JSON.

## Supported agents

| Agent | Default location | Override |
|---|---|---|
| Claude Code | `~/.claude/projects`, `~/.config/claude/projects` | `CLAUDE_CONFIG_DIR` (comma separated for several), or `--root claude=DIR` |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` | `CODEX_HOME`, or `--root codex=DIR` |

Paths resolve the same way on macOS, Linux and Windows (`%USERPROFILE%\.claude`, `%USERPROFILE%\.codex`).

## Command reference

```text
nerfwatch scan    [--since WHEN] [--agent ID] [--root AGENT=DIR] [--json]
nerfwatch check   [--since WHEN] [--agent ID] [--root AGENT=DIR] [--json]
                  [--fail-on alert|warn|never] [--recent-days 7] [--baseline-days 28]
nerfwatch report  [--since WHEN] [--agent ID] [--root AGENT=DIR] [--json] [--out FILE.md|FILE.json]
```

`WHEN` is a date (`2026-09-01`) or a span (`12h`, `7d`, `4w`). Exit codes: 0 ok, 1 findings at or above `--fail-on`, 2 usage error.

## Agent skill

`skills/nerfwatch/SKILL.md` teaches coding agents when and how to run nerfwatch. Install it with:

```sh
npx skills add Abelo9996/nerfwatch
```

## Roadmap

- More adapters: OpenCode, Gemini CLI, DeepSeek Harness, pi. Each one is a single file; see [CONTRIBUTING.md](CONTRIBUTING.md).
- Served-model detection for Codex as its logs start recording it.
- A public, opt-in regression board where people can submit anonymized reports, so a change that hits many users shows up within hours. It will be part of an open agent evaluation lab together with the sibling projects below.

## Related projects

- [rerunbench](https://github.com/Abelo9996/rerunbench): measures how consistently a coding agent solves the same task across reruns.
- [snapback](https://github.com/Abelo9996/snapback): undo for any coding agent.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New adapters and real-world false positives (with an anonymized report attached) are the most useful contributions.

## License

MIT. See [LICENSE](LICENSE).
