# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Renamed the project from `nerfwatch` to `nerf-watch`. The package name, the command (`nerf-watch`), the repository URL (github.com/Abelo9996/nerf-watch), the skill directory (`skills/nerf-watch/`) and the default report file name (`nerf-watch-report.md`) all use the new name. GitHub redirects the old repository URL. Install with `npx github:Abelo9996/nerf-watch check`.

## [0.1.0] - 2026-10-03

### Added

- `nerf-watch scan`: per-(agent, CLI version, model) baselines with median prompt, uncached input and output tokens per turn, cache hit rate, tool error rate, effort and context window.
- `nerf-watch check`: detectors for requested-vs-served model mismatch, unrecognized model ids, reasoning effort drops, context window shrink, uncached input and cache-creation jumps, session startup prompt growth, cache hit rate collapse, tool error rate jumps, and recorded model fallbacks. Version-boundary and same-version time-window comparisons. Non-zero exit on alerts (`--fail-on`).
- `nerf-watch report --out report.md|report.json`: anonymized report for vendor bug reports.
- Adapters for Claude Code and Codex, honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
- `--since`, `--agent`, `--root`, `--json` flags.
- Agent skill at `skills/nerf-watch/SKILL.md`.
- Synthetic log generator (`scripts/make-demo-data.mjs`) and test suite.
