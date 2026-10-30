# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `check` no longer warns that a gateway model is a hidden or A/B test model. Ids in the `vendor/model` form (with an optional variant such as `:free`) come from a gateway you set up yourself, such as OpenRouter. They are now reported once per agent as info and skip the hidden-model check. On one real log set this removed 7 of 14 warnings.
- `check` no longer compares scripted sessions (`claude -p`, the Agent SDK, `codex exec`) with interactive ones for the startup prompt and default effort rules, matching what `overhead` already did. Scripted runs load a smaller startup and run at whatever effort the script passes, so a version where they happened to outnumber interactive sessions produced a false "startup prompt grew" alert (about 18k scripted vs 56k interactive) and a false "effort dropped" warning. On one real log set, `check` went from 2 alerts and 14 warnings to 1 alert and 4 warnings.

## [0.5.0] - 2026-10-22

nerf-watch now delivers its headline end to end: see what loads into every Claude Code session before you type, cut the parts you never use in one command, and prove it from your own logs. Every finding used to end in "report it to the vendor"; now it ends in a smaller, measured, reversible change.

### Added

- `nerf-watch overhead` (no `--measure`) now attributes the real interactive startup from your logs, for free. Claude Code records each startup injection as an attachment row near the top of a session; nerf-watch sizes each one (the skill listing, each CLAUDE.md file, each SessionStart hook's injected output, the agent listing, deferred tools, MCP instructions, environment and session context) and calibrates them against that session's own first-turn usage (input + cache_creation + cache_read). It groups sessions by the model that answered and attributes the most-used one, so a handful of cheap experimental sessions cannot dilute the picture. The output is a ranked table by source, a drill-down per file / per hook / per server, and a base row (the system prompt and built-in tools, the part no attachment carries) that cross-checks the ~31.7k `claude -p` measures. The rows sum to the calibrated total within a stated tolerance. `--measure` is kept as an optional cross-check. Sessions from older CLI versions without attachments fall back to config estimates, which is stated. This closes the gap where `--measure` (through `claude -p`) could only see ~31.7k of a ~55k real interactive startup.
- `nerf-watch overhead` shows what you pay before you type anything, and why. From the logs: median startup tokens per agent and model, the trend, cache hit rate, and the share of a typical request that is fixed startup overhead. From config (read only): the sources that make it up, namely user and project CLAUDE.md / AGENTS.md (token count estimated locally), MCP servers (Claude `~/.claude.json` and project `.mcp.json`; Codex `~/.codex/config.toml`), skills, plugins, context-injecting SessionStart / UserPromptSubmit hooks, and the effort and model defaults.
- `nerf-watch overhead --measure` attributes real tokens to each source with ablation runs through the agent's own CLI flags (`--strict-mcp-config`, `--setting-sources`, `--mcp-config`, `--add-dir`); no config file is edited to measure. Each profile is repeated to beat noise, the cheapest model that keeps the system-prompt shape is used, and the real dollar cost is summed from the CLI. It prints the run count and estimated cost first and spends nothing without `--yes`. Output is a ranked table of source, tokens per request, share and evidence, whose parts add back up to the measured startup total (within stated noise). Measured attribution is Claude Code only; for Codex, config and log evidence are shown and what is not measured is stated plainly.
- `nerf-watch fix` now proposes usage-aware stashes: over a window (default 60 days, `--days`; `--threshold` for rarely-used) it lists the user skills and subagents it never saw invoked in your logs, each costed from the log attribution, and offers to move them into `~/.claude/.nerf-watch-stash` (a reversible move, never a delete). Families that share a prefix are offered as one group (for example "all unused gsd-* skills") and each member is also selectable on its own. Skills or subagents used in the window are never proposed. It prints the projected startup drop ("startup ~52.2k -> ~45.0k tokens per session (-14%)") computed from the attribution for the selected items, and SessionStart hook advice now carries each hook's measured injected size from the logs.
- `nerf-watch fix` turns the overhead into reversible, non-destructive changes (dry run by default; `--apply` applies only the items selected with `--item`, nothing preselected; `--json` for agents). It disables a global MCP server by stashing it under a nerf-watch key (not deleting it), moves a bulky memory section into an on-demand file with a pointer, pins an explicit effort level when unset, and flags context-injecting hooks and tool search as advice without editing hook scripts. Credentials are never touched. Every touched file is backed up first.
- `nerf-watch undo` restores every file a `fix --apply` changed, byte for byte, moves stashed skill and subagent directories back exactly, and removes files the fix created.
- `nerf-watch proof` compares your sessions from before and after the fix timestamp (the newest fix backup, or `--since-fix`): the attachment-based startup the fix removes and the real first-turn usage, both before vs after, plus tokens per turn, cache hit rate, and how much of each request the startup change saves. It is honest when there are too few sessions on either side, and `--card` writes a before/after image.
- `nerf-watch card --out card.png` now renders the PNG in process with a bundled WASM rasterizer (no librsvg or headless browser). Fonts already on the machine are read and passed to the rasterizer as buffers; nothing is bundled or downloaded, and the WASM module is loaded lazily only when a PNG is made.
- A progress line while reading logs on slow first runs.
- Library API: `logOverhead`, `buildAttribution`, `readStartupSamples`/`parseStartupFile`/`aggregateStartup`/`formatStartupAttribution`, `countUsage`, `scanConfig`, `measure`/`planClaudeAblation`, `buildFixItems`/`applyItems`/`undo`/`listUserSkills`/`listUserAgents`/`projectStartup`, `buildProof`/`buildStartupProof`, `proofCardModel`/`renderProofCardSvg`, `svgToPng`, and `estimateTokens`.

### Changed

- `card --out` accepts `.png` and renders it in process. The previous behavior (refuse PNG and print `rsvg-convert` instructions) is gone.

### Also in 0.5.0
- The startup-growth finding and the share card split the growth into Claude Code's own base prompt and your add-ons (skills, agents, hooks, memory files, MCP servers), so a card no longer blames the CLI when the cause is local.
- Startup attribution counts interactive sessions only (CLI and desktop app). Scripted `claude -p` and Agent SDK sessions load a different startup and are left out unless asked.
- `proof` reports how much of each request the startup change saves, instead of a sessions-per-limit ratio that overstated the gain when warm requests are much larger than the startup.

## [0.4.0] - 2026-10-07

### Added

- `nerf-watch phantom` finds phantom edits in your own history: turns (one prompt through the agent's final message for it) whose final message claims a finished edit to named code, such as "Added `--words` to wc.py.", while nothing in the turn could have changed a file. Edit, Write, MultiEdit and NotebookEdit (Claude Code), `apply_patch` and file changes (Codex), subagents, unknown tools and any shell command not known to be read-only all count as possible edits. Plans, hedges, negations, questions, offers, interrupted or errored turns, subagent transcripts, turns that ran `git diff`, `log`, `show` or `blame`, and claims that name something an earlier turn of the session edited are not flagged. It prints counts per agent and per (CLI version, model), the phantom rate among edit claims, and up to `--limit` examples (default 10) with the claim and the session file and line to check; `--json` for scripts. It never reads prompt text into its records, and its results are not part of `report`, `share` or `card`. Background: https://abelo9996.github.io/open-agent-lab/findings/2026-10-rerun-10x/
- Claude Code plugin command `/nerf-watch:phantom`.
- `phantom` reads Codex 0.160 code mode, where one `exec` call runs JavaScript that calls `tools.exec_command` and `tools.apply_patch`. Each command in the code is classified on its own; a command that is not a string literal, any other tool, or code with no tool call counts as a possible edit.
- `loadActivity`, `analyzePhantoms`, `findEditClaim` and `classifyCommand` in the library API, and an optional `parseActivity` method on adapters.

## [0.3.0] - 2026-10-05

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
