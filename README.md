# nerf-watch

[![ci](https://github.com/Abelo9996/nerf-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/Abelo9996/nerf-watch/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![nerf-watch check run on synthetic Claude Code logs, flagging a silent model swap from claude-opus-5 to claude-sonnet-5, a cache-write jump and a cache hit rate collapse after a CLI update](docs/demo.gif)

Find out when your coding agent quietly got worse or more expensive.

nerf-watch reads the session logs that Claude Code and Codex already write on your machine and flags changes you did not make: a different model answered than the one you picked, reasoning effort dropped, the context window shrank, cache writes per turn jumped after a CLI update, the cache hit rate collapsed, or tool calls started failing more often. Everything runs locally. Nothing is uploaded.

It is not a cost meter. Tools like [ccusage](https://github.com/ryoppippi/ccusage) already tell you what you spent. nerf-watch compares your own history across CLI versions and over time, and tells you what changed and when.

## Quickstart

Requires Node.js 20 or newer.

```sh
npx nerf-watch check
```

That reads every Claude Code and Codex session on the machine, prints what changed, and exits with status 1 if any alert fired. Other commands:

```sh
npx nerf-watch scan                          # baselines per CLI version and model
npx nerf-watch check --since 30d --agent claude
npx nerf-watch report --out nerf-watch-report.md   # anonymized, shareable
```

## Example

Output from `nerf-watch check` on the synthetic logs in `scripts/make-demo-data.mjs` (no real data):

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
       more often. The change shows up in 3 of 3 separate workloads (projects) that have enough
       data on both sides, so it is not explained by a change in what you worked on.

WARN   claude  claude-opus-5  Cache hit rate collapsed after CLI 2.1.272
       before    97.8%              cli 2.1.270, 2.1.271  2026-08-23 to 2026-09-16  n=780
       after     80.2%              cli 2.1.272  2026-09-19 to 2026-10-01  n=351

WARN   codex  gpt-5.5  Reasoning effort dropped from high to medium after CLI 0.141.0
       before    high (100% of sessions)     cli 0.140.0  2026-08-23 to 2026-09-09  n=8
       after     medium (100% of sessions)   cli 0.141.0  2026-09-12 to 2026-10-02  n=16

WARN   codex  gpt-5.5  Context window shrank in the last 7 days with no CLI change (0.141.0)
       before    353.4k             cli 0.141.0  2026-09-12 to 2026-09-23  n=240
       after     258.4k             cli 0.141.0  2026-09-26 to 2026-10-02  n=240

2 alert(s), 3 warning(s), 0 info
```

(Explanations trimmed for the last three findings.) To reproduce it:

```sh
node scripts/make-demo-data.mjs /tmp/nw-demo
nerf-watch check --root claude=/tmp/nw-demo/claude/projects --root codex=/tmp/nw-demo/codex/sessions
```

## What it detects

| Check | Finding id | Compares | Warn | Alert |
|---|---|---|---|---|
| Requested model differs from the model that answered | `model-mismatch` | every main-thread API response | 3+ responses or 0.5%+ | 5+ responses and 2%+ |
| Unrecognized or internal-looking model id answered | `hidden-model` | every served model id | any | |
| Default reasoning effort dropped | `effort-drop` | effort each main-thread session started with, per CLI version | any drop | |
| Context window shrank | `contextWindow-shift`, `-drift` | reported window (Codex) or prompt size at auto-compaction (Claude Code) | 10% smaller | 40% smaller |
| Uncached input tokens per turn jumped | `newInput-shift`, `-drift` | median of per-session medians | 1.5x | 2x |
| Cache-creation tokens per turn jumped | `cacheCreation-shift`, `-drift` | median of per-session medians | 1.5x | 2x |
| Session startup prompt grew | `firstTurnPrompt-shift` | prompt size of each session's first main-thread request | 1.3x | 1.75x |
| Cache hit rate collapsed | `cacheHitRate-shift`, `-drift` | cached prompt tokens / all prompt tokens | 15 points | 30 points |
| Tool call error rate jumped | `toolErrorRate-shift`, `-drift` | failed tool calls / all tool calls | +5 points and 1.5x | +10 points and 2x |
| Agent recorded a model fallback | `model-fallback` | fallback events | info only | |

`-shift` findings fire at a CLI version boundary for the same model. `-drift` findings compare the last 7 days with the 28 days before, using only the same CLI version and model in both windows, so the change cannot come from an update you installed.

Token and tool error checks only fire when the change also shows up inside at least two of your projects on their own (see [Controls for false positives](#controls-for-false-positives)). If you only use an agent in one project, those checks stay quiet.

Use `--fail-on warn` to make warnings fail scripts too, or `--fail-on never` to always exit 0.

## How it works

1. **Adapters** (`src/adapters/`) find each agent's log files and turn each line into a small canonical record: one per model API response (tokens, CLI version, requested and served model, effort, context window), one per tool result (error or not), plus a few events (fallbacks, compactions, API errors). Prompts and outputs are never read into these records.
2. **Baselines** group responses by (agent, CLI version, model). `nerf-watch scan` prints them.
3. **Detectors** walk each model's versions in order and compare each version (pooled with up to five following versions when it has little data) against the three versions before it (up to six when three hold too little data). When a threshold trips, the baseline restarts at the new version, so one regression is reported once. When the after side pools several versions, the title names the range. A separate pass compares recent and older traffic on the same version.
4. Medians are taken per session first, then across sessions, so one huge session cannot create a finding by itself. Each side of a comparison needs at least 5 sessions and 50 turns (5 new sessions for the startup prompt, 100 tool calls for error rates). The first request of each session is excluded from per-turn token metrics because it always pays a cold cache; it has its own startup metric.

### Controls for false positives

Most of what changes in your logs is your own work, not the agent. These controls came from checking findings against real logs:

- **Subagents are left out of token metrics.** A subagent's tokens per turn depend on which subagent ran and what it read. One burst of short file-reading subagents can triple the median cache writes per turn while the main conversation is unchanged.
- **Changes must hold within projects.** Each turn carries an opaque workload key (a hash of the project directory plus the client, such as the CLI or the desktop app). For per-turn token metrics and tool error rates, at least two workloads need enough data on both sides of the comparison (20 main-thread turns, or 30 tool calls), and at least two thirds of them, and no fewer than two, must cross the threshold on their own. A version where you happened to work in a different project, or ran a batch of short, error-prone tasks from another client, no longer reads as a regression. The startup prompt check needs new sessions from at least two workloads on each side.
- **Effort you chose is not a default.** Effort is counted once per main-thread session, by the level the session started with. Turns after `/effort` or `/model` are ignored, and the winning level needs 3 or more sessions, a 60% majority, and sessions from two workloads on both sides.
- **Model switches are not mismatches.** When the served model changes and the next model identity record confirms the new model, the responses in between are treated as part of your switch.
- **Copied history is dropped.** Some ways of continuing a session copy old records into a new file stamped with the newer CLI version. Records whose version stamp is older than the first sighting of three or more earlier versions are dropped as copies.
- **Context windows are settings, not samples.** They are compared without workload controls, but each side needs at least 20 reports.

Details per agent:

- **Claude Code** writes one line per content block, so responses are merged by message id and request id, and copies of the same response in resumed sessions are dropped. Responses whose final line (the one with a stop reason) was never written have a partial output count and are left out of the output median. The requested model comes from the session's model identity record; after a manual `/model` switch it is treated as unknown until the next identity record, so your own switches are not reported. Subagent transcripts are excluded from the model comparison.
- **Codex** reports `input_tokens` including cached tokens; nerf-watch splits them. Repeated `token_count` events are dropped. Current Codex logs record the requested model and effort but rarely the served model, so the requested-vs-served check for Codex only runs when a reroute event is present.

## Privacy

- Local only. nerf-watch reads files under your home directory and prints to your terminal. It makes no network requests and has no telemetry.
- `nerf-watch report` writes aggregate numbers only: token medians, rates, CLI versions, model ids, dates and counts. It contains no prompts, responses, tool output, file paths, project names or session ids. Model ids that look like account-specific deployments (ARNs, URLs, long numeric ids) are replaced with a hash. The test suite plants sentinel strings in synthetic logs and fails if any of them reach a report.
- Read the report before you share it. It is plain markdown or JSON.

## Supported agents

| Agent | Default location | Override |
|---|---|---|
| Claude Code | `~/.claude/projects`, `~/.config/claude/projects` | `CLAUDE_CONFIG_DIR` (comma separated for several), or `--root claude=DIR` |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` | `CODEX_HOME`, or `--root codex=DIR` |

Paths resolve the same way on macOS, Linux and Windows (`%USERPROFILE%\.claude`, `%USERPROFILE%\.codex`).

## Command reference

```text
nerf-watch scan    [--since WHEN] [--agent ID] [--root AGENT=DIR] [--json]
nerf-watch check   [--since WHEN] [--agent ID] [--root AGENT=DIR] [--json]
                   [--fail-on alert|warn|never] [--recent-days 7] [--baseline-days 28]
nerf-watch report  [--since WHEN] [--agent ID] [--root AGENT=DIR] [--json] [--out FILE.md|FILE.json]
```

`WHEN` is a date (`2026-09-01`) or a span (`12h`, `7d`, `4w`). Exit codes: 0 ok, 1 findings at or above `--fail-on`, 2 usage error.

## Agent skill

`skills/nerf-watch/SKILL.md` teaches coding agents when and how to run nerf-watch. Install it with:

```sh
npx skills add Abelo9996/nerf-watch
```

## Roadmap

- More adapters: OpenCode, Gemini CLI, DeepSeek Harness, pi. Each one is a single file; see [CONTRIBUTING.md](CONTRIBUTING.md).
- Served-model detection for Codex as its logs start recording it.
- A public, opt-in regression board where people can submit anonymized reports, so a change that hits many users shows up within hours. It will be part of an open agent evaluation lab together with the sibling projects below.

## Related projects

- [rerun-bench](https://github.com/Abelo9996/rerun-bench): measures how consistently a coding agent solves the same task across reruns.
- [snap-back](https://github.com/Abelo9996/snap-back): undo for any coding agent.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New adapters and real-world false positives (with an anonymized report attached) are the most useful contributions.

## License

MIT. See [LICENSE](LICENSE).
