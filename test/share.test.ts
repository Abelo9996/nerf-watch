import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeSession, SENTINEL_CWD, SENTINEL_PROMPT, toJsonl, writeDemo } from "../scripts/make-demo-data.mjs";
import { RULES } from "../src/detectors.js";
import {
  buildSharePayload,
  CUSTOM_MODEL,
  CUSTOM_VERSION,
  DETECTOR_SIGNAL,
  formatPayload,
  leakReason,
  scanPayload,
  shareLink,
  type SharePayload,
} from "../src/share.js";
import type { Dataset, Finding } from "../src/types.js";
import { tmp } from "./helpers.js";

const PLANTED_USER = "plantuser";
const PLANTED_PATH = `/Users/${PLANTED_USER}/work/secret-client-repo`;
const PLANTED_EMAIL = "someone@example.org";
const PLANTED_UUID = "3f2b9c1e-8d4a-4e6f-9b2a-1c3d5e7f9a0b";

function dataset(): Dataset {
  const turn = (agent: string, ts: number) => ({
    agent,
    sessionKey: PLANTED_UUID,
    timestamp: ts,
    cliVersion: "2.1.272",
    usage: { input: 1, cacheRead: 1, cacheCreation: 1, output: 1 },
    workloadKey: PLANTED_PATH,
  });
  return {
    turns: [turn("claude", Date.UTC(2026, 8, 1)), turn("claude", Date.UTC(2026, 9, 1))],
    toolResults: [],
    events: [],
    files: { claude: 2, [PLANTED_PATH]: 1 },
    badLines: {},
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "cacheCreation-shift",
    severity: "alert",
    agent: "claude",
    model: "claude-opus-5",
    trigger: "version",
    title: `Cache writes jumped in ${PLANTED_PATH}`,
    explanation: `${SENTINEL_PROMPT} ${PLANTED_EMAIL}`,
    evidence: [
      { label: "before", versions: ["2.1.270", "2.1.271"], from: "2026-09-01", to: "2026-09-15", samples: 400, value: 900, display: PLANTED_PATH },
      { label: "after", versions: ["2.1.272"], from: "2026-09-16", to: "2026-10-01", samples: 300, value: 3000.123456, display: PLANTED_EMAIL },
    ],
    ...over,
  };
}

const IDS = [PLANTED_USER, `/Users/${PLANTED_USER}`];

