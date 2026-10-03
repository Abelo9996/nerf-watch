import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { tmp, writeLines } from "./helpers.js";

const usage = (cc: number, cr: number, out = 10) => ({
  input_tokens: 5,
  cache_creation_input_tokens: cc,
  cache_read_input_tokens: cr,
  output_tokens: out,
  output_tokens_details: { thinking_tokens: 3 },
});
const base = { sessionId: "s1", version: "2.1.100", isSidechain: false, cwd: "/x" };
const asst = (id: string, model: string, u: object, extra: object = {}) => ({
  ...base,
  type: "assistant",
  timestamp: "2026-09-01T00:00:00.000Z",
  requestId: `req_${id}`,
  effort: "high",
  message: { id: `msg_${id}`, model, content: [], usage: u },
  ...extra,
});

describe("claude adapter", () => {
  it("merges split content-block lines into one turn and keeps the final output count", async () => {
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      asst("1", "claude-opus-5", usage(100, 1000, 1)),
      asst("1", "claude-opus-5", usage(100, 1000, 250)),
      asst("2", "claude-opus-5", usage(50, 2000, 30)),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0].usage).toMatchObject({ input: 5, cacheCreation: 100, cacheRead: 1000, output: 250, reasoning: 3 });
    expect(r.turns[0].firstInSession).toBe(true);
    expect(r.turns[1].firstInSession).toBeUndefined();
    expect(r.turns[0].dedupeKey).toBe("claude:msg_1:req_1");
    expect(r.turns[0].effort).toBe("high");
    expect(r.turns[0].cliVersion).toBe("2.1.100");
  });

  it("reads requested model from identity records and forgets it after /model", async () => {
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      { ...base, type: "attachment", timestamp: "2026-09-01T00:00:00Z", attachment: { type: "model", identity: { modelId: "claude-opus-5[1m]" } } },
      asst("1", "claude-opus-5", usage(1, 1)),
      { ...base, type: "user", timestamp: "2026-09-01T00:01:00Z", message: { role: "user", content: "<command-name>/model</command-name>" } },
      asst("2", "claude-sonnet-5", usage(1, 1)),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns[0].requestedModel).toBe("claude-opus-5[1m]");
    expect(r.turns[1].requestedModel).toBeUndefined();
    expect(r.turns[1].servedModel).toBe("claude-sonnet-5");
  });

  it("counts tool results and errors", async () => {
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      asst("1", "claude-opus-5", usage(1, 1)),
      { ...base, type: "user", timestamp: "2026-09-01T00:00:01Z", message: { content: [{ type: "tool_result", is_error: true }, { type: "tool_result", is_error: false }, { type: "tool_result" }] } },
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.toolResults.map((t) => t.isError)).toEqual([true, false, false]);
    expect(r.toolResults[0].model).toBe("claude-opus-5");
  });

  it("records fallbacks, compactions and API error stubs, and skips synthetic turns", async () => {
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      { ...base, type: "system", subtype: "model_consent_fallback", timestamp: "2026-09-01T00:00:00Z", originalModel: "claude-fable-5", fallbackModel: "claude-opus-4-8[1m]" },
      asst("1", "claude-opus-4-8", usage(1, 1)),
      { ...base, type: "system", subtype: "compact_boundary", timestamp: "2026-09-01T00:00:02Z", compactMetadata: { trigger: "auto", preTokens: 190000 } },
      asst("2", "<synthetic>", usage(0, 0), { isApiErrorMessage: true }),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].requestedModel).toBe("claude-opus-4-8[1m]");
    expect(r.events.map((e) => e.kind)).toEqual(["fallback", "compaction", "api_error"]);
  });

  it("marks subagent transcripts as sidechain and tolerates bad lines", async () => {
    const f = writeLines(join(tmp(), "p", "sess", "subagents", "agent-1.jsonl"), [asst("1", "claude-haiku-5", usage(1, 1)), "{not json", ""]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns[0].sidechain).toBe(true);
    expect(r.turns[0].firstInSession).toBeUndefined();
    expect(r.badLines).toBe(0); // the bad line does not contain any record marker, so it is never parsed
    const g = writeLines(join(tmp(), "p", "b.jsonl"), ['{"type":"assistant", broken']);
    expect((await claudeAdapter.parseFile(g)).badLines).toBe(1);
  });

  it("honors CLAUDE_CONFIG_DIR, including multiple dirs", () => {
    const roots = claudeAdapter.defaultRoots({ env: { CLAUDE_CONFIG_DIR: "/a,/b" }, homedir: "/home/u", platform: "linux" });
    expect(roots).toEqual([join("/a", "projects"), join("/b", "projects")]);
    const def = claudeAdapter.defaultRoots({ env: {}, homedir: "/home/u", platform: "linux" });
    expect(def).toEqual([join("/home/u", ".claude", "projects"), join("/home/u", ".config", "claude", "projects")]);
    const win = claudeAdapter.defaultRoots({ env: { CLAUDE_CONFIG_DIR: "C:\\Users\\u\\.claude" }, homedir: "C:\\Users\\u", platform: "win32" });
    expect(win).toHaveLength(1);
    expect(win[0].startsWith("C:\\Users\\u\\.claude")).toBe(true);
  });
});
