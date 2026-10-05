---
description: Check local Claude Code and Codex session logs for changes you did not make (model, effort, context window, cache and token cost, tool errors)
argument-hint: "[--since 30d] [--agent claude|codex]"
disable-model-invocation: true
allowed-tools: Bash(nerf-watch *) Bash(npx -y nerf-watch *)
---

The user ran `/nerf-watch:check`. Arguments: "$ARGUMENTS"

Run nerf-watch as `nerf-watch` if that command exists on PATH, otherwise as
`npx -y nerf-watch` (Node 20+). Run `nerf-watch check $ARGUMENTS`, passing the
arguments through. Exit code 1 means at least one alert was found; that is a result,
not a failed command. nerf-watch reads the logs locally and sends nothing anywhere.

Summarize the result:

1. Start with the one-line verdict, then each alert, then each warning. For every
   finding give the agent, model, the before and after numbers with units, the CLI
   versions, the dates and the sample size exactly as printed. Do not round them
   into vague claims.
2. Say which findings are the strongest evidence: `-drift` findings compare the same
   CLI version and model over time; `-shift` findings happen at a CLI update. Tool
   error jumps often come from the user's own environment.
3. Ask whether the user changed the model, effort setting, plan or kind of work
   around the flagged dates before calling anything a regression.
4. Give the `Next:` step from each finding. If there are alerts or warnings, mention
   `/nerf-watch:share` for the public regression watch and
   `nerf-watch report --out nerf-watch-report.md` for a bug report.

If no logs were found, say so and ask where the agent's logs live (`--root
claude=DIR` or `--root codex=DIR`). Do not open or paste the raw session logs.
