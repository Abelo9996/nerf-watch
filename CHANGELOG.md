# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
