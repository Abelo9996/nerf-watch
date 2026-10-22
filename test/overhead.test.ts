import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers.js";
import { estimateTokens } from "../src/tokens.js";
import { configEnv, scanClaude, scanCodex } from "../src/config-scan.js";
import { buildAttribution, logOverhead, fixedShare } from "../src/overhead.js";
import { applyItems, buildFixItems, disableMcpServer, listBackups, replaceSection, setJsonKey, undo } from "../src/fix.js";
import { buildProof, formatProof } from "../src/proof.js";
import { svgToPng } from "../src/png.js";
import { renderProofCardSvg, proofCardModel } from "../src/card.js";
import type { Dataset, Turn } from "../src/types.js";
import type { ProfileResult } from "../src/measure.js";

const DAY = 86_400_000;
let seq = 0;
function turn(o: Partial<Turn> & { input?: number; cacheRead?: number; cacheCreation?: number }): Turn {
  return {
    agent: o.agent ?? "claude",
    sessionKey: o.sessionKey ?? "s",
    timestamp: o.timestamp ?? Date.UTC(2026, 9, 1) + seq++ * 1000,
    servedModel: o.servedModel ?? "claude-opus-5-5",
    usage: { input: o.input ?? 100, cacheRead: o.cacheRead ?? 0, cacheCreation: o.cacheCreation ?? 0, output: 10 },
    firstInSession: o.firstInSession,
    sidechain: o.sidechain,
  } as Turn;
}

function dataset(turns: Turn[]): Dataset {
  return { turns, toolResults: [], events: [], files: { claude: 1 }, badLines: { claude: 0 }, roots: {}, filesFound: {} };
}

describe("token estimate", () => {
  it("scales with text length and is never below a word count", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    const big = "x".repeat(4000);
    expect(estimateTokens(big)).toBeGreaterThan(900);
    expect(estimateTokens(big)).toBeLessThan(1100);
  });
});

describe("config scan", () => {
  it("enumerates Claude sources from a temp HOME, read only", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude", "skills", "demo"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { foo: { type: "stdio", command: "x" } } }));
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# memory\n\nsome guidance that is a little long here.");
    writeFileSync(join(home, ".claude", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: a demo skill for testing\n---\nbody");
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ effortLevel: "high", model: "claude-opus-5-5", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );
    const sources = scanClaude(configEnv({ home, cwd: home, env: {} }));
    const kinds = sources.map((s) => s.kind);
    expect(kinds).toContain("memory");
    expect(kinds).toContain("mcp");
    expect(kinds).toContain("skill");
    expect(kinds).toContain("hook");
    expect(kinds).toContain("effort");
    expect(sources.find((s) => s.kind === "mcp")?.id).toBe("claude:mcp:user:foo");
    expect(sources.find((s) => s.kind === "memory")?.estTokens).toBeGreaterThan(0);
  });

  it("reads Codex MCP servers from config.toml without double-counting sub-tables", () => {
    const home = tmp();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "AGENTS.md"), "");
    writeFileSync(join(home, ".codex", "config.toml"), '[mcp_servers.node_repl]\ncommand = "node"\n[mcp_servers.node_repl.env]\nFOO = "bar"\nmodel_reasoning_effort = "medium"\n');
    const sources = scanCodex(configEnv({ home, cwd: home, env: {} }));
    const mcp = sources.filter((s) => s.kind === "mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0].id).toBe("codex:mcp:node_repl");
    expect(sources.find((s) => s.kind === "effort")?.label).toContain("medium");
  });
});

describe("log overhead", () => {
  it("reports startup and fixed share per model", () => {
    const turns: Turn[] = [];
    for (let s = 0; s < 4; s++) {
      turns.push(turn({ sessionKey: `s${s}`, firstInSession: true, input: 20000, cacheRead: 0 }));
      for (let i = 0; i < 5; i++) turns.push(turn({ sessionKey: `s${s}`, input: 500, cacheRead: 19500 }));
    }
    const [o] = logOverhead(dataset(turns));
    expect(o.startupMedian).toBe(20000);
    expect(o.cacheHitRate).toBeGreaterThan(0.9);
    expect(fixedShare(o)).toBeGreaterThan(0.9); // startup ~= per-turn prompt
  });
});

describe("attribution", () => {
  it("splits the measured total into sources that add back up", () => {
    const results: ProfileResult[] = [
      { id: "baseline", label: "", runs: [], total: 31000, cost: 0.01 },
      { id: "no-mcp", label: "", runs: [], total: 28000, cost: 0.01 },
      { id: "no-user", label: "", runs: [], total: 18000, cost: 0.01 },
      { id: "mcp:headroom", label: "", runs: [], total: 30500, cost: 0.01 },
      { id: "memory", label: "", runs: [], total: 18600, cost: 0.01 },
    ];
    const a = buildAttribution(results, [], "claude-haiku-5-5")!;
    expect(a.total).toBe(31000);
    const floor = a.rows.find((r) => !r.reducible)!;
    expect(floor.tokens).toBe(18000);
    const sum = a.rows.reduce((s, r) => s + r.tokens, 0);
    expect(Math.abs(a.total - sum)).toBeLessThan(3000); // within noise tolerance
    expect(a.rows[0].source).toMatch(/system prompt|settings/); // largest first
  });
});

