import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAdapter } from "../src/adapters/codex.js";
import { tmp, writeLines } from "./helpers.js";

const tc = (ts: string, total: number, input: number, cached: number, out = 50, ctx = 258400) => ({
  timestamp: ts,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { total_tokens: total },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: 20, total_tokens: input + out },
      model_context_window: ctx,
    },
  },
});

describe("codex adapter", () => {
  it("parses turns, subtracts cached input and drops repeated token counts", async () => {
    const f = writeLines(join(tmp(), "2026", "09", "01", "rollout-a.jsonl"), [
      { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "x", cli_version: "0.141.0", source: "cli" } },
      { timestamp: "2026-09-01T00:00:01Z", type: "event_msg", payload: { type: "task_started", model_context_window: 353400 } },
      { timestamp: "2026-09-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.5", effort: "xhigh" } },
      { timestamp: "2026-09-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [] } },
      tc("2026-09-01T00:00:03Z", 1000, 900, 0),
      tc("2026-09-01T00:00:03Z", 1000, 900, 0),
      { timestamp: "2026-09-01T00:00:04Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: {} } },
      tc("2026-09-01T00:00:05Z", 3000, 2000, 1500),
    ]);
    const r = await codexAdapter.parseFile(f);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]).toMatchObject({ cliVersion: "0.141.0", requestedModel: "gpt-5.5", effort: "xhigh", contextWindow: 258400, firstInSession: true });
    expect(r.turns[1].usage).toMatchObject({ input: 500, cacheRead: 1500, cacheCreation: 0, output: 50, reasoning: 20 });
    expect(r.turns[1].servedModel).toBeUndefined();
  });

  it("reads tool outcomes, errors and served-model hints", async () => {
    const f = writeLines(join(tmp(), "rollout-b.jsonl"), [
      { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { cli_version: "0.141.0", source: { subagent: { thread_spawn: {} } } } },
      { timestamp: "2026-09-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.5", effort: "medium" } },
      { timestamp: "2026-09-01T00:00:02Z", type: "event_msg", payload: { type: "model_reroute", from_model: "gpt-5.5", to_model: "gpt-5.5-mini" } },
      { timestamp: "2026-09-01T00:00:03Z", type: "event_msg", payload: { type: "exec_command_end", exit_code: 1, status: "failed" } },
      { timestamp: "2026-09-01T00:00:03Z", type: "event_msg", payload: { type: "exec_command_end", exit_code: 0, status: "completed" } },
      { timestamp: "2026-09-01T00:00:04Z", type: "event_msg", payload: { type: "patch_apply_end", success: false } },
      { timestamp: "2026-09-01T00:00:04Z", type: "event_msg", payload: { type: "mcp_tool_call_end", result: { Err: "boom" } } },
      { timestamp: "2026-09-01T00:00:05Z", type: "event_msg", payload: { type: "error", message: "stream error" } },
      tc("2026-09-01T00:00:06Z", 100, 100, 0),
      "{truncated",
    ]);
    const r = await codexAdapter.parseFile(f);
    expect(r.toolResults.map((t) => t.isError)).toEqual([true, false, true, true]);
    expect(r.toolResults[0].model).toBe("gpt-5.5-mini");
    expect(r.events.map((e) => e.kind)).toEqual(["api_error"]);
    expect(r.turns[0]).toMatchObject({ servedModel: "gpt-5.5-mini", requestedModel: "gpt-5.5", sidechain: true });
    expect(r.turns[0].firstInSession).toBeUndefined();
    expect(r.badLines).toBe(1);
  });

  it("honors CODEX_HOME and includes archived sessions", () => {
    expect(codexAdapter.defaultRoots({ env: { CODEX_HOME: "/c" }, homedir: "/h", platform: "linux" })).toEqual([
      join("/c", "sessions"),
      join("/c", "archived_sessions"),
    ]);
    expect(codexAdapter.defaultRoots({ env: {}, homedir: "/h", platform: "darwin" })[0]).toBe(join("/h", ".codex", "sessions"));
  });
});
