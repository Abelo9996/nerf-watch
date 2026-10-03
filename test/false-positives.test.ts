// Regression tests for false positives seen on real logs. Every dataset here is
// synthetic: it reproduces the shape of the confounder (who ran what, where,
// with which settings), not any real numbers or sessions.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { detectEffortDrops, detectModelMismatch, detectTimeShifts, detectVersionShifts, runDetectors } from "../src/detectors.js";
import { dropStaleCopies, loadDataset } from "../src/load.js";
import { buildSegments } from "../src/metrics.js";
import type { Dataset, ToolResult, Turn } from "../src/types.js";
import { tmp, writeLines } from "./helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 6, 1);

interface Spec {
  version: string;
  day: number;
  workload?: string;
  model?: string;
  sessions?: number;
  turnsPerSession?: number;
  /** Mean cache-creation tokens per warm turn. */
  cacheCreation?: number;
  cacheRead?: number;
  firstPrompt?: number;
  /** Subagent transcripts (one session key per transcript). */
  sidechain?: boolean;
  toolErrorRate?: number;
  effort?: string;
  /** Effort the session starts with before the user changes it to `effort`. */
  startEffort?: string;
  /** Turn index from which `effort` counts as user-chosen (default 2 when startEffort is set). */
  userEffortFrom?: number;
  contextWindow?: number;
}

let seq = 0;
function build(specs: Spec[]): Dataset {
  const turns: Turn[] = [];
  const toolResults: ToolResult[] = [];
  for (const s of specs) {
    for (let i = 0; i < (s.sessions ?? 4); i++) {
      const sessionKey = `s${seq++}`;
      const tps = s.turnsPerSession ?? 30;
      for (let j = 0; j < tps; j++) {
        const ts = T0 + s.day * DAY + i * 3_600_000 + j * 60_000;
        const jitter = 1 + ((j % 5) - 2) * 0.05;
        const first = !s.sidechain && j === 0;
        const userFrom = s.userEffortFrom ?? (s.startEffort !== undefined ? 2 : Infinity);
        const userEffort = j >= userFrom;
        turns.push({
          agent: "claude",
          sessionKey,
          workloadKey: s.workload ?? "w1",
          sidechain: s.sidechain || undefined,
          timestamp: ts,
          cliVersion: s.version,
          servedModel: s.model ?? "claude-opus-5",
          effort: s.startEffort !== undefined && !userEffort ? s.startEffort : s.effort,
          effortSetByUser: userEffort || undefined,
          contextWindow: s.contextWindow,
          firstInSession: first || undefined,
          usage: {
            input: 5,
            cacheCreation: first ? (s.firstPrompt ?? 20000) : Math.round((s.cacheCreation ?? 800) * jitter),
            cacheRead: first ? 0 : Math.round((s.cacheRead ?? 40000) * jitter),
            output: 300,
          },
        });
        const every = s.toolErrorRate ? Math.round(1 / s.toolErrorRate) : 0;
        toolResults.push({
          agent: "claude",
          sessionKey,
          workloadKey: s.workload ?? "w1",
          sidechain: s.sidechain || undefined,
          timestamp: ts + 1,
          cliVersion: s.version,
          model: s.model ?? "claude-opus-5",
          isError: every > 0 && (i * tps + j) % every === 0,
        });
      }
    }
  }
  turns.sort((a, b) => a.timestamp - b.timestamp);
  return { turns, toolResults, events: [], files: { claude: 1 }, badLines: {} };
}

/** Main-thread sessions in two projects on four versions, all stable. */
const mainline = (versions: string[], extra: Partial<Spec> = {}): Spec[] =>
  versions.flatMap((version, k) => [
    { version, day: k * 5, workload: "proj-a", ...extra },
    { version, day: k * 5 + 1, workload: "proj-b", ...extra },
  ]);

