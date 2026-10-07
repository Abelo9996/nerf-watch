import { join } from "node:path";
import type { Adapter, AgentEvent, DiscoverOptions, ParsedFile, ToolResult, Turn } from "../types.js";
import { parseCodexActivity } from "./codex-activity.js";
import { findFiles, num, readJsonl, sessionKeyFor, splitPathList, toMs, workloadKeyFor } from "./util.js";

/**
 * Codex writes "rollout" files under <CODEX_HOME>/sessions/YYYY/MM/DD/*.jsonl
 * (and archived ones under <CODEX_HOME>/archived_sessions). Every line is an
 * envelope { timestamp, type, payload }.
 *
 * Record shapes used:
 * - session_meta: payload.cli_version, payload.source (object with "subagent" for spawned threads),
 *   payload.cwd and payload.source (cli, vscode, exec, ...) form the workload key; cwd is hashed.
 * - turn_context: payload.model (requested), payload.effort
 * - event_msg/task_started: payload.model_context_window
 * - event_msg/token_count: payload.info.last_token_usage { input_tokens (includes cached),
 *   cached_input_tokens, output_tokens, reasoning_output_tokens }, info.total_token_usage,
 *   info.model_context_window. The same count is sometimes emitted twice; repeats of the
 *   running total are dropped.
 * - event_msg/exec_command_end (exit_code), patch_apply_end (success),
 *   mcp_tool_call_end (result.Err / isError): tool outcomes.
 * - event_msg/error: API or stream error.
 * - Any event whose payload names a served model (model_reroute style events, or
 *   info.model on token_count) sets the served model. Current Codex builds rarely
 *   record it, so requested-vs-served checks for Codex are best effort.
 */
export const codexAdapter: Adapter = {
  id: "codex",
  displayName: "Codex",

  defaultRoots({ env, homedir, platform }: DiscoverOptions): string[] {
    const delim = platform === "win32" ? ";" : ":";
    const fromEnv = splitPathList(env.CODEX_HOME, delim);
    const homes = fromEnv.length ? fromEnv : [join(homedir, ".codex")];
    return homes.flatMap((h) => [join(h, "sessions"), join(h, "archived_sessions")]);
  },

  discover(roots: string[]): Promise<string[]> {
    return findFiles(roots, ".jsonl", 5);
  },

  async parseFile(file: string): Promise<ParsedFile & { badLines: number }> {
    const sessionKey = sessionKeyFor("codex", file);
    const turns: Turn[] = [];
    const toolResults: ToolResult[] = [];
    const events: AgentEvent[] = [];
    let badLines = 0;
    let version: string | undefined;
    let requested: string | undefined;
    let served: string | undefined;
    let effort: string | undefined;
    let ctxWindow: number | undefined;
    let sidechain = false;
    let workloadKey: string | undefined;
    let lastTotal = -1;
    let sawFirst = false;

    const filter = (l: string) => !l.includes('"type":"response_item"') || l.includes("reroute");

    for await (const r of readJsonl(file, filter)) {
      if ("bad" in r) {
        badLines++;
        continue;
      }
      const o = r.value;
      if (!o || typeof o !== "object") continue;
      const p = o.payload ?? {};
      const ts = toMs(o.timestamp) ?? 0;

      if (o.type === "session_meta") {
        if (typeof p.cli_version === "string") version = p.cli_version;
        if (p.source && typeof p.source === "object" && "subagent" in p.source) sidechain = true;
        if (typeof p.cwd === "string") workloadKey = workloadKeyFor("codex", p.cwd, typeof p.source === "string" ? p.source : "subagent");
        continue;
      }
      if (o.type === "turn_context") {
        if (typeof p.model === "string") requested = p.model;
        if (typeof p.effort === "string") effort = p.effort;
        continue;
      }
      if (o.type !== "event_msg") continue;

      const servedHint = p.to_model ?? p.served_model ?? p.info?.model ?? (String(p.type ?? "").includes("reroute") ? p.model : undefined);
      if (typeof servedHint === "string" && servedHint) served = servedHint;

      switch (p.type) {
        case "task_started":
          if (num(p.model_context_window) > 0) ctxWindow = p.model_context_window;
          break;
        case "token_count": {
          const info = p.info;
          const last = info?.last_token_usage;
          if (!last) break;
          const total = num(info.total_token_usage?.total_tokens);
          if (total > 0 && total === lastTotal) break;
          lastTotal = total;
          if (num(info.model_context_window) > 0) ctxWindow = info.model_context_window;
          const cached = num(last.cached_input_tokens);
          if (num(last.input_tokens) + num(last.output_tokens) === 0) break;
          const t: Turn = {
            agent: "codex",
            sessionKey,
            dedupeKey: `codex:${o.timestamp}:${total}`,
            timestamp: ts,
            cliVersion: version,
            requestedModel: requested,
            servedModel: served,
            effort,
            contextWindow: ctxWindow,
            usage: {
              input: Math.max(0, num(last.input_tokens) - cached),
              cacheRead: cached,
              cacheCreation: 0,
              output: num(last.output_tokens),
              reasoning: num(last.reasoning_output_tokens),
            },
            sidechain,
            workloadKey,
          };
          if (!sidechain && !sawFirst) {
            t.firstInSession = true;
            sawFirst = true;
          }
          turns.push(t);
          break;
        }
        case "exec_command_end":
          toolResults.push(tool(ts, typeof p.exit_code === "number" ? p.exit_code !== 0 : p.status === "failed"));
          break;
        case "patch_apply_end":
          toolResults.push(tool(ts, p.success === false));
          break;
        case "mcp_tool_call_end": {
          const res = p.result;
          const isErr = !!res && typeof res === "object" && ("Err" in res || res.Ok?.isError === true || res.isError === true);
          toolResults.push(tool(ts, isErr));
          break;
        }
        case "error":
          events.push({ kind: "api_error", agent: "codex", timestamp: ts, cliVersion: version, model: served ?? requested });
          break;
      }
    }

    function tool(ts: number, isError: boolean): ToolResult {
      return { agent: "codex", sessionKey, timestamp: ts, cliVersion: version, model: served ?? requested, isError, workloadKey, sidechain };
    }

    return { turns, toolResults, events, badLines };
  },

  parseActivity: parseCodexActivity,
};