describe("share payload", () => {
  it("keeps only structured fields from a finding", () => {
    const p = buildSharePayload(dataset(), [finding()], IDS);
    expect(p.schema).toBe("nerf-watch-share/1");
    expect(p.agents).toEqual([{ id: "claude", sessions: 2, turns: 2 }]);
    expect(p.window).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(p.findings).toEqual([
      {
        detector: "cacheCreation-shift",
        signal: "cache-writes",
        severity: "alert",
        trigger: "version",
        agent: "claude",
        model: "claude-opus-5",
        servedModel: null,
        cliBefore: "2.1.271",
        cliAfter: "2.1.272",
        before: { value: 900, samples: 400, from: "2026-09-01", to: "2026-09-15" },
        after: { value: 3000, samples: 300, from: "2026-09-16", to: "2026-10-01" },
      },
    ]);
    expect(scanPayload(p, IDS)).toEqual([]);
  });

  it("a planted path, username, email or session id in the input never reaches the output", () => {
    const planted: Finding[] = [
      finding({ model: PLANTED_PATH }),
      finding({ model: `claude-${PLANTED_USER}-7` }),
      finding({ model: `${PLANTED_USER}@corp.example`, id: "cacheHitRate-drift", trigger: "time" }),
      finding({
        evidence: [
          { label: "before", versions: [`2.1.271-${PLANTED_USER}`], from: PLANTED_PATH, to: "2026-09-15", samples: 1, value: 1, display: "" },
          { label: "after", versions: [PLANTED_UUID], from: "2026-09-16", to: PLANTED_EMAIL, samples: 1, value: 3, display: "" },
        ],
      }),
      {
        id: "model-mismatch",
        severity: "alert",
        agent: "claude",
        model: `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${PLANTED_USER}`,
        requestedModel: PLANTED_PATH,
        trigger: "event",
        title: PLANTED_PATH,
        explanation: PLANTED_PATH,
        evidence: [
          { label: "requested", versions: ["2.1.272"], samples: 10, value: 10, display: PLANTED_PATH },
          { label: "served", versions: ["2.1.272"], samples: 5, value: 0.5, display: PLANTED_PATH },
        ],
      },
      // Agent ids are fixed, but a planted one must still not get through.
      finding({ agent: PLANTED_PATH }),
    ];
    const p = buildSharePayload(dataset(), planted, IDS);
    const text = formatPayload(p) + JSON.stringify(p) + shareLink(p).url + decodeURIComponent(shareLink(p).url);
    for (const bad of [PLANTED_USER, PLANTED_PATH, "/Users/", PLANTED_EMAIL, "@", PLANTED_UUID, "123456789012", SENTINEL_PROMPT, "secret-client-repo"]) {
      expect(text).not.toContain(bad);
    }
    expect(p.findings.map((f) => f.model).sort()).toEqual(["claude-opus-5", CUSTOM_MODEL, CUSTOM_MODEL, CUSTOM_MODEL, CUSTOM_MODEL]);
    const mismatch = p.findings.find((f) => f.detector === "model-mismatch")!;
    expect(mismatch.servedModel).toBe(CUSTOM_MODEL);
    const versions = p.findings.find((f) => f.cliBefore === CUSTOM_VERSION)!;
    expect(versions.cliAfter).toBe(CUSTOM_VERSION);
    expect(versions.before!.from).toBeNull();
    expect(versions.after.to).toBeNull();
    expect(p.findings).toHaveLength(5); // the finding with a planted agent id is dropped
    expect(scanPayload(p, IDS)).toEqual([]);
  });

  it("drops info findings and detectors the regression watch does not know", () => {
    const p = buildSharePayload(dataset(), [finding({ severity: "info" }), finding({ id: "model-fallback", trigger: "event" }), finding({ id: "brand-new-detector" })], IDS);
    expect(p.findings).toEqual([]);
  });

  it("every detector that can warn has a signal", () => {
    for (const r of RULES) expect(DETECTOR_SIGNAL[`${r.metric}-shift`]).toBeTruthy();
    for (const id of ["effort-drop", "model-mismatch", "hidden-model"]) expect(DETECTOR_SIGNAL[id]).toBeTruthy();
  });
});

describe("defensive scan", () => {
  it("flags anything that could identify the user", () => {
    expect(leakReason("/home/alice/x", [])).toMatch(/path/);
    expect(leakReason("C:\\Users\\alice", [])).toMatch(/path/);
    expect(leakReason("~/x", [])).toMatch(/path/);
    expect(leakReason("a@b.co", [])).toMatch(/email/);
    expect(leakReason("https://example.org", [])).toMatch(/path|URL/);
    expect(leakReason(PLANTED_UUID, [])).toMatch(/session/);
    expect(leakReason("deadbeefdeadbeefdeadbeefdeadbeef", [])).toMatch(/hex/);
    expect(leakReason("claude-alice-2", ["alice"])).toMatch(/local user/);
    expect(leakReason("claude-opus-5", ["alice"])).toBeNull();
    expect(leakReason("2.1.272", ["alice"])).toBeNull();
    expect(leakReason("nerf-watch-share/1", [])).toBeNull(); // fixed vocabulary
  });

  it("walks the whole payload", () => {
    const p = buildSharePayload(dataset(), [finding()], IDS) as SharePayload & { extra?: unknown };
    (p.findings[0] as unknown as Record<string, unknown>).note = `see ${PLANTED_PATH}`;
    p.window.to = PLANTED_USER;
    const problems = scanPayload(p, IDS);
    expect(problems.some((x) => x.startsWith("findings[0].note"))).toBe(true);
    expect(problems.some((x) => x.startsWith("window.to"))).toBe(true);
    for (const x of problems) expect(x).not.toContain(PLANTED_USER);
  });
});