describe("false positive: subagent mix", () => {
  it("does not report a cache-creation jump when only subagent traffic changed", () => {
    const ds = build([
      ...mainline(["2.1.1", "2.1.2", "2.1.3", "2.1.4"]),
      // A burst of short subagents that read large files: big cache writes per turn.
      { version: "2.1.4", day: 16, workload: "proj-a", sidechain: true, sessions: 40, turnsPerSession: 6, cacheCreation: 4000 },
    ]);
    expect(detectVersionShifts(ds)).toEqual([]);
  });

  it("does not report a jump when the only main-thread data is subagent-heavy versions", () => {
    // The baseline versions have almost no main-thread data; the after version
    // is all subagents. Pooling them used to compare unlike traffic.
    const ds = build([
      { version: "2.1.1", day: 0, workload: "proj-a", sessions: 10, turnsPerSession: 2, cacheCreation: 500 },
      { version: "2.1.1", day: 0, workload: "proj-a", sidechain: true, sessions: 1, turnsPerSession: 40, cacheCreation: 2500 },
      { version: "2.1.2", day: 5, workload: "proj-b", sidechain: true, sessions: 40, turnsPerSession: 100, cacheCreation: 1500 },
      { version: "2.1.2", day: 5, workload: "proj-a", sessions: 9, turnsPerSession: 2, cacheCreation: 600 },
    ]);
    expect(runDetectors(ds)).toEqual([]);
  });

  it("still reports a main-thread jump that shows up in every project", () => {
    const ds = build([
      ...mainline(["2.1.1", "2.1.2", "2.1.3"]),
      ...mainline(["2.1.4", "2.1.5"], { cacheCreation: 2600 }).map((s) => ({ ...s, day: s.day + 15 })),
      { version: "2.1.4", day: 16, workload: "proj-a", sidechain: true, sessions: 10, cacheCreation: 800 },
    ]);
    const f = detectVersionShifts(ds);
    expect(f.map((x) => [x.id, x.severity])).toEqual([["cacheCreation-shift", "alert"]]);
    expect(f[0].evidence[1].versions?.[0]).toBe("2.1.4");
    expect(f[0].explanation).toContain("2 of 2 separate workloads");
  });
});

describe("false positive: one project's workload", () => {
  it("ignores a jump confined to one project", () => {
    const ds = build([
      ...mainline(["2.1.1", "2.1.2", "2.1.3"]),
      { version: "2.1.4", day: 15, workload: "proj-a", cacheCreation: 3800 },
      { version: "2.1.4", day: 16, workload: "proj-b", cacheCreation: 820 },
    ]);
    expect(detectVersionShifts(ds)).toEqual([]);
  });

  it("ignores a jump when the after window has data from one project only", () => {
    const ds = build([
      ...mainline(["2.1.1", "2.1.2", "2.1.3"]),
      { version: "2.1.4", day: 15, workload: "proj-c", sessions: 6, cacheCreation: 3800 },
    ]);
    expect(detectVersionShifts(ds)).toEqual([]);
  });

  it("ignores a same-version drift caused by a new project", () => {
    const ds = build([
      { version: "2.1.9", day: 0, workload: "proj-a" },
      { version: "2.1.9", day: 10, workload: "proj-b" },
      { version: "2.1.9", day: 22, workload: "proj-c", sessions: 6, cacheRead: 1000 },
    ]);
    expect(detectTimeShifts(ds)).toEqual([]);
  });
});

describe("false positive: tool error rate from workload mix", () => {
  it("does not report a jump when an error-prone workload's share grew", () => {
    // proj-short: many 2-turn sessions with a high, unchanged error rate.
    // proj-long: long sessions with a low, unchanged error rate.
    const ds = build([
      { version: "2.1.1", day: 0, workload: "proj-long", sessions: 8, turnsPerSession: 60, toolErrorRate: 0.02 },
      { version: "2.1.1", day: 1, workload: "proj-short", sessions: 8, turnsPerSession: 2, toolErrorRate: 0.4 },
      { version: "2.1.2", day: 5, workload: "proj-long", sessions: 1, turnsPerSession: 60, toolErrorRate: 0.02 },
      { version: "2.1.2", day: 6, workload: "proj-short", sessions: 30, turnsPerSession: 2, toolErrorRate: 0.4 },
    ]);
    expect(detectVersionShifts(ds).filter((f) => f.id.startsWith("toolErrorRate"))).toEqual([]);
  });

  it("still reports a jump that happens inside each project", () => {
    const ds = build([
      { version: "2.1.1", day: 0, workload: "proj-a", sessions: 4, turnsPerSession: 40, toolErrorRate: 0.02 },
      { version: "2.1.1", day: 1, workload: "proj-b", sessions: 4, turnsPerSession: 40, toolErrorRate: 0.02 },
      { version: "2.1.2", day: 5, workload: "proj-a", sessions: 4, turnsPerSession: 40, toolErrorRate: 0.25 },
      { version: "2.1.2", day: 6, workload: "proj-b", sessions: 4, turnsPerSession: 40, toolErrorRate: 0.25 },
    ]);
    expect(detectVersionShifts(ds).find((f) => f.id === "toolErrorRate-shift")?.severity).toBe("alert");
  });
});

