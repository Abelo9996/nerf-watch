import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SENTINEL_CWD, SENTINEL_PROMPT, writeDemo } from "../scripts/make-demo-data.mjs";
import { tmp } from "./helpers.js";

const CLI = resolve(__dirname, "..", "dist", "cli.js");
let roots: string[];
let dir: string;

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    cwd: dir,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js missing: run `npm run build` first (npm test does this via pretest)");
  dir = tmp();
  const d = writeDemo(join(dir, "logs"));
  roots = ["--root", `claude=${d.claudeRoot}`, "--root", `codex=${d.codexRoot}`];
});

describe("cli end to end on synthetic logs", () => {
  it("scan prints one row per (agent, version, model)", () => {
    const r = run(["scan", ...roots]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude: 32 session files, 1,280 turns");
    expect(r.out).toMatch(/claude\s+2\.1\.272\s+claude-sonnet-5/);
    expect(r.out).toMatch(/codex\s+0\.141\.0\s+gpt-5\.5/);
  });

  it("scan --json is valid JSON", () => {
    const r = run(["scan", "--json", ...roots]);
    const j = JSON.parse(r.out);
    expect(j.segments).toHaveLength(6);
    expect(j.summary.files).toEqual({ claude: 32, codex: 24 });
  });

  it("check finds the planted regressions and exits 1", () => {
    const r = run(["check", "--json", ...roots]);
    expect(r.code).toBe(1);
    const ids = JSON.parse(r.out).findings.map((f: { id: string }) => f.id).sort();
    expect(ids).toEqual(["cacheCreation-shift", "cacheHitRate-shift", "contextWindow-drift", "effort-drop", "model-mismatch"]);
  });

  it("check respects --agent and --fail-on", () => {
    const codexOnly = run(["check", "--agent", "codex", ...roots]);
    expect(codexOnly.code).toBe(0); // codex findings are warnings only
    expect(codexOnly.out).toContain("0 alert(s), 2 warning(s)");
    expect(run(["check", "--agent", "codex", "--fail-on", "warn", ...roots]).code).toBe(1);
    expect(run(["check", "--fail-on", "never", ...roots]).code).toBe(0);
  });

  it("--since narrows the data", () => {
    const r = run(["scan", "--json", "--since", "2026-09-20", ...roots]);
    const j = JSON.parse(r.out);
    expect(j.summary.turns).toBeLessThan(2000);
    expect(j.segments.every((s: { firstSeen: number }) => s.firstSeen >= Date.UTC(2026, 8, 20))).toBe(true);
  });

  it("report never contains prompts, paths or project names", () => {
    for (const out of ["r.md", "r.json"]) {
      const r = run(["report", "--out", out, ...roots]);
      expect(r.code).toBe(0);
      const text = readFileSync(join(dir, out), "utf8");
      expect(text).not.toContain(SENTINEL_PROMPT);
      expect(text).not.toContain(SENTINEL_CWD);
      expect(text).not.toContain("sentinel");
      expect(text).not.toContain("demo-project");
      expect(text).not.toContain(dir);
      expect(text).not.toMatch(/[0-9a-f]{8}-0000-4000-8000/); // session ids
    }
    const md = readFileSync(join(dir, "r.md"), "utf8");
    expect(md).toContain("# nerfwatch report");
    expect(md).toContain("Requested claude-opus-5 but claude-sonnet-5 answered");
    const j = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    expect(j.summary).toEqual({ alert: 2, warn: 3, info: 0 });
  });

  it("handles missing logs and bad flags", () => {
    const empty = tmp();
    const r = run(["check"], { HOME: empty, USERPROFILE: empty, CLAUDE_CONFIG_DIR: join(empty, "c"), CODEX_HOME: join(empty, "x") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No Claude Code or Codex session logs found");
    expect(run(["check", "--agent", "nope"]).code).toBe(2);
    expect(run(["scan", "--since", "whenever"]).code).toBe(2);
    expect(run(["frobnicate"]).code).toBe(2);
    expect(run(["--help"]).out).toContain("check");
  });

  it("reads CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const d = join(dir, "logs");
    const r = run(["scan", "--json"], { CLAUDE_CONFIG_DIR: join(d, "claude"), CODEX_HOME: join(d, "codex") });
    expect(JSON.parse(r.out).summary.files).toEqual({ claude: 32, codex: 24 });
  });
});
