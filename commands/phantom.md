---
description: Find turns in local Claude Code and Codex logs where the agent said it changed code but made no edit (phantom edits)
argument-hint: "[--since 30d] [--agent claude|codex] [--limit 10]"
disable-model-invocation: true
allowed-tools: Bash(nerf-watch *) Bash(npx -y nerf-watch *)
---

The user ran `/nerf-watch:phantom`. Arguments: "$ARGUMENTS"

Run nerf-watch as `nerf-watch` if that command exists on PATH, otherwise as
`npx -y nerf-watch` (Node 20+). Run `nerf-watch phantom $ARGUMENTS`, passing the
arguments through. It exits 0 whatever it finds. nerf-watch reads the logs locally
and sends nothing anywhere.

Summarize the result:

1. Start with the one-line verdict, then the per-agent rows and any (CLI version,
   model) rows with phantom turns: turns, edit claims, phantom turns and the rate,
   exactly as printed.
2. For each example, give the date, agent, CLI version, model and the claim as
   printed. Do not open the session files yourself unless the user asks; the file
   and line are there for the user to check.
3. Say plainly that detection is heuristic and conservative: it misses phantom
   edits worded other ways, and a flagged turn is something to check, not proof.
   A flagged turn can still describe work from an earlier session or a change the
   user made by hand.
4. If there are no edit claims or no phantom turns, say so in one sentence.

If no logs were found, say so and ask where the agent's logs live (`--root
claude=DIR` or `--root codex=DIR`). Do not paste raw session logs or the user's
prompts.
