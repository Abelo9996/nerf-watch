import { describe, expect, it } from "vitest";
import {
  detectEffortDrops,
  detectFallbacks,
  detectHiddenModels,
  detectModelMismatch,
  detectTimeShifts,
  detectVersionShifts,
  runDetectors,
} from "../src/detectors.js";
import type { Dataset, ToolResult, Turn } from "../src/types.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);

interface Spec {
  agent?: string;
  version: string;
  model?: string;
  requested?: string;
  sessions?: number;
  turnsPerSession?: number;
  day: number;
  cacheCreation?: number;
  cacheRead?: number;
  input?: number;
  effort?: string;
  contextWindow?: number;
  toolErrorRate?: number;
  firstPrompt?: number;
}

let sessionSeq = 0;
function build(specs: Spec[]): Dataset {
  const turns: Turn[] = [];
  const toolResults: ToolResult[] = [];
  for (const s of specs) {
    const n = s.sessions ?? 6;
    for (let i = 0; i < n; i++) {
      const sessionKey = `s${sessionSeq++}`;
      const tps = s.turnsPerSession ?? 12;
      for (let j = 0; j < tps; j++) {
        const ts = T0 + s.day * DAY + i * 3_600_000 + j * 60_000;
        const jitter = 1 + ((j % 5) - 2) * 0.05;
        turns.push({
          agent: s.agent ?? "claude",
          sessionKey,
          timestamp: ts,
          cliVersion: s.version,
          servedModel: s.model ?? "claude-opus-5",
          requestedModel: s.requested,
          effort: s.effort,
          contextWindow: s.contextWindow,
          firstInSession: j === 0 || undefined,
          usage: {
            input: s.input ?? 5,
            cacheCreation: j === 0 ? (s.firstPrompt ?? 20000) : Math.round((s.cacheCreation ?? 800) * jitter),
            cacheRead: j === 0 ? 0 : Math.round((s.cacheRead ?? 40000) * jitter),
            output: 300,
          },
        });
        const errEvery = s.toolErrorRate ? Math.round(1 / s.toolErrorRate) : 0;
        toolResults.push({
          agent: s.agent ?? "claude",
          sessionKey,
          timestamp: ts + 1,
          cliVersion: s.version,
          model: s.model ?? "claude-opus-5",
          isError: errEvery > 0 && (i * tps + j) % errEvery === 0,
        });
      }
    }
  }
  turns.sort((a, b) => a.timestamp - b.timestamp);
  return { turns, toolResults, events: [], files: { claude: 1, codex: 1 }, badLines: {} };
}

const stable: Spec[] = [
  { version: "2.1.1", day: 0 },
  { version: "2.1.2", day: 5 },
  { version: "2.1.3", day: 10 },
  { version: "2.1.4", day: 15 },
];

describe("version shift detectors", () => {
  it("stays quiet on stable data", () => {
    expect(runDetectors(build(stable))).toEqual([]);
  });

  it("reports a cache-creation jump once, at the version where it began", () => {
    const ds = build([...stable, { version: "2.1.5", day: 20, cacheCreation: 2400 }, { version: "2.1.6", day: 25, cacheCreation: 2400 }]);
    const f = detectVersionShifts(ds);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: "cacheCreation-shift", severity: "alert", trigger: "version" });
    expect(f[0].evidence[1].versions?.[0]).toBe("2.1.5");
    expect(f[0].evidence[0].versions).toEqual(["2.1.2", "2.1.3", "2.1.4"]);
  });

  it("flags a moderate jump as warn", () => {
    const f = detectVersionShifts(build([...stable, { version: "2.1.5", day: 20, cacheCreation: 1300 }]));
    expect(f.map((x) => [x.id, x.severity])).toEqual([["cacheCreation-shift", "warn"]]);
  });

  it("detects a cache hit rate collapse", () => {
    const f = detectVersionShifts(build([...stable, { version: "2.1.5", day: 20, cacheRead: 1000 }]));
    expect(f.find((x) => x.id === "cacheHitRate-shift")?.severity).toBe("alert");
  });

  it("detects a startup prompt increase", () => {
    const f = detectVersionShifts(build([...stable, { version: "2.1.5", day: 20, firstPrompt: 45000 }]));
    expect(f.find((x) => x.id === "firstTurnPrompt-shift")?.severity).toBe("alert");
  });

  it("detects a tool error rate jump and ignores small samples", () => {
    const base = stable.map((s) => ({ ...s, toolErrorRate: 0.02, sessions: 10 }));
    const f = detectVersionShifts(build([...base, { version: "2.1.5", day: 20, sessions: 10, toolErrorRate: 0.25 }]));
    expect(f.find((x) => x.id === "toolErrorRate-shift")?.severity).toBe("alert");
    const small = detectVersionShifts(build([...base, { version: "2.1.5", day: 20, sessions: 2, toolErrorRate: 0.5 }]));
    expect(small.find((x) => x.id === "toolErrorRate-shift")).toBeUndefined();
  });

  it("does not compare different models", () => {
    const ds = build([...stable, { version: "2.1.5", day: 20, model: "claude-sonnet-5", cacheCreation: 5000 }]);
    expect(detectVersionShifts(ds)).toEqual([]);
  });

  it("detects a shrinking reported context window", () => {
    const ds = build([
      { agent: "codex", model: "gpt-5.5", version: "0.140.0", day: 0, contextWindow: 353400, cacheCreation: 0 },
      { agent: "codex", model: "gpt-5.5", version: "0.141.0", day: 5, contextWindow: 200000, cacheCreation: 0 },
    ]);
    const f = detectVersionShifts(ds).find((x) => x.id === "contextWindow-shift");
    expect(f?.severity).toBe("alert");
  });
});

