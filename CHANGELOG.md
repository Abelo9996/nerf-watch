# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `nerf-watch phantom` finds phantom edits in your own history: turns (one prompt through the agent's final message for it) whose final message claims a finished edit to named code, such as "Added `--words` to wc.py.", while nothing in the turn could have changed a file. Edit, Write, MultiEdit and NotebookEdit (Claude Code), `apply_patch` and file changes (Codex), subagents, unknown tools and any shell command not known to be read-only all count as possible edits. Plans, hedges, negations, questions, offers, interrupted or errored turns, subagent transcripts, turns that ran `git diff`, `log`, `show` or `blame`, and claims that name something an earlier turn of the session edited are not flagged. It prints counts per agent and per (CLI version, model), the phantom rate among edit claims, and up to `--limit` examples (default 10) with the claim and the session file and line to check; `--json` for scripts. It never reads prompt text into its records, and its results are not part of `report`, `share` or `card`. Background: https://abelo9996.github.io/open-agent-lab/findings/2026-10-rerun-10x/
- Claude Code plugin command `/nerf-watch:phantom`.
- `phantom` reads Codex 0.160 code mode, where one `exec` call runs JavaScript that calls `tools.exec_command` and `tools.apply_patch`. Each command in the code is classified on its own; a command that is not a string literal, any other tool, or code with no tool call counts as a possible edit.
- `loadActivity`, `analyzePhantoms`, `findEditClaim` and `classifyCommand` in the library API, and an optional `parseActivity` method on adapters.

## [0.3.0] - Unreleased

### Added

- `nerf-watch card` writes a 1200x630 SVG of your result (the size X, Bluesky and link previews use): a headline such as "Cache writes per turn up 3.3x after Claude Code 2.1.272" or "No silent changes in Claude Code or Codex over the last 30 days", up to three findings with severity and before and after values, how many responses and sessions were compared, the date range, and a footer with `npx nerf-watch check` and the repository. It is drawn only from the anonymized `share` payload after the same privacy scan, uses the system fonts, has no new dependencies, and follows light or dark mode where the viewer supports it. With too little history it writes nothing. `--out` takes an `.svg` path; PNG is not built in, and `card` prints how to convert (`rsvg-convert`, or a browser screenshot). `--json` reports what was written.
- `check` ends with the `card` command (with the same `--since` and `--agent`) when there is something to post, including an all-clear.
- Menu bar app: "Save share card" runs `nerf-watch card` into Downloads and shows the file in Finder.
- Claude Code plugin (`/plugin install nerf-watch@open-agent-lab` after `/plugin marketplace add Abelo9996/open-agent-lab`) with the skill and the commands `/nerf-watch:check` and `/nerf-watch:share`, and a Codex plugin manifest with the skill and an icon. The plugins run the CLI through `npx`; the npm package itself is unchanged.
- `scripts/make-demo-data.mjs --clean` writes synthetic logs with no changes, for the all-clear case.

## [0.2.1] - 2026-10-04

### Fixed

- Context window findings need reports from at least 3 sessions on each side, and each session counts once (by its most common window). A window change seen in one or two sessions, for example a session resumed with a different config, was reported as a provider-side shrink on real logs.
- Same-version drift findings said "in the last 7 days" even when the recent window ended months ago (it ends at the last use of that CLI version and model). Titles now name the end date: "in the 7 days to 2026-10-02". The menu bar app says "Over time, with no CLI update" instead of "Recently".
- The requested side of a model-mismatch finding now covers every response for the requested model (its own versions, dates and count), not only the mismatched ones.
- `--root claude=DIR` on its own no longer also reads the default Codex logs (and the reverse). `--root` with an unknown agent name is a usage error instead of being ignored.
- `--recent-days` and `--baseline-days` reject values that are not whole numbers of 1 or more; `abc` used to switch the drift checks off silently.
- `report --out` with a wrong extension fails before reading any logs.

### Changed

