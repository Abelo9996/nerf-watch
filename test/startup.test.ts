import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmp, writeLines } from "./helpers.js";
import { aggregateStartup, parseStartupFile, reducibleTotal, readStartupSamples, type StartupSample } from "../src/startup.js";
import { countUsage } from "../src/usage.js";
import { configEnv, scanClaude } from "../src/config-scan.js";
import { applyItems, buildFixItems, listUserAgents, listUserSkills, projectStartup, stashDir, undo } from "../src/fix.js";
import { formatStartupAttribution } from "../src/overhead.js";

/**
 * Attachment rows modeled on the shapes Claude Code records at startup (names
 * and sizes only, no private content). One `instructions` row with several
 * files, one SessionStart `hook_success` whose injected text is in `stdout`,
 * plus the skill, agent, deferred-tool and MCP listing deltas, then the first
 * assistant response that pins the calibrated total.
 */
function startupSession(opts: { skillTokens?: number; agentTokens?: number; hookTokens?: number; total?: number; model?: string; ts?: string } = {}): object[] {
  const text = (approxTokens: number) => "word ".repeat(Math.max(1, approxTokens)); // ~1 token per "word "
  const ts = opts.ts ?? "2026-10-20T10:00:00.000Z";
  return [
    { type: "attachment", attachment: { type: "skill_listing", content: text(opts.skillTokens ?? 300), skillCount: 71, names: ["a", "b"], digests: ["x", "y"] } },
    { type: "attachment", attachment: { type: "agent_listing_delta", addedTypes: ["gsd-planner", "gsd-executor"], addedLines: [text(opts.agentTokens ?? 100)], builtInTypes: ["general-purpose", "Explore"] } },
    { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: ["t1", "t2"], addedLines: [text(40)], surfacedDefinitions: [] } },
    { type: "attachment", attachment: { type: "mcp_instructions_delta", addedNames: ["headroom"], addedBlocks: [text(30)] } },
    {
      type: "attachment",
      attachment: {
        type: "instructions",
        files: [
          { path: "/home/u/.claude/CLAUDE.md", type: "User", content: text(120) },
          { path: "/home/u/proj/CLAUDE.md", type: "Project", content: text(200) },
        ],
      },
    },
    { type: "attachment", attachment: { type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart", command: '"node" "/home/u/claude-sync/bin/sync.cjs"', stdout: text(opts.hookTokens ?? 150), content: "<persisted-output>…</persisted-output>" } },
    { type: "attachment", attachment: { type: "environment", snapshot: { workingDirectory: "/home/u/proj", platform: "darwin" } } },
    { type: "attachment", attachment: { type: "session_context", context: { userEmail: "u@example.com" } } },
    { type: "assistant", timestamp: ts, message: { id: "m1", model: opts.model ?? "claude-opus-5-5", usage: { input_tokens: 2, cache_creation_input_tokens: (opts.total ?? 8000) - 2, cache_read_input_tokens: 0, output_tokens: 50 } } },
  ];
}

describe("startup attachment parser", () => {
  it("sizes each source and pins the base against the first-turn usage", async () => {
    const dir = tmp();
    const file = writeLines(join(dir, "projects", "p", "s.jsonl"), startupSession({ total: 8000 }));
    const sample = await parseStartupFile(file, "/home/u");
    expect(sample).not.toBeNull();
    expect(sample!.calibratedTotal).toBe(8000);
    expect(sample!.model).toBe("claude-opus-5-5");
    const keys = sample!.items.map((i) => i.key);
    expect(keys).toContain("skills");
    expect(keys).toContain("agents");
    expect(keys).toContain("tools");
    expect(keys).toContain("mcp:headroom");
    expect(keys).toContain("instructions:/home/u/.claude/CLAUDE.md");
    expect(keys).toContain("hook:SessionStart:startup");
    // The instructions file path is shown home-relative, never raw.
    const userMd = sample!.items.find((i) => i.key === "instructions:/home/u/.claude/CLAUDE.md")!;
    expect(userMd.label).toContain("~/.claude/CLAUDE.md");
    // The hook is sized from its stdout (the injected text), not the persisted-output pointer.
    const hook = sample!.items.find((i) => i.key === "hook:SessionStart:startup")!;
    expect(hook.tokens).toBeGreaterThan(100);
    // Reducible total is everything attributed; it is less than the calibrated total (the base is the rest).
    expect(reducibleTotal(sample!)).toBeGreaterThan(0);
    expect(reducibleTotal(sample!)).toBeLessThan(8000);
  });

  it("returns null for a session with no attachments (older CLI)", async () => {
    const dir = tmp();
    const file = writeLines(join(dir, "s.jsonl"), [
      { type: "assistant", timestamp: "2026-10-20T10:00:00.000Z", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } } },
    ]);
    expect(await parseStartupFile(file, "/home/u")).toBeNull();
  });

  it("aggregates by dominant model and the group rows sum to within tolerance of the calibrated total", async () => {
    const samples: StartupSample[] = [];
    const dir = tmp();
    // Six opus sessions (dominant) and two cheap-model sessions that must not dilute the picture.
    for (let i = 0; i < 6; i++) {
      const f = writeLines(join(dir, `opus${i}.jsonl`), startupSession({ total: 8000, model: "claude-opus-5-5" }));
      samples.push((await parseStartupFile(f, "/home/u"))!);
    }
    for (let i = 0; i < 2; i++) {
      const f = writeLines(join(dir, `cheap${i}.jsonl`), startupSession({ total: 1200, model: "some-free-model" }));
      samples.push((await parseStartupFile(f, "/home/u"))!);
    }
    const agg = aggregateStartup(samples)!;
    expect(agg.model).toBe("claude-opus-5-5");
    expect(agg.sessions).toBe(6);
    expect(agg.calibratedTotal).toBe(8000);
    const summed = agg.groups.reduce((n, r) => n + r.tokens, 0);
    expect(Math.abs(summed - agg.calibratedTotal)).toBeLessThanOrEqual(Math.abs(agg.residual) + 1);
    expect(Math.abs(agg.residual)).toBeLessThan(agg.calibratedTotal * 0.2); // within a modest tolerance
    const base = agg.groups.find((g) => g.group === "base")!;
    expect(base.reducible).toBe(false);
    expect(base.tokens).toBeGreaterThan(0);
    expect(formatStartupAttribution(agg)).toContain("Real interactive startup");
  });

  it("reads the most recent sessions from a root, newest first", async () => {
    const root = tmp();
    writeLines(join(root, "a.jsonl"), startupSession({ total: 5000 }));
    writeLines(join(root, "b.jsonl"), startupSession({ total: 6000 }));
    const samples = await readStartupSamples({ roots: [root], home: "/home/u", limit: 10 });
    expect(samples.length).toBe(2);
  });
});

