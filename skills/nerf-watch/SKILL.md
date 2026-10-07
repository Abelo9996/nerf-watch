---
name: nerf-watch
description: Check whether a coding agent (Claude Code, Codex) quietly got worse or more expensive by analyzing its local session logs with the nerf-watch CLI. Use this whenever the user says the agent feels dumber, lazier, slower or "nerfed", is burning through rate limits or tokens faster than before, suspects a different model is answering than the one they picked, asks whether a CLI update changed cost, caching, effort or context window, or wants evidence to attach to a vendor bug report. Also use it when the user asks to compare agent behavior across versions or over time from their own usage.
---

# nerf-watch

nerf-watch reads the session logs Claude Code and Codex already keep on this machine and reports changes the user did not make: a different model answering, lower reasoning effort, a smaller context window, more cache writes or uncached input per turn after a CLI update, a cache hit rate collapse, or more failing tool calls. It is local only and never uploads anything.

Run it with `npx nerf-watch <command>` (or `nerf-watch <command>` if installed). Node 20+ is required.

## Workflow

1. **Check first.** Run `npx nerf-watch check`. Exit code 1 means at least one alert; that is a result, not a failure of the command. Add `--agent claude` or `--agent codex` if the user only cares about one, and `--since 30d` if they mention a recent change.
2. **Read the findings, then explain them.** The output starts with a one-line verdict. Each finding has a severity, before and after numbers with units, CLI versions, dates and sample counts (turns, sessions or tool calls), a plain explanation, and a `Next:` step (`nextStep` in `--json`). Summarize the alerts first, in the user's terms (cost, rate limits, quality). Quote the numbers and versions; do not round them into vague claims.
3. **Rule out the user's own changes before calling something a nerf.** nerf-watch cannot see intent. Ask, or check, whether the user changed the model, effort setting, plan, or the kind of work they were doing around the flagged date. `-drift` findings compare the same CLI version and model over time, so they are the strongest evidence of a provider-side change (check the date in the title: the window ends at the last use of that version, which may be weeks ago); `-shift` findings happen at a CLI update. Tool error jumps are often the user's environment (for example a broken test suite), so say so. Token and tool error findings already require the change to appear in at least two of the user's projects, and subagent traffic and user-chosen effort are excluded, but a change in plan, config or hooks can still move every project at once.
4. **Show baselines when asked "what changed".** `scan` prints one row per (agent, CLI version, model) with median tokens per turn, cache hit rate and tool error rate. Use it to show the trend around a finding.
5. **Offer a shareable report** when the user wants to file a bug or post publicly: `npx nerf-watch report --out nerf-watch-report.md` (or `.json`). It contains only aggregate numbers, versions, model ids and dates. Tell the user to read it before sharing.
6. **Offer to contribute to the public regression watch** when there are warnings or alerts and the user wants others to see them: `npx nerf-watch share`. It prints the exact anonymized JSON that would be shared and a prefilled GitHub issue link on open-agent-lab. It makes no network request. Show the user the printed JSON and let them open the link and submit the issue themselves; only pass `--open` if they ask you to open it. Never submit the issue on their behalf. If `share` exits 2, it found something identifying in the payload and printed nothing; do not work around it.
7. **Offer a share card** when the user wants to post the result (X, Bluesky, a GitHub issue), including an all-clear: `npx nerf-watch card` writes `nerf-watch-card.svg` (1200x630) from the same anonymized payload as `share`, after the same privacy scan. Pass the same `--since` and `--agent` the user checked with. Show the user the printed headline and tell them to look at the image before posting. The output is SVG only; for X or Bluesky they need a PNG, which `card` explains how to make (`rsvg-convert`, or a browser screenshot). If it says there is too little history, there is no card to make yet. If `card` exits 2 because of the privacy scan, it wrote nothing; do not work around it.

## Phantom edits

When the user asks whether the agent claimed changes it did not make (it said "done" but the file did not change, or it "lies about edits"), run `npx nerf-watch phantom`. It finds turns whose final message claims a finished edit to named code ("Added `--words` to wc.py.") while every action in the turn was read-only. It prints counts per agent and per (CLI version, model), the phantom rate among edit claims, and up to 10 examples (`--limit`) with the claim and the local session file and line. It exits 0. Detection is heuristic and conservative: it misses phantom edits worded other ways, and a flagged turn is something for the user to check, not proof. Its output includes the agent's claim sentences and local file paths, so it is never part of `report`, `share` or `card`; do not paste it into a public issue for the user.

## Useful flags

- `--json` on any command for machine-readable output; prefer it when you need to process results.
- `--limit N` on `phantom` sets how many examples to show (default 10).
- `--fail-on warn|alert|never` controls the exit code of `check` (default `alert`), for scripts and CI.
- `--root claude=DIR` / `--root codex=DIR` when logs live somewhere unusual. `--root` limits the run to the agents it names. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored automatically.

## Things to avoid

- Do not open or paste the raw session logs to "double check" a finding. They contain the user's prompts and file paths, and nerf-watch's numbers already come from them.
- Do not present a single warning as proof of a nerf. Thresholds are deliberately sensitive; the evidence lines (sample sizes, dates, versions) are what make a case.
- If `check` reports no logs found, the agent has not been used on this machine or the logs live elsewhere; ask for the location rather than guessing.
