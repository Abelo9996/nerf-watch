---
name: nerf-watch
description: Find and cut the startup overhead eating a coding agent's (Claude Code, Codex) usage limits, and check whether the agent quietly got worse or more expensive, using local session logs and config with the nerf-watch CLI. Use this when the user is running out of usage limits or wants to use fewer tokens per request, asks what their system prompt / CLAUDE.md / AGENTS.md / MCP servers / skills / hooks cost before they type, wants to cut that overhead safely and prove it helped, or says the agent feels dumber, lazier, slower or "nerfed", suspects a different model is answering than the one they picked, asks whether a CLI update changed cost, caching, effort or context window, or wants evidence for a vendor bug report. Also use it to compare agent behavior across versions or over time from their own usage.
---

# nerf-watch

nerf-watch reads the session logs Claude Code and Codex already keep on this machine and reports changes the user did not make: a different model answering, lower reasoning effort, a smaller context window, more cache writes or uncached input per turn after a CLI update, a cache hit rate collapse, or more failing tool calls. It is local only and never uploads anything.

Run it with `npx nerf-watch <command>` (or `nerf-watch <command>` if installed). Node 20+ is required.

## Cut startup overhead (find it, fix it, prove it)

When the user is burning through usage limits or wants fewer tokens per request:

1. **Find it.** Run `npx nerf-watch overhead`. It reads startup tokens and cache hit rate from the logs and lists the config sources (read only). For real per-source numbers, run `npx nerf-watch overhead --measure`. This spends a little money (ablation runs through the agent CLI, cheapest model); it prints the run count and estimated cost first and does nothing without `--yes`, so show the user the plan and let them confirm before running `--measure --yes`. The result is a ranked table of source, tokens per request, share and evidence; the parts add up to the measured startup total within noise. Measured attribution is Claude Code only; for Codex, read the config and log evidence and say what is not measured.
2. **Fix it.** Run `npx nerf-watch fix` (dry run) and show the user the reversible edits. Nothing is preselected. Apply only what the user picks: `npx nerf-watch fix --apply --item <id>` (ids are listed in the dry run; comma-separate several). Edits are non-destructive (an MCP server is disabled, not deleted; a bulky memory section is moved to an on-demand file with a pointer). Hook scripts and credentials are never edited. Every touched file is backed up.
3. **Undo anytime.** `npx nerf-watch undo` restores every changed file byte for byte and removes files the fix created.
4. **Prove it.** After the fix and a few more sessions, run `npx nerf-watch proof`. It compares the user's sessions before and after the fix timestamp. If it says there are too few sessions yet, relay that honestly and tell them to come back later, do not spin the numbers. `--card card.png` writes a before/after image.

## Workflow

1. **Check first.** Run `npx nerf-watch check`. Exit code 1 means at least one alert; that is a result, not a failure of the command. Add `--agent claude` or `--agent codex` if the user only cares about one, and `--since 30d` if they mention a recent change.
2. **Read the findings, then explain them.** The output starts with a one-line verdict. Each finding has a severity, before and after numbers with units, CLI versions, dates and sample counts (turns, sessions or tool calls), a plain explanation, and a `Next:` step (`nextStep` in `--json`). Summarize the alerts first, in the user's terms (cost, rate limits, quality). Quote the numbers and versions; do not round them into vague claims.
3. **Rule out the user's own changes before calling something a nerf.** nerf-watch cannot see intent. Ask, or check, whether the user changed the model, effort setting, plan, or the kind of work they were doing around the flagged date. `-drift` findings compare the same CLI version and model over time, so they are the strongest evidence of a provider-side change (check the date in the title: the window ends at the last use of that version, which may be weeks ago); `-shift` findings happen at a CLI update. Tool error jumps are often the user's environment (for example a broken test suite), so say so. Token and tool error findings already require the change to appear in at least two of the user's projects, and subagent traffic and user-chosen effort are excluded, but a change in plan, config or hooks can still move every project at once.
4. **Show baselines when asked "what changed".** `scan` prints one row per (agent, CLI version, model) with median tokens per turn, cache hit rate and tool error rate. Use it to show the trend around a finding.
5. **Offer a shareable report** when the user wants to file a bug or post publicly: `npx nerf-watch report --out nerf-watch-report.md` (or `.json`). It contains only aggregate numbers, versions, model ids and dates. Tell the user to read it before sharing.
6. **Offer to contribute to the public regression watch** when there are warnings or alerts and the user wants others to see them: `npx nerf-watch share`. It prints the exact anonymized JSON that would be shared and a prefilled GitHub issue link on open-agent-lab. It makes no network request. Show the user the printed JSON and let them open the link and submit the issue themselves; only pass `--open` if they ask you to open it. Never submit the issue on their behalf. If `share` exits 2, it found something identifying in the payload and printed nothing; do not work around it.
7. **Offer a share card** when the user wants to post the result (X, Bluesky, a GitHub issue), including an all-clear: `npx nerf-watch card --out card.png` writes a 1200x630 image from the same anonymized payload as `share`, after the same privacy scan. `--out` takes `.svg` or `.png`; the PNG is rendered in process, with no system tools needed. Pass the same `--since` and `--agent` the user checked with. Show the user the printed headline and tell them to look at the image before posting. If it says there is too little history, there is no card to make yet. If `card` exits 2 because of the privacy scan, it wrote nothing; do not work around it.

## Phantom edits

When the user asks whether the agent claimed changes it did not make (it said "done" but the file did not change, or it "lies about edits"), run `npx nerf-watch phantom`. It finds turns whose final message claims a finished edit to named code ("Added `--words` to wc.py.") while every action in the turn was read-only. It prints counts per agent and per (CLI version, model), the phantom rate among edit claims, and up to 10 examples (`--limit`) with the claim and the local session file and line. It exits 0. Detection is heuristic and conservative: it misses phantom edits worded other ways, and a flagged turn is something for the user to check, not proof. Its output includes the agent's claim sentences and local file paths, so it is never part of `report`, `share` or `card`; do not paste it into a public issue for the user.

## Useful flags

- `--json` on any command for machine-readable output; prefer it when you need to process results.
- `--measure --yes` on `overhead` runs the ablation and allows the spend; `--repeats N` and `--measure-model <id>` tune it. Without `--yes` it prints the plan and cost and stops.
- `--apply --item <id>` on `fix` applies selected items; `--since-fix <when>` on `proof` sets the fix timestamp when there is no fix backup.
- `--limit N` on `phantom` sets how many examples to show (default 10).
- `--fail-on warn|alert|never` controls the exit code of `check` (default `alert`), for scripts and CI.
- `--root claude=DIR` / `--root codex=DIR` when logs live somewhere unusual. `--root` limits the run to the agents it names. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored automatically.

## Things to avoid

- Do not open or paste the raw session logs to "double check" a finding. They contain the user's prompts and file paths, and nerf-watch's numbers already come from them.
- Do not present a single warning as proof of a nerf. Thresholds are deliberately sensitive; the evidence lines (sample sizes, dates, versions) are what make a case.
- If `check` reports no logs found, the agent has not been used on this machine or the logs live elsewhere; ask for the location rather than guessing.
