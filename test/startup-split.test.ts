import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmp, writeLines } from "./helpers.js";
import {
  addonsDrove,
  formatSplitClause,
  parseStartupFile,
  splitStartupByTime,
  splitStartupByVersion,
  type StartupSample,
} from "../src/startup.js";
import { annotateStartupSplit } from "../src/detectors.js";
import { cardModel } from "../src/card.js";
import type { Finding } from "../src/types.js";
import type { ShareFinding, SharePayload } from "../src/share.js";

/**
 * One startup session modeled on the attachment rows Claude Code records (names
 * and sizes only, no private content): skill/agent/deferred-tool/MCP listing
 * deltas, an instructions row with two memory files, one SessionStart hook, the
 * environment row, then the first assistant response whose usage pins the whole
 * startup (input + cache_creation + cache_read). `version` rides on the records
 * exactly as Claude Code writes it, so the split can group by CLI version.
 */
function session(opts: { skill: number; total: number; ts: string; version: string; model?: string }): object[] {
  const text = (n: number) => "word ".repeat(Math.max(1, n)); // ~1 token per "word "
  const v = opts.version;
  return [
    { type: "attachment", version: v, attachment: { type: "skill_listing", content: text(opts.skill), skillCount: 71, names: ["a", "b"] } },
    { type: "attachment", version: v, attachment: { type: "agent_listing_delta", addedTypes: ["gsd-planner"], addedLines: [text(100)], builtInTypes: ["Explore"] } },
    { type: "attachment", version: v, attachment: { type: "deferred_tools_delta", addedNames: ["t1"], addedLines: [text(40)], surfacedDefinitions: [] } },
    { type: "attachment", version: v, attachment: { type: "mcp_instructions_delta", addedNames: ["headroom"], addedBlocks: [text(30)] } },
    {
      type: "attachment",
      version: v,
      attachment: {
        type: "instructions",
        files: [
          { path: "/home/u/.claude/CLAUDE.md", type: "User", content: text(120) },
          { path: "/home/u/proj/CLAUDE.md", type: "Project", content: text(200) },
        ],
      },
    },
    { type: "attachment", version: v, attachment: { type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart", command: '"node" "/home/u/sync.cjs"', stdout: text(150) } },
    { type: "attachment", version: v, attachment: { type: "environment", snapshot: { platform: "darwin" } } },
    {
      type: "assistant",
      version: v,
      timestamp: opts.ts,
      message: { id: "m1", model: opts.model ?? "claude-opus-5-5", usage: { input_tokens: 2, cache_creation_input_tokens: opts.total - 2, cache_read_input_tokens: 0, output_tokens: 50 } },
    },
  ];
}

async function sample(dir: string, name: string, opts: { skill: number; total: number; ts: string; version: string; model?: string }): Promise<StartupSample> {
  const file = writeLines(join(dir, name), session(opts));
  return (await parseStartupFile(file, "/home/u"))!;
}

const BEFORE = "2.1.295";
const AFTER = "2.1.301";

describe("splitStartupByVersion", () => {
  it("captures the CLI version from the records", async () => {
    const dir = tmp();
    const s = await sample(dir, "s.jsonl", { skill: 300, total: 19800, ts: "2026-09-02T10:00:00Z", version: BEFORE });
    expect(s.cliVersion).toBe(BEFORE);
  });

  it("attributes growth to Claude Code's base prompt when add-ons barely move", async () => {
    const dir = tmp();
    const samples = [
      await sample(dir, "b1.jsonl", { skill: 300, total: 19800, ts: "2026-09-02T10:00:00Z", version: BEFORE }),
      await sample(dir, "b2.jsonl", { skill: 300, total: 19900, ts: "2026-09-03T10:00:00Z", version: BEFORE }),
      await sample(dir, "b3.jsonl", { skill: 300, total: 19700, ts: "2026-09-04T10:00:00Z", version: BEFORE }),
      // Same add-ons, much larger first-turn usage: the base residual carries it.
      await sample(dir, "a1.jsonl", { skill: 300, total: 56300, ts: "2026-10-02T10:00:00Z", version: AFTER }),
      await sample(dir, "a2.jsonl", { skill: 300, total: 56000, ts: "2026-10-03T10:00:00Z", version: AFTER }),
      await sample(dir, "a3.jsonl", { skill: 300, total: 56200, ts: "2026-10-04T10:00:00Z", version: AFTER }),
    ];
    const split = splitStartupByVersion(samples, [BEFORE], [AFTER], "claude-opus-5-5")!;
    expect(split).not.toBeNull();
    expect(split.beforeSessions).toBe(3);
    expect(split.afterSessions).toBe(3);
    expect(split.base.delta).toBeGreaterThan(30000);
    expect(Math.abs(split.addons.delta)).toBeLessThan(500);
    expect(addonsDrove(split)).toBe(false);
  });

  it("attributes growth to add-ons (skills) when the skill listing balloons", async () => {
    const dir = tmp();
    const samples = [
      await sample(dir, "b1.jsonl", { skill: 300, total: 19800, ts: "2026-09-02T10:00:00Z", version: BEFORE }),
      await sample(dir, "b2.jsonl", { skill: 300, total: 19700, ts: "2026-09-03T10:00:00Z", version: BEFORE }),
      await sample(dir, "b3.jsonl", { skill: 300, total: 19600, ts: "2026-09-04T10:00:00Z", version: BEFORE }),
      // First-turn usage grows by about the skill-listing growth: the add-ons carry it.
      await sample(dir, "a1.jsonl", { skill: 4000, total: 23500, ts: "2026-10-02T10:00:00Z", version: AFTER }),
      await sample(dir, "a2.jsonl", { skill: 4000, total: 23400, ts: "2026-10-03T10:00:00Z", version: AFTER }),
      await sample(dir, "a3.jsonl", { skill: 4000, total: 23600, ts: "2026-10-04T10:00:00Z", version: AFTER }),
    ];
    const split = splitStartupByVersion(samples, [BEFORE], [AFTER], "claude-opus-5-5")!;
    expect(split.addons.delta).toBeGreaterThan(3000);
    expect(addonsDrove(split)).toBe(true);
    expect(split.groups[0].group).toBe("skills"); // the skills group leads the breakdown
    expect(formatSplitClause(split)).toContain("skills");
  });

  it("returns null when a version has no attachment-carrying session (old logs)", async () => {
    const dir = tmp();
    const after = [await sample(dir, "a1.jsonl", { skill: 300, total: 56300, ts: "2026-10-02T10:00:00Z", version: AFTER })];
    // No session recorded by the before version.
    expect(splitStartupByVersion(after, [BEFORE], [AFTER], "claude-opus-5-5")).toBeNull();
  });

  it("returns null when no sample matches the finding's model rather than mixing models", async () => {
    const dir = tmp();
    const samples = [
      await sample(dir, "b1.jsonl", { skill: 300, total: 19800, ts: "2026-09-02T10:00:00Z", version: BEFORE, model: "claude-opus-5-5" }),
      await sample(dir, "a1.jsonl", { skill: 300, total: 56300, ts: "2026-10-02T10:00:00Z", version: AFTER, model: "claude-opus-5-5" }),
    ];
    expect(splitStartupByVersion(samples, [BEFORE], [AFTER], "claude-sonnet-5-5")).toBeNull();
  });

  it("splits a same-version trend by time window (for the overhead trend)", async () => {
    const dir = tmp();
    const samples = [
      await sample(dir, "o1.jsonl", { skill: 300, total: 19800, ts: "2026-09-02T10:00:00Z", version: AFTER }),
      await sample(dir, "o2.jsonl", { skill: 300, total: 19700, ts: "2026-09-03T10:00:00Z", version: AFTER }),
      await sample(dir, "r1.jsonl", { skill: 300, total: 28000, ts: "2026-10-20T10:00:00Z", version: AFTER }),
      await sample(dir, "r2.jsonl", { skill: 300, total: 28200, ts: "2026-10-21T10:00:00Z", version: AFTER }),
    ];
    const cut = Date.parse("2026-10-01T00:00:00Z");
    const split = splitStartupByTime(samples, { start: 0, end: cut }, { start: cut, end: Date.now() }, "claude-opus-5-5")!;
    expect(split.beforeSessions).toBe(2);
    expect(split.afterSessions).toBe(2);
    expect(split.base.delta).toBeGreaterThan(7000);
  });
});

/** A startup-growth finding shaped like detectVersionShifts emits. */
function growthFinding(): Finding {
  return {
    id: "firstTurnPrompt-shift",
    severity: "warn",
    agent: "claude",
    model: "claude-opus-5-5",
    trigger: "version",
    title: `Session startup prompt grew between CLI ${BEFORE} and ${AFTER}`,
    explanation: "The first request of a session now carries a median prompt of 56.3k, up from 19.8k. That is fixed overhead paid by every new session and it shrinks the room left for your own work.",
    nextStep: "First check whether you added MCP servers, skills, plugins or memory files (CLAUDE.md, AGENTS.md): they grow the startup prompt too. If you did not, report it to the agent's vendor with the output of `nerf-watch report` attached.",
    evidence: [
      { label: "before", versions: [BEFORE], from: "2026-09-01", to: "2026-10-22", samples: 6, sampleUnit: "sessions", value: 19800, display: "19.8k tokens" },
      { label: "after", versions: [AFTER], from: "2026-10-01", to: "2026-10-22", samples: 8, sampleUnit: "sessions", value: 56300, display: "56.3k tokens" },
    ],
  };
}

describe("annotateStartupSplit", () => {
  it("rewrites the finding with the split and points to the vendor when the base grew", async () => {
    const dir = tmp();
    const samples = [
      await sample(dir, "b1.jsonl", { skill: 300, total: 19800, ts: "2026-10-02T10:00:00Z", version: BEFORE }),
      await sample(dir, "b2.jsonl", { skill: 300, total: 19900, ts: "2026-10-03T10:00:00Z", version: BEFORE }),
      await sample(dir, "b3.jsonl", { skill: 300, total: 19700, ts: "2026-10-04T10:00:00Z", version: BEFORE }),
      await sample(dir, "a1.jsonl", { skill: 300, total: 56300, ts: "2026-10-10T10:00:00Z", version: AFTER }),
      await sample(dir, "a2.jsonl", { skill: 300, total: 56000, ts: "2026-10-11T10:00:00Z", version: AFTER }),
      await sample(dir, "a3.jsonl", { skill: 300, total: 56200, ts: "2026-10-12T10:00:00Z", version: AFTER }),
    ];
    const [f] = annotateStartupSplit([growthFinding()], samples);
    expect(f.startupSplit).toBeTruthy();
    expect(f.explanation).toContain("splits into");
    expect(f.explanation).toContain("Claude Code's own base prompt");
    expect(f.explanation).toContain("your add-ons");
    expect(f.explanation).toContain("3 earlier and 3 recent");
    // Base grew, so the vendor-report next step stays.
    expect(f.nextStep).toContain("report it");
    expect(f.nextStep).not.toContain("nerf-watch fix");
  });

  it("points to `nerf-watch fix` when your add-ons drove the growth", async () => {
    const dir = tmp();
    const samples = [
      await sample(dir, "b1.jsonl", { skill: 300, total: 19800, ts: "2026-10-02T10:00:00Z", version: BEFORE }),
      await sample(dir, "b2.jsonl", { skill: 300, total: 19700, ts: "2026-10-03T10:00:00Z", version: BEFORE }),
      await sample(dir, "b3.jsonl", { skill: 300, total: 19600, ts: "2026-10-04T10:00:00Z", version: BEFORE }),
      await sample(dir, "a1.jsonl", { skill: 4000, total: 23500, ts: "2026-10-10T10:00:00Z", version: AFTER }),
      await sample(dir, "a2.jsonl", { skill: 4000, total: 23400, ts: "2026-10-11T10:00:00Z", version: AFTER }),
      await sample(dir, "a3.jsonl", { skill: 4000, total: 23600, ts: "2026-10-12T10:00:00Z", version: AFTER }),
    ];
    const [f] = annotateStartupSplit([growthFinding()], samples);
    expect(f.nextStep).toContain("nerf-watch fix");
  });

  it("keeps today's wording when the logs have no attachments to split by", () => {
    const original = growthFinding();
    const [f] = annotateStartupSplit([original], []);
    expect(f).toBe(original); // untouched: same object
    expect(f.startupSplit).toBeUndefined();
    expect(f.nextStep).toContain("First check whether you added");
  });

  it("keeps today's wording when too few attachment sessions fall in the window", async () => {
    const dir = tmp();
    // Only two sessions per side: below STARTUP_SPLIT_MIN_SESSIONS, so a median would be noise.
    const samples = [
      await sample(dir, "b1.jsonl", { skill: 300, total: 19800, ts: "2026-10-02T10:00:00Z", version: BEFORE }),
      await sample(dir, "b2.jsonl", { skill: 300, total: 19900, ts: "2026-10-03T10:00:00Z", version: BEFORE }),
      await sample(dir, "a1.jsonl", { skill: 300, total: 56300, ts: "2026-10-10T10:00:00Z", version: AFTER }),
      await sample(dir, "a2.jsonl", { skill: 300, total: 56000, ts: "2026-10-11T10:00:00Z", version: AFTER }),
    ];
    const original = growthFinding();
    const [f] = annotateStartupSplit([original], samples);
    expect(f).toBe(original);
    expect(f.nextStep).toContain("First check whether you added");
  });
});

/** A share payload carrying one startup-growth finding with the split, as buildSharePayload would emit. */
function payloadWithSplit(baseDelta: number, addonDelta: number): SharePayload {
  const finding: ShareFinding = {
    detector: "firstTurnPrompt-shift",
    signal: "tokens",
    severity: "warn",
    trigger: "version",
    agent: "claude",
    model: "claude-opus-5-5",
    servedModel: null,
    cliBefore: BEFORE,
    cliAfter: AFTER,
    before: { value: 19800, samples: 6, from: "2026-09-01", to: "2026-10-22" },
    after: { value: 56300, samples: 8, from: "2026-10-01", to: "2026-10-22" },
    startupSplit: { baseDelta, addonDelta },
  };
  return {
    schema: "nerf-watch-share/1",
    nerfWatchVersion: "0.5.0",
    window: { from: "2026-09-01", to: "2026-10-22" },
    agents: [{ id: "claude", sessions: 14, turns: 400 }],
    findings: [finding],
  };
}

describe("card headline split", () => {
  it("headlines the split instead of blaming the CLI", () => {
    const m = cardModel(payloadWithSplit(31900, 4600));
    expect(m.headline).toContain("from Claude Code");
    expect(m.headline).toContain("from add-ons");
    expect(m.headline).toContain("+31.9k");
    expect(m.headline).toContain("+4,600"); // the card prints sub-10k token counts in full
    expect(m.rows[0].title).toBe("Startup prompt up 2.8x"); // the row title stays short
  });
});