- `check` starts with a plain-English summary: how much was read, and the verdict in one sentence. When there is too little history for any comparison, it says so instead of "no changes".
- Every finding has a `Next:` step (`nextStep` in `--json`), and every evidence line labels its units: token values say "tokens", sample counts say "turns", "sessions" or "tool calls" (`sampleUnit` in `--json`). The report and the menu bar app show both.
- When nothing is found, the message lists the folders that were actually searched (including `--root` folders and `~/.codex/archived_sessions`), and says whether logs were found but were outside the `--since` window.
- `share` says why sharing helps and reminds you to fill in "What you observed" and tick the checkboxes on the issue form.
- `nerf-watch` with no command prints the help and where to start.
- Menu bar app: error states say what to do next, and long date ranges wrap instead of being cut off.

## [0.2.0] - 2026-10-03

### Added

- macOS menu bar app (`apps/macos/`, macOS 13+, SwiftUI, no dependencies). Runs `nerf-watch check --json` on a schedule and on demand and shows a green, yellow, red or grey status icon with a distinct shape per state, a findings list with a details view of the evidence, Copy anonymized report, launch at login, and a notification when a new alert appears. It only runs the local CLI. `apps/macos/build.sh` builds an unsigned universal `NerfWatch-macOS.zip`; a workflow builds and tests it and attaches the zip to the GitHub release on tag push.
- `nerf-watch share` (also `report --share`): builds a small anonymized payload of warning and alert findings (detector, signal, severity, agent, model ids, CLI versions, dates, sample counts, before and after values; no free text), scans every value for paths, emails, URLs, session ids, long ids and the local user, home directory and host names, prints it, and prints a prefilled regression-report issue link on open-agent-lab. `--open` opens the link in the browser. Falls back to the form without the JSON when the link would be too long. No network requests.
- Model-mismatch findings carry `requestedModel`; `report` scrubs it like `model`.

### Changed

- `check` points to `nerf-watch share` when it finds warnings or alerts.

## [0.1.0] - 2026-10-03

### Added

- `nerf-watch scan`: per-(agent, CLI version, model) baselines with median prompt, uncached input and output tokens per turn, cache hit rate, tool error rate, effort and context window.
- `nerf-watch check`: detectors for requested-vs-served model mismatch, unrecognized model ids, reasoning effort drops, context window shrink, uncached input and cache-creation jumps, session startup prompt growth, cache hit rate collapse, tool error rate jumps, and recorded model fallbacks. Version-boundary and same-version time-window comparisons. Non-zero exit on alerts (`--fail-on`).
- `nerf-watch report --out report.md|report.json`: anonymized report for vendor bug reports.
- Adapters for Claude Code and Codex, honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
- `--since`, `--agent`, `--root`, `--json` flags.
- Agent skill at `skills/nerf-watch/SKILL.md`.
- Synthetic log generator (`scripts/make-demo-data.mjs`) and test suite.

### Changed

- Renamed the project from `nerfwatch` to `nerf-watch`. The package name, the command (`nerf-watch`), the repository URL (github.com/Abelo9996/nerf-watch), the skill directory (`skills/nerf-watch/`) and the default report file name (`nerf-watch-report.md`) all use the new name. GitHub redirects the old repository URL. Install with `npx nerf-watch check`.
- Token metrics (uncached input, cache writes, cache hit rate, startup prompt) use main-thread turns only. Subagent traffic depends on which subagent ran and produced most of the false positives seen on real logs.
- Per-turn token and tool error checks are compared within workloads (an opaque hash of the project directory plus the client). A change must show up in at least two workloads, and in at least two thirds of the workloads with data on both sides.
- The effort check counts each main-thread session once, by the effort it started with, ignores turns after `/effort` or `/model`, and needs 3 or more sessions from two workloads on each side.
- Version windows widen to up to six versions when three hold too little data. Findings whose after side pools several versions name the range.
- Context window comparisons need at least 20 reports per side.
- `scan` shows the share of subagent turns per row.

### Fixed

- A model switch made outside a recorded `/model` command (for example in the desktop app) was reported as a requested-vs-served mismatch for the responses served before the identity record caught up.
- Records copied into a continued session with a newer CLI version stamp but their original timestamps were counted as traffic on the newer version.
- Streaming stubs without a final line were counted with their partial output tokens (often under 20), dragging the output median down.
- Placeholder responses with no token counts could be taken as a session's first request.
