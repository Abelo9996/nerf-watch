# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added

- `nerfwatch scan`: per-(agent, CLI version, model) baselines with median prompt, uncached input and output tokens per turn, cache hit rate, tool error rate, effort and context window.
- `nerfwatch check`: detectors for requested-vs-served model mismatch, unrecognized model ids, reasoning effort drops, context window shrink, uncached input and cache-creation jumps, session startup prompt growth, cache hit rate collapse, tool error rate jumps, and recorded model fallbacks. Version-boundary and same-version time-window comparisons. Non-zero exit on alerts (`--fail-on`).
- `nerfwatch report --out report.md|report.json`: anonymized report for vendor bug reports.
- Adapters for Claude Code and Codex, honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.
- `--since`, `--agent`, `--root`, `--json` flags.
- Agent skill at `skills/nerfwatch/SKILL.md`.
- Synthetic log generator (`scripts/make-demo-data.mjs`) and test suite.