describe("usage counting", () => {
  it("counts skill and subagent invocations from tool_use rows", async () => {
    const root = tmp();
    writeLines(join(root, "s1.jsonl"), [
      { type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Skill", input: { skill: "dataviz" } }] } },
      { type: "assistant", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Task", input: { subagent_type: "general-purpose", description: "x" } }] } },
      { type: "assistant", message: { id: "m3", model: "claude-opus-5-5", content: [{ type: "tool_use", name: "Skill", input: { skill: "dataviz" } }] } },
    ]);
    const usage = await countUsage({ roots: [root], home: "/home/u" });
    expect(usage.skills.get("dataviz")).toBe(2);
    expect(usage.agents.get("general-purpose")).toBe(1);
    expect(usage.skills.has("gsd-planner")).toBe(false);
  });
});

/** Byte hash of a directory tree, for the round-trip check. */
function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      h.update(name);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

describe("unused skill and agent stash", () => {
  function seedHome() {
    const home = tmp();
    const skills = join(home, ".claude", "skills");
    for (const name of ["gsd-plan", "gsd-ship", "gsd-debug", "blaxel-cli"]) {
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill does a thing worth describing here\n---\nbody`);
    }
    const agents = join(home, ".claude", "agents");
    mkdirSync(agents, { recursive: true });
    for (const name of ["gsd-planner", "gsd-executor"]) {
      writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: the ${name} agent\n---\nbody`);
    }
    return home;
  }

  it("groups never-used gsd-* skills and agents, keeps used and non-prefix items out of the group", () => {
    const home = seedHome();
    const cfg = configEnv({ home, cwd: home, env: {} });
    const usage = { skills: new Map([["gsd-ship", 3]]), agents: new Map(), sessionsScanned: 10, since: 0 };
    const items = buildFixItems(cfg, scanClaude(cfg), { usage, threshold: 0 });
    const skillGroup = items.find((i) => i.id === "stash-skills:gsd")!;
    expect(skillGroup).toBeTruthy();
    // gsd-ship was used, so it is not in the group; gsd-plan and gsd-debug are.
    const moved = skillGroup.moves!.map((m) => m.from);
    expect(moved.some((p) => p.endsWith("gsd-plan"))).toBe(true);
    expect(moved.some((p) => p.endsWith("gsd-debug"))).toBe(true);
    expect(moved.some((p) => p.endsWith("gsd-ship"))).toBe(false);
    expect(moved.some((p) => p.endsWith("blaxel-cli"))).toBe(false); // used skills aside, this is not gsd-*
    expect(skillGroup.estTokensSaved).toBeGreaterThan(0);
    // The agent group picks both never-used agents.
    const agentGroup = items.find((i) => i.id === "stash-agents:gsd")!;
    expect(agentGroup.moves!.length).toBe(2);
    // Individual member items exist and are hidden from the top listing.
    expect(items.some((i) => i.id === "stash-skill:gsd-plan" && i.member)).toBe(true);
  });

  it("applies a group then undo restores the trees byte-identical", () => {
    const home = seedHome();
    const cfg = configEnv({ home, cwd: home, env: {} });
    const before = hashTree(join(home, ".claude", "skills")) + hashTree(join(home, ".claude", "agents"));
    const usage = { skills: new Map(), agents: new Map(), sessionsScanned: 10, since: 0 };
    const items = buildFixItems(cfg, scanClaude(cfg), { usage, threshold: 0 });
    const res = applyItems(cfg, items, ["stash-skills:gsd", "stash-agents:gsd"]);
    expect(res.changed.length).toBe(5); // 3 gsd skills + 2 gsd agents
    expect(existsSync(join(home, ".claude", "skills", "gsd-plan"))).toBe(false);
    expect(existsSync(join(stashDir(cfg), "skills", "gsd-plan"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "blaxel-cli"))).toBe(true); // kept
    const u = undo(cfg);
    expect(u.mismatches).toEqual([]);
    expect(hashTree(join(home, ".claude", "skills")) + hashTree(join(home, ".claude", "agents"))).toBe(before);
  });

  it("applying a member and its group does not double-move", () => {
    const home = seedHome();
    const cfg = configEnv({ home, cwd: home, env: {} });
    const usage = { skills: new Map(), agents: new Map(), sessionsScanned: 10, since: 0 };
    const items = buildFixItems(cfg, scanClaude(cfg), { usage, threshold: 0 });
    const res = applyItems(cfg, items, ["stash-skills:gsd", "stash-skill:gsd-plan"]);
    // gsd-plan is moved once even though both the group and the member name it.
    expect(res.changed.filter((c) => c.path.endsWith("gsd-plan")).length).toBe(1);
    undo(cfg);
    expect(existsSync(join(home, ".claude", "skills", "gsd-plan"))).toBe(true);
  });

  it("projects the startup drop from the selected items", () => {
    const home = seedHome();
    const cfg = configEnv({ home, cwd: home, env: {} });
    const usage = { skills: new Map(), agents: new Map(), sessionsScanned: 10, since: 0 };
    const items = buildFixItems(cfg, scanClaude(cfg), { usage, threshold: 0 });
    const p = projectStartup(items, ["stash-skills:gsd"], 50000);
    expect(p.before).toBe(50000);
    expect(p.saved).toBeGreaterThan(0);
    expect(p.after).toBe(50000 - p.saved);
  });
});
