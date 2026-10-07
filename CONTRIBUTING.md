# Contributing to nerf-watch

Thanks for helping. The two most useful contributions are new agent adapters and reports of false positives or missed regressions from real use.

## Setup

```sh
git clone https://github.com/Abelo9996/nerf-watch
cd nerf-watch
npm install        # also builds dist/ via the prepare script
npm test           # builds, then runs vitest
node dist/cli.js scan
```

Node 20 or newer. No native dependencies; keep it that way so `npx nerf-watch` (and installs straight from GitHub) work everywhere.

## Ground rules

- **Never commit real session logs**, or anything copied from them: prompts, paths, project names, session ids. Tests use synthetic data from `scripts/make-demo-data.mjs` or records written inline in the test.
- Nothing may make network requests. nerf-watch is local only.
- Records produced by adapters (`src/types.ts`) must not carry prompt text, tool output or paths. The CLI test checks reports for planted sentinel strings; keep that test passing.
- The one exception is `ActivityTurn`, read only by `nerf-watch phantom`: it carries the agent's final message and the session file path for local output, never prompt text, and must never reach `report`, `share` or `card`.
- Plain, specific wording in output and docs.

## Adding an adapter

An adapter is one file in `src/adapters/` that implements the `Adapter` interface from `src/types.ts`:

```ts
export interface Adapter {
  id: string;                     // used by --agent and --root, e.g. "gemini"
  displayName: string;
  defaultRoots(opts): string[];   // where the logs live; read env overrides first
  discover(roots): Promise<string[]>;
  parseFile(file): Promise<{ turns; toolResults; events; badLines }>;
  parseActivity?(file): Promise<{ turns; badLines }>;  // optional, for `phantom`
}
```

Steps:

1. **Learn the format from your own logs, locally.** Print keys and value types, not content. For JSONL, something like
   `jq -c '[.type, (keys|join(","))]' some-session.jsonl | sort | uniq -c` shows record shapes without exposing text.
2. **Write `src/adapters/<agent>.ts`.** Use `findFiles` and `readJsonl` from `./util.js`. Pass a cheap string filter to `readJsonl` so large records you do not need are never JSON-parsed. Emit:
   - one `Turn` per model API response, with `usage` normalized so that `input` excludes cached tokens, plus `cliVersion`, `requestedModel` and `servedModel` when the log has them, `effort`, `contextWindow`, `firstInSession` on the first main-thread response, `sidechain` for subagent traffic, a `workloadKey` (use `workloadKeyFor` with the project directory and client so the key is a hash), `effortSetByUser` when the log shows the user changed effort, and a `dedupeKey` if the same response can appear in more than one file;
   - one `ToolResult` per tool call outcome, with the same `workloadKey` and `sidechain`;
   - `AgentEvent`s for fallbacks, compactions and API errors if the agent records them.
3. **Document the record shapes you rely on** in a comment at the top of the file, the way `claude.ts` and `codex.ts` do. Formats change; this is how the next person finds what broke.
4. **Register it** in `src/adapters/index.ts`.
5. **Test it** in `test/<agent>-adapter.test.ts` with synthetic lines that mimic the schema: token normalization, dedupe, tool errors, env overrides for the log directory, and malformed lines. If you can, add a generator to `scripts/make-demo-data.mjs`.
6. **Update** the supported agents table in `README.md` and the `CHANGELOG.md`.

Detectors work on the canonical records, so a new adapter gets every check for free. If the agent does not record something (for example the served model), leave the field undefined and the related check is skipped.

## Changing a detector or threshold

Thresholds live in `src/detectors.ts` (`RULES`) and minimum sample sizes in `src/metrics.ts` (`MIN`, and `MIN_STRATUM` for one workload). Include a test with a positive case and a quiet case. If the change is motivated by real-world noise, describe the pattern in the PR (numbers only) and add a synthetic reproduction to `test/false-positives.test.ts`.

## Pull requests

- `npm test` and `npm run typecheck` pass.
- One topic per PR. Update `CHANGELOG.md` under Unreleased.
