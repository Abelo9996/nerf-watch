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

  it("check starts with a plain-English summary and labels units", () => {
    const r = run(["check", ...roots]);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("Read 2,000 model responses from 56 session files (claude 1,280, codex 720), 2026-08-23 to 2026-10-02.");
    expect(lines[1]).toMatch(/^Result: 2 alerts and 3 warnings\./);
    expect(r.out).toMatch(/before\s+926 tokens\s+cli 2\.1\.270, 2\.1\.271\s+2026-08-23 to 2026-09-16\s+780 turns/);
    expect(r.out).toMatch(/high \(100% of sessions\).*8 sessions/);
    expect(r.out).toContain("Next: ");
    expect(r.out).toContain("Context window shrank in the 7 days to 2026-10-02 with no CLI change (0.141.0)");
    expect(r.out).not.toContain("last 7 days");
  });

  it("says when there is too little history to compare", () => {
    const r = run(["check", "--since", "2026-09-29", roots[0], roots[1]]);
    expect(r.out.split("\n")[1]).toMatch(/^Result: nothing to report, but there is not much history to compare yet/);
  });

  it("--root reads only the agents it names", () => {
    const r = run(["scan", "--json", roots[0], roots[1]], { CODEX_HOME: join(dir, "logs", "codex") });
    expect(JSON.parse(r.out).summary.files).toEqual({ claude: 32 });
    const bad = run(["check", "--root", `claud=${dir}`]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown agent "claud"');
  });

  it("explains an empty --since window and a wrong --root folder", () => {
    const since = run(["check", "--since", "2030-01-01", ...roots]);
    expect(since.code).toBe(0);
    expect(since.out).toMatch(/Found \d+ session file\(s\), but none have model responses since 2030-01-01/);
    const missing = join(dir, "no-such-folder");
    const home = tmp(); // so the folder is not printed relative to ~ (on Windows the temp dir is under the profile)
    const typo = run(["check", "--root", `claude=${missing}`], { HOME: home, USERPROFILE: home });
    expect(typo.out).toContain(`Looked in: ${missing}.`);
  });

  it("rejects bad numbers and output names before reading any logs", () => {
    expect(run(["check", "--recent-days", "abc", ...roots]).err).toContain("--recent-days must be a whole number");
    expect(run(["check", "--baseline-days", "0", ...roots]).code).toBe(2);
    const out = run(["report", "--out", "x.txt", ...roots]);
    expect(out.code).toBe(2);
    expect(out.err).toContain('--out must end in .md or .json, got "x.txt"');
  });

  it("with no command prints help and where to start", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Start here: nerf-watch check");
  });

  it("share says why, what is shared and what to fill in", () => {
    const r = run(["share", ...roots]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("This is exactly what would be shared (5 finding(s)). Nothing has been sent");
    expect(r.out).toContain('fill in "What you observed"');
    expect(r.out).toContain("https://github.com/Abelo9996/open-agent-lab/issues/new?template=regression-report.yml");
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
    expect(md).toContain("# nerf-watch report");
    expect(md).toContain("Requested claude-opus-5 but claude-sonnet-5 answered");
    const j = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    expect(j.summary).toEqual({ alert: 2, warn: 3, info: 0 });
  });

  it("handles missing logs and bad flags", () => {
    const empty = tmp();
    const r = run(["check"], { HOME: empty, USERPROFILE: empty, CLAUDE_CONFIG_DIR: join(empty, "c"), CODEX_HOME: join(empty, "x") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("No Claude Code or Codex session logs found");
    expect(r.out).toContain(join("x", "archived_sessions")); // shown as ~/x/archived_sessions
    expect(r.out).toContain("--root claude=DIR");
    expect(run(["check", "--agent", "nope"]).code).toBe(2);
    expect(run(["scan", "--since", "whenever"]).code).toBe(2);
    expect(run(["frobnicate"]).code).toBe(2);
    const help = run(["--help"]).out;
    expect(help).toContain("check");
    expect(help).toMatch(/^nerf-watch\b/m);
  });

  it("reads CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const d = join(dir, "logs");
    const r = run(["scan", "--json"], { CLAUDE_CONFIG_DIR: join(d, "claude"), CODEX_HOME: join(d, "codex") });
    expect(JSON.parse(r.out).summary.files).toEqual({ claude: 32, codex: 24 });
  });
});
