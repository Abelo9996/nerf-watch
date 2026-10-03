---
name: nerf-watch
description: Check whether a coding agent (Claude Code, Codex) quietly got worse or more expensive by analyzing its local session logs with the nerf-watch CLI. Use this whenever the user says the agent feels dumber, lazier, slower or "nerfed", is burning through rate limits or tokens faster than before, suspects a different model is answering than the one they picked, asks whether a CLI update changed cost, caching, effort or context window, or wants evidence to attach to a vendor bug report. Also use it when the user asks to compare agent behavior across versions or over time from their own usage.
---

# nerf-watch

nerf-watch reads the session logs Claude Code and Codex already keep on this machine and reports changes the user did not make: a different model answering, lower reasoning effort, a smaller context window, more cache writes or uncached input per turn after a CLI update, a cache hit rate collapse, or more failing tool calls. It is local only and never uploads anything.

Run it with `npx github:Abelo9996/nerf-watch <command>` (or `nerf-watch <command>` if installed). Node 20+ is required.

## Workflow

1. **Check first.** Run `npx github:Abelo9996/nerf-watch check`. Exit code 1 means at least one alert; that is a result, not a failure of the command. Add `--agent claude` or `--agent codex` if the user only cares about one, and `--since 30d` if they mention a recent change.
2. **Read the findings, then explain them.** Each finding has a severity, before and after numbers with CLI versions, dates and sample counts, and a plain explanation. Summarize the alerts first, in the user's terms (cost, rate limits, quality). Quote the numbers and versions; do not round them into vague claims.
3. **Rule out the user's own changes before calling something a nerf.** nerf-watch cannot see intent. Ask, or check, whether the user changed the model, effort setting, plan, or the kind of work they were doing around the flagged date. `-drift` findings compare the same CLI version and model over time, so they are the strongest evidence of a provider-side change; `-shift` findings happen at a CLI update. Tool error jumps are often the user's environment (for example a broken test suite), so say so.
4. **Show baselines when asked "what changed".** `scan` prints one row per (agent, CLI version, model) with median tokens per turn, cache hit rate and tool error rate. Use it to show the trend around a finding.
5. **Offer a shareable report** when the user wants to file a bug or post publicly: `npx github:Abelo9996/nerf-watch report --out nerf-watch-report.md` (or `.json`). It contains only aggregate numbers, versions, model ids and dates. Tell the user to read it before sharing.

## Useful flags

- `--json` on any command for machine-readable output; prefer it when you need to process results.
- `--fail-on warn|alert|never` controls the exit code of `check` (default `alert`), for scripts and CI.
- `--root claude=DIR` / `--root codex=DIR` when logs live somewhere unusual. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored automatically.

## Things to avoid

- Do not open or paste the raw session logs to "double check" a finding. They contain the user's prompts and file paths, and nerf-watch's numbers already come from them.
- Do not present a single warning as proof of a nerf. Thresholds are deliberately sensitive; the evidence lines (sample sizes, dates, versions) are what make a case.
- If `check` reports no logs found, the agent has not been used on this machine or the logs live elsewhere; ask for the location rather than guessing.