describe("false positive: effort the user chose", () => {
  it("ignores sessions where the user picked max with /effort", () => {
    const ds = build([
      // The user ran /effort max at the start of these sessions.
      { version: "2.1.1", day: 0, workload: "proj-a", sessions: 2, effort: "max", userEffortFrom: 0 },
      { version: "2.1.1", day: 1, workload: "proj-b", sessions: 2, effort: "max", userEffortFrom: 0 },
      { version: "2.1.1", day: 1, workload: "proj-a", sessions: 1, effort: "high" },
      { version: "2.1.2", day: 5, workload: "proj-a", sessions: 2, effort: "high" },
      { version: "2.1.2", day: 6, workload: "proj-b", sessions: 2, effort: "high" },
    ]);
    expect(detectEffortDrops(ds)).toEqual([]);
  });

  it("does not let subagent transcripts outvote main sessions", () => {
    const ds = build([
      { version: "2.1.1", day: 0, workload: "proj-a", sessions: 1, effort: "high" },
      { version: "2.1.1", day: 0, workload: "proj-b", sessions: 1, effort: "high" },
      { version: "2.1.1", day: 0, workload: "proj-a", sidechain: true, sessions: 10, effort: "max" },
      { version: "2.1.1", day: 0, workload: "proj-b", sidechain: true, sessions: 10, effort: "max" },
      { version: "2.1.2", day: 5, workload: "proj-a", sessions: 2, effort: "high" },
      { version: "2.1.2", day: 6, workload: "proj-b", sessions: 2, effort: "high" },
    ]);
    expect(detectEffortDrops(ds)).toEqual([]);
  });

  it("ignores a long max-effort session confined to one project", () => {
    const ds = build([
      { version: "2.1.1", day: 0, workload: "proj-a", sessions: 4, effort: "max" },
      { version: "2.1.2", day: 5, workload: "proj-a", sessions: 2, effort: "high" },
      { version: "2.1.2", day: 6, workload: "proj-b", sessions: 2, effort: "high" },
    ]);
    expect(detectEffortDrops(ds)).toEqual([]);
  });

  it("still reports a default that dropped in several sessions and projects", () => {
    const ds = build([
      { version: "2.1.1", day: 0, workload: "proj-a", sessions: 3, effort: "high" },
      { version: "2.1.1", day: 1, workload: "proj-b", sessions: 3, effort: "high" },
      { version: "2.1.2", day: 5, workload: "proj-a", sessions: 3, effort: "medium" },
      { version: "2.1.2", day: 6, workload: "proj-b", sessions: 3, effort: "medium" },
    ]);
    const f = detectEffortDrops(ds);
    expect(f).toHaveLength(1);
    expect(f[0].evidence[1].display).toBe("medium (100% of sessions)");
  });

  it("marks turns after /effort as user-chosen in Claude Code logs", async () => {
    const base = { sessionId: "s", version: "2.1.100", cwd: "/x", entrypoint: "cli" };
    const a = (id: string, effort: string) => ({
      ...base,
      type: "assistant",
      timestamp: "2026-09-01T00:00:00Z",
      requestId: `r${id}`,
      effort,
      message: { id: `m${id}`, model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 } },
    });
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      a("1", "high"),
      { ...base, type: "user", timestamp: "2026-09-01T00:00:01Z", message: { role: "user", content: "<command-name>/effort</command-name><command-args>max</command-args>" } },
      a("2", "max"),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns.map((t) => [t.effort, !!t.effortSetByUser])).toEqual([
      ["high", false],
      ["max", true],
    ]);
  });
});

