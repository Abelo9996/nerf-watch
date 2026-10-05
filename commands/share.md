---
description: Prepare an anonymized summary of nerf-watch findings and a prefilled issue link for the public regression watch (nothing is sent)
argument-hint: "[--since 30d] [--agent claude|codex]"
disable-model-invocation: true
allowed-tools: Bash(nerf-watch *) Bash(npx -y nerf-watch *)
---

The user ran `/nerf-watch:share`. Arguments: "$ARGUMENTS"

Run nerf-watch as `nerf-watch` if that command exists on PATH, otherwise as
`npx -y nerf-watch` (Node 20+). Run `nerf-watch share $ARGUMENTS` without `--open`.
It makes no network request: it prints the exact anonymized JSON that would be
shared and a prefilled GitHub issue link on the open-agent-lab regression watch.

1. If it exits 2, it found something identifying in the payload and printed
   nothing. Tell the user and stop; do not try to work around it.
2. If there are no warnings or alerts, say there is nothing worth sharing.
3. Otherwise show the printed JSON unchanged, in a code block, and summarize in one
   or two sentences what it contains (aggregate numbers, CLI versions, model ids and
   dates; no prompts, paths or project names).
4. Give the user the issue link and tell them to read the JSON, then open the link
   and submit the issue themselves if they want to. Never open the link, submit the
   issue or post anything on their behalf. Pass `--open` only if the user asks you
   to open the link in their browser.