describe("fix transforms", () => {
  it("disables an MCP server reversibly and sets a json key", () => {
    const before = JSON.stringify({ mcpServers: { foo: { command: "x" }, bar: { command: "y" } } }, null, 2);
    const after = disableMcpServer(before, "foo")!;
    const j = JSON.parse(after);
    expect(j.mcpServers.foo).toBeUndefined();
    expect(j._nerfWatchDisabled.mcpServers.foo).toEqual({ command: "x" });
    expect(disableMcpServer(after, "foo")).toBeNull(); // already gone
    expect(JSON.parse(setJsonKey("{}", "effortLevel", "high")!).effortLevel).toBe("high");
  });

  it("replaces a markdown section with a pointer", () => {
    const md = "# Title\n\n## Keep\n\nkeep me\n\n## Big\n\nlots of text here\n\n## After\n\ntail";
    const out = replaceSection(md, "Big", "~/.claude/memory/big.md")!;
    expect(out).toContain("Read `~/.claude/memory/big.md`");
    expect(out).not.toContain("lots of text here");
    expect(out).toContain("keep me");
    expect(out).toContain("tail");
  });
});

describe("fix apply and undo", () => {
  it("applies the mcp disable then undo restores byte-identical", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const jsonPath = join(home, ".claude.json");
    const original = JSON.stringify({ mcpServers: { foo: { command: "x" } }, other: 1 }, null, 2) + "\n";
    writeFileSync(jsonPath, original);
    const cfg = configEnv({ home, cwd: home, env: {} });
    const items = buildFixItems(cfg, scanClaude(cfg));
    const res = applyItems(cfg, items, ["disable-mcp:foo"]);
    expect(res.changed.length).toBe(1);
    expect(JSON.parse(readFileSync(jsonPath, "utf8")).mcpServers.foo).toBeUndefined();
    expect(listBackups(cfg)).toContain(res.backupId);
    const u = undo(cfg);
    expect(u.mismatches).toEqual([]);
    expect(readFileSync(jsonPath, "utf8")).toBe(original); // byte identical
  });

  it("removes a file the fix created on undo", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const md = "# M\n\n## " + "Big Section".padEnd(10) + "\n\n" + "word ".repeat(400) + "\n";
    writeFileSync(join(home, ".claude", "CLAUDE.md"), md);
    const cfg = configEnv({ home, cwd: home, env: {} });
    const items = buildFixItems(cfg, scanClaude(cfg));
    const trim = items.find((i) => i.id.startsWith("trim-memory:"));
    expect(trim).toBeTruthy();
    const res = applyItems(cfg, items, [trim!.id]);
    const created = res.changed.find((c) => c.path.includes("memory"))!;
    expect(existsSync(created.path)).toBe(true);
    undo(cfg);
    expect(existsSync(created.path)).toBe(false);
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(md);
  });
});

describe("proof", () => {
  it("compares before and after a fix timestamp", () => {
    const fix = Date.UTC(2026, 9, 10);
    const turns: Turn[] = [];
    for (let s = 0; s < 5; s++) {
      turns.push(turn({ sessionKey: `b${s}`, timestamp: fix - (s + 1) * DAY, firstInSession: true, input: 40000 }));
      for (let i = 0; i < 25; i++) turns.push(turn({ sessionKey: `b${s}`, timestamp: fix - (s + 1) * DAY + i * 1000, input: 1000, cacheRead: 39000 }));
    }
    for (let s = 0; s < 5; s++) {
      turns.push(turn({ sessionKey: `a${s}`, timestamp: fix + (s + 1) * DAY, firstInSession: true, input: 18000 }));
      for (let i = 0; i < 25; i++) turns.push(turn({ sessionKey: `a${s}`, timestamp: fix + (s + 1) * DAY + i * 1000, input: 1000, cacheRead: 17000 }));
    }
    const report = buildProof(dataset(turns), fix);
    expect(report.tooFew).toBe(false);
    const row = report.rows.find((r) => r.ready)!;
    expect(row.startup.before).toBe(40000);
    expect(row.startup.after).toBe(18000);
    expect(row.requestShare).not.toBeNull();
    expect(row.requestShare!).toBeCloseTo(22000 / 40000, 5);
    expect(formatProof(report)).toContain("Before vs after the fix");
  });

  it("is honest when there are too few sessions after the fix", () => {
    const fix = Date.UTC(2026, 9, 10);
    const turns: Turn[] = [];
    for (let s = 0; s < 5; s++) turns.push(turn({ sessionKey: `b${s}`, timestamp: fix - (s + 1) * DAY, firstInSession: true, input: 40000 }));
    turns.push(turn({ sessionKey: "a0", timestamp: fix + DAY, firstInSession: true, input: 18000 }));
    const report = buildProof(dataset(turns), fix);
    expect(report.tooFew).toBe(true);
    expect(formatProof(report)).toContain("Not enough sessions");
  });
});

describe("png", () => {
  it("rasterizes a proof card to a real PNG with no system tools", async () => {
    const fix = Date.UTC(2026, 9, 10);
    const turns: Turn[] = [];
    for (let s = 0; s < 5; s++) {
      turns.push(turn({ sessionKey: `b${s}`, timestamp: fix - (s + 1) * DAY, firstInSession: true, input: 40000 }));
      for (let i = 0; i < 25; i++) turns.push(turn({ sessionKey: `b${s}`, timestamp: fix - (s + 1) * DAY + i * 1000, input: 1000, cacheRead: 39000 }));
    }
    for (let s = 0; s < 5; s++) {
      turns.push(turn({ sessionKey: `a${s}`, timestamp: fix + (s + 1) * DAY, firstInSession: true, input: 18000 }));
      for (let i = 0; i < 25; i++) turns.push(turn({ sessionKey: `a${s}`, timestamp: fix + (s + 1) * DAY + i * 1000, input: 1000, cacheRead: 17000 }));
    }
    const m = proofCardModel(buildProof(dataset(turns), fix), { version: "0.5.0", responses: turns.length, sessions: 10 })!;
    const svg = renderProofCardSvg(m);
    const png = await svgToPng(svg, 1200);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // PNG magic
    expect(png.length).toBeGreaterThan(1000);
  });
});