describe("false positive: model switch recorded late", () => {
  const base = { sessionId: "s", version: "2.1.100", cwd: "/x", entrypoint: "claude-desktop" };
  const a = (id: string, model: string) => ({
    ...base,
    type: "assistant",
    timestamp: "2026-09-01T00:00:00Z",
    requestId: `r${id}`,
    message: { id: `m${id}`, model, stop_reason: "tool_use", usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 } },
  });
  const identity = (id: string) => ({ ...base, type: "attachment", timestamp: "2026-09-01T00:00:00Z", attachment: { type: "model", identity: { modelId: id } } });

  it("does not count turns served by the new model before its identity record arrives", async () => {
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      identity("claude-opus-4-8"),
      a("1", "claude-opus-4-8"),
      a("2", "claude-opus-5-5"), // switched in the app; identity record lags one response
      identity("claude-opus-5-5"),
      a("3", "claude-opus-5-5"),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns.map((t) => t.requestedModel)).toEqual(["claude-opus-4-8", undefined, "claude-opus-5-5"]);
    const ds: Dataset = { turns: r.turns, toolResults: [], events: [], files: { claude: 1 }, badLines: {} };
    expect(detectModelMismatch(ds)).toEqual([]);
  });

  it("keeps a mismatch the identity record does not confirm", async () => {
    const f = writeLines(join(tmp(), "p", "a.jsonl"), [
      identity("claude-opus-5"),
      a("1", "claude-sonnet-5"),
      identity("claude-opus-5"),
      a("2", "claude-opus-5"),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns[0].requestedModel).toBe("claude-opus-5");
    const ds: Dataset = { turns: r.turns, toolResults: [], events: [], files: { claude: 1 }, badLines: {} };
    expect(detectModelMismatch(ds)).toHaveLength(1);
  });
});