describe("issue link", () => {
  it("prefills the regression-report form", () => {
    const p = buildSharePayload(dataset(), [finding()], IDS);
    const link = shareLink(p);
    expect(link.reportPrefilled).toBe(true);
    const u = new URL(link.url);
    expect(u.origin + u.pathname).toBe("https://github.com/Abelo9996/open-agent-lab/issues/new");
    const q = u.searchParams;
    expect(q.get("template")).toBe("regression-report.yml");
    expect(q.get("agent")).toBe("Claude Code");
    expect(q.get("cli_before")).toBe("2.1.271");
    expect(q.get("cli_after")).toBe("2.1.272");
    expect(q.get("model")).toBe("claude-opus-5");
    expect(q.get("first_seen")).toBe("2026-09-16");
    expect(q.get("title")).toBe("[regression] Claude Code 2.1.272: cache writes per turn jumped");
    expect(JSON.parse(q.get("report")!)).toEqual(JSON.parse(JSON.stringify(p)));
  });

  it("falls back to the form without the JSON when the link would be too long", () => {
    const p = buildSharePayload(dataset(), [finding()], IDS);
    const link = shareLink(p, 300);
    expect(link.reportPrefilled).toBe(false);
    expect(new URL(link.url).searchParams.get("report")).toBeNull();
    expect(new URL(link.url).searchParams.get("template")).toBe("regression-report.yml");
    expect(JSON.parse(link.json)).toEqual(JSON.parse(JSON.stringify(p)));
  });
});

describe("share command end to end", () => {
  const CLI = resolve(__dirname, "..", "dist", "cli.js");
  let dir: string;
  let roots: string[];
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", USER: PLANTED_USER, LOGNAME: PLANTED_USER, USERNAME: PLANTED_USER },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error("dist/cli.js missing: run `npm run build` first");
    dir = tmp();
    const d = writeDemo(join(dir, "logs"));
    // Extra sessions whose served model ids carry a path and the user name,
    // in a project directory named after the user.
    const proj = join(d.claudeRoot, `-Users-${PLANTED_USER}-secret-client-repo`);
    mkdirSync(proj, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const s = claudeSession({
        version: "2.1.272",
        model: i % 2 ? PLANTED_PATH : `claude-${PLANTED_USER}-7`,
        requested: "claude-opus-5",
        start: Date.UTC(2026, 8, 25 + i),
        turns: 10,
      });
      const lines = s.lines.map((l) => (typeof l === "object" && l && "cwd" in l ? { ...l, cwd: PLANTED_PATH } : l));
      writeFileSync(join(proj, `${s.sessionId}.jsonl`), toJsonl(lines));
    }
    roots = ["--root", `claude=${d.claudeRoot}`, "--root", `codex=${d.codexRoot}`];
  });

  it("shows the payload and a link, and nothing planted reaches the output", () => {
    const r = run(["share", ...roots]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("This is exactly what would be shared");
    expect(r.out).toContain("https://github.com/Abelo9996/open-agent-lab/issues/new?template=regression-report.yml");
    expect(r.out).toContain("Run with --open");
    expect(r.out).toContain(`"model":"${CUSTOM_MODEL}"`);
    const all = r.out + decodeURIComponent(r.out.match(/https:\/\/\S+/)![0]);
    for (const bad of [PLANTED_USER, PLANTED_PATH, "/Users/", SENTINEL_PROMPT, SENTINEL_CWD, "sentinel", "demo-project", dir, "secret-client-repo"]) {
      expect(all).not.toContain(bad);
    }
    expect(all).not.toMatch(/[0-9a-f]{8}-0000-4000-8000/);
  });

  it("--json returns the payload and the link", () => {
    const j = JSON.parse(run(["share", "--json", ...roots]).out);
    expect(j.payload.schema).toBe("nerf-watch-share/1");
    expect(j.payload.findings.length).toBeGreaterThan(0);
    expect(j.reportPrefilled).toBe(true);
    expect(JSON.parse(new URL(j.url).searchParams.get("report")!)).toEqual(j.payload);
    expect(JSON.stringify(j)).not.toContain(PLANTED_USER);
  });

  it("report --share is the same command", () => {
    const a = run(["share", ...roots]).out;
    const b = run(["report", "--share", ...roots]).out;
    expect(b).toBe(a);
    expect(existsSync(join(dir, "nerf-watch-report.md"))).toBe(false);
  });

  it("says so when there is nothing to share", () => {
    const r = run(["share", "--agent", "codex", "--since", "2026-10-02", ...roots]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing to share|No Claude Code or Codex session logs/);
    expect(r.out).not.toContain("https://");
  });
});