describe("time drift detector", () => {
  it("flags a same-version change in the recent window", () => {
    const ds = build([
      { version: "2.1.9", day: 0 },
      { version: "2.1.9", day: 10 },
      { version: "2.1.9", day: 20, cacheRead: 1000 },
      { version: "2.1.9", day: 22, cacheRead: 1000 },
    ]);
    const f = detectTimeShifts(ds);
    expect(f.find((x) => x.id === "cacheHitRate-drift")).toMatchObject({ severity: "alert", trigger: "time" });
  });

  it("ignores data from other versions in either window", () => {
    const ds = build([
      { version: "2.1.8", day: 0, cacheRead: 5000 },
      { version: "2.1.9", day: 10 },
      { version: "2.1.9", day: 22 },
    ]);
    expect(detectTimeShifts(ds)).toEqual([]);
  });
});

describe("model and effort detectors", () => {
  it("alerts when the served model differs from the requested one", () => {
    const ds = build([
      { version: "2.1.1", day: 0, requested: "claude-opus-5[1m]", model: "claude-opus-5-20260101" },
      { version: "2.1.2", day: 5, requested: "claude-opus-5", model: "claude-sonnet-5", sessions: 1 },
    ]);
    const f = detectModelMismatch(ds);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ id: "model-mismatch", severity: "alert", model: "claude-sonnet-5" });
  });

  it("ignores sidechain traffic for mismatch", () => {
    const ds = build([{ version: "2.1.1", day: 0, requested: "claude-opus-5", model: "claude-haiku-5" }]);
    ds.turns.forEach((t) => (t.sidechain = true));
    expect(detectModelMismatch(ds)).toEqual([]);
  });

  it("flags unrecognized and internal-looking model ids", () => {
    const ds = build([
      { version: "2.1.1", day: 0, model: "claude-opus-5", sessions: 1 },
      { version: "2.1.1", day: 1, model: "falcon-internal-ab-7", sessions: 1 },
      { agent: "codex", version: "0.1.0", day: 1, model: "gpt-5.5-internal-eval", sessions: 1 },
    ]);
    expect(detectHiddenModels(ds).map((f) => f.model).sort()).toEqual(["falcon-internal-ab-7", "gpt-5.5-internal-eval"]);
  });

  it("warns when default effort drops across a version", () => {
    const ds = build([
      { version: "2.1.1", day: 0, effort: "high" },
      { version: "2.1.2", day: 5, effort: "high" },
      { version: "2.1.3", day: 10, effort: "medium" },
    ]);
    const f = detectEffortDrops(ds);
    expect(f).toHaveLength(1);
    expect(f[0].title).toContain("high to medium");
    expect(detectEffortDrops(build([{ version: "2.1.1", day: 0, effort: "low" }, { version: "2.1.2", day: 5, effort: "high" }]))).toEqual([]);
  });

  it("summarizes recorded fallbacks as info", () => {
    const ds = build([]);
    ds.events.push(
      { kind: "fallback", agent: "claude", timestamp: T0, cliVersion: "2.1.1", fromModel: "a", toModel: "b" },
      { kind: "fallback", agent: "claude", timestamp: T0 + DAY, cliVersion: "2.1.2", fromModel: "a", toModel: "b" },
    );
    const f = detectFallbacks(ds);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "info", title: "Fell back from a to b (2x)" });
  });
});