describe("misparsing fixes", () => {
  it("drops copied history stamped with a newer CLI version", () => {
    const ds = build([
      { version: "2.1.10", day: 0, sessions: 1, turnsPerSession: 5 },
      { version: "2.1.11", day: 5, sessions: 1, turnsPerSession: 5 },
      { version: "2.1.12", day: 10, sessions: 1, turnsPerSession: 5 },
      { version: "2.1.13", day: 15, sessions: 1, turnsPerSession: 5 },
      // A file continued on 2.1.20 that carries copies of day-2 turns stamped 2.1.20.
      { version: "2.1.20", day: 2, sessions: 1, turnsPerSession: 7 },
      { version: "2.1.20", day: 30, sessions: 1, turnsPerSession: 3 },
    ]);
    dropStaleCopies(ds);
    const v20 = ds.turns.filter((t) => t.cliVersion === "2.1.20");
    expect(v20).toHaveLength(3);
    expect(v20.every((t) => t.timestamp >= T0 + 30 * DAY)).toBe(true);
    expect(ds.turns).toHaveLength(23);
  });

  it("keeps an older version that is still used after newer ones appeared", () => {
    const ds = build([
      { version: "2.1.10", day: 0, sessions: 1, turnsPerSession: 5 },
      { version: "2.1.11", day: 5, sessions: 1, turnsPerSession: 5 },
      { version: "2.1.12", day: 10, sessions: 1, turnsPerSession: 5 },
      { version: "2.1.10", day: 20, sessions: 1, turnsPerSession: 5 },
    ]);
    dropStaleCopies(ds);
    expect(ds.turns).toHaveLength(20);
  });

  it("drops stale copies end to end through the loader", async () => {
    const root = join(tmp(), "projects");
    const line = (id: string, version: string, ts: string) => ({
      type: "assistant",
      sessionId: id,
      version,
      timestamp: ts,
      requestId: `r${id}${ts}`,
      message: { id: `m${id}${ts}`, model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 } },
    });
    ["2.1.1", "2.1.2", "2.1.3", "2.1.4"].forEach((v, i) =>
      writeLines(join(root, "p", `s${i}.jsonl`), [line(`s${i}`, v, `2026-08-0${i + 2}T00:00:00Z`)]),
    );
    writeLines(join(root, "p", "copy.jsonl"), [line("c", "2.1.9", "2026-08-01T00:00:00Z"), line("c", "2.1.9", "2026-08-20T00:00:00Z")]);
    const ds = await loadDataset({ agents: ["claude"], roots: { claude: [root] } });
    expect(ds.turns.filter((t) => t.cliVersion === "2.1.9").map((t) => new Date(t.timestamp).toISOString().slice(0, 10))).toEqual(["2026-08-20"]);
  });

  it("flags responses whose final line was never written and leaves them out of output medians", async () => {
    const usage = (out: number) => ({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: out });
    const a = (id: string, out: number, stop: string | null) => ({
      type: "assistant",
      sessionId: "s",
      version: "2.1.1",
      isSidechain: true,
      timestamp: "2026-09-01T00:00:00Z",
      requestId: `r${id}`,
      message: { id: `m${id}`, model: "claude-opus-5", stop_reason: stop, usage: usage(out) },
    });
    const f = writeLines(join(tmp(), "p", "s", "subagents", "agent-1.jsonl"), [
      a("1", 2, null),
      a("1", 600, "tool_use"),
      a("2", 3, null), // streaming stub, no final line
      a("3", 4, null),
      a("4", 500, "end_turn"),
    ]);
    const r = await claudeAdapter.parseFile(f);
    expect(r.turns.map((t) => !!t.partial)).toEqual([false, true, true, false]);
    const seg = buildSegments({ turns: r.turns, toolResults: [], events: [], files: { claude: 1 }, badLines: {} });
    expect(seg[0].medianOutputTokens).toBe(550);
    expect(seg[0].subagentTurns).toBe(4);
  });

  it("does not treat a zero-usage placeholder as the session's first turn", async () => {
    const a = (id: string, u: number) => ({
      type: "assistant",
      sessionId: "s",
      version: "2.1.1",
      timestamp: "2026-09-01T00:00:00Z",
      requestId: `r${id}`,
      message: { id: `m${id}`, model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: u, cache_read_input_tokens: 0, cache_creation_input_tokens: u * 1000, output_tokens: u } },
    });
    const r = await claudeAdapter.parseFile(writeLines(join(tmp(), "p", "a.jsonl"), [a("0", 0), a("1", 30)]));
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0].firstInSession).toBe(true);
    expect(r.turns[0].usage.cacheCreation).toBe(30000);
  });

  it("gives Claude Code and Codex turns an opaque workload key per project and client", async () => {
    const dir = tmp();
    const a = (entrypoint: string) => ({
      type: "assistant",
      sessionId: "s",
      version: "2.1.1",
      entrypoint,
      timestamp: "2026-09-01T00:00:00Z",
      requestId: `r${entrypoint}`,
      message: { id: `m${entrypoint}`, model: "claude-opus-5", usage: { input_tokens: 5, output_tokens: 5 } },
    });
    const main = await claudeAdapter.parseFile(writeLines(join(dir, "proj-x", "s.jsonl"), [a("cli")]));
    const sub = await claudeAdapter.parseFile(writeLines(join(dir, "proj-x", "s", "subagents", "agent-1.jsonl"), [a("cli")]));
    const desk = await claudeAdapter.parseFile(writeLines(join(dir, "proj-x", "t.jsonl"), [a("claude-desktop")]));
    const other = await claudeAdapter.parseFile(writeLines(join(dir, "proj-y", "s.jsonl"), [a("cli")]));
    const k = main.turns[0].workloadKey!;
    expect(k).toMatch(/^claude:w:[0-9a-f]{16}$/);
    expect(k).not.toContain("proj");
    expect(sub.turns[0].workloadKey).toBe(k);
    expect(desk.turns[0].workloadKey).not.toBe(k);
    expect(other.turns[0].workloadKey).not.toBe(k);

    const codex = (cwd: string) =>
      writeLines(join(tmp(), "2026", "09", "01", "rollout.jsonl"), [
        { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "x", cli_version: "0.141.0", source: "cli", cwd } },
        { timestamp: "2026-09-01T00:00:01Z", type: "turn_context", payload: { model: "gpt-5.5" } },
        { timestamp: "2026-09-01T00:00:02Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 10 }, last_token_usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2 } } } },
        { timestamp: "2026-09-01T00:00:03Z", type: "event_msg", payload: { type: "exec_command_end", exit_code: 0 } },
      ]);
    const c1 = await codexAdapter.parseFile(codex("/work/one"));
    const c2 = await codexAdapter.parseFile(codex("/work/two"));
    expect(c1.turns[0].workloadKey).toMatch(/^codex:w:[0-9a-f]{16}$/);
    expect(c1.toolResults[0].workloadKey).toBe(c1.turns[0].workloadKey);
    expect(c2.turns[0].workloadKey).not.toBe(c1.turns[0].workloadKey);
  });
});

describe("context window", () => {
  it("needs more than a handful of reports before calling a shrink", () => {
    const ds = build([
      { version: "0.1.0", day: 0, sessions: 4, turnsPerSession: 10, contextWindow: 353400 },
      { version: "0.1.0", day: 23, sessions: 1, turnsPerSession: 5, contextWindow: 258400 },
    ]);
    expect(detectTimeShifts(ds).filter((f) => f.id.startsWith("contextWindow"))).toEqual([]);
  });

  it("reports a shrink inside one long session, since the window does not depend on the work", () => {
    const ds = build([
      { version: "0.1.0", day: 0, sessions: 1, turnsPerSession: 200, contextWindow: 353400 },
      { version: "0.1.0", day: 23, sessions: 1, turnsPerSession: 60, contextWindow: 258400 },
    ]);
    expect(detectTimeShifts(ds).find((f) => f.id === "contextWindow-drift")?.severity).toBe("warn");
  });
});
