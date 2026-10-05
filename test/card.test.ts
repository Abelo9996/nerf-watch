import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { claudeSession, SENTINEL_CWD, SENTINEL_PROMPT, toJsonl, writeDemo } from "../scripts/make-demo-data.mjs";
import { buildCard, CARD_COMMAND, CARD_REPO, cardModel, timePhrase } from "../src/card.js";
import { SHARE_SCHEMA, type ShareFinding, type SharePayload } from "../src/share.js";
import { tmp } from "./helpers.js";

/**
 * Minimal XML well-formedness check, enough for the SVG the card writes:
 * one root element, balanced tags, quoted attributes without duplicates,
 * and no raw `<` or unescaped `&` in text or attribute values.
 */
function xmlProblems(xml: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*="(?:[^"<&]|&(?:amp|lt|gt|quot|apos|#\d+);)*")*)\s*(\/?)>/y;
  const textOk = /^(?:[^<&]|&(?:amp|lt|gt|quot|apos|#\d+);)*$/;
  let roots = 0;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const chunk = lt === -1 ? xml.slice(i) : xml.slice(i, lt);
    if (!textOk.test(chunk)) problems.push(`unescaped text at ${i}`);
    if (!stack.length && chunk.trim()) problems.push(`text outside the root at ${i}`);
    if (lt === -1) break;
    tag.lastIndex = lt;
    const m = tag.exec(xml);
    if (!m) {
      problems.push(`malformed tag at ${lt}: ${xml.slice(lt, lt + 40)}`);
      break;
    }
    const [, close, name, attrs, self] = m;
    const names = [...attrs.matchAll(/\s([A-Za-z_:][\w:.-]*)=/g)].map((x) => x[1]);
    if (new Set(names).size !== names.length) problems.push(`duplicate attribute in <${name}>`);
    if (close) {
      const open = stack.pop();
      if (open !== name) problems.push(`</${name}> closes <${open}>`);
      if (!stack.length) roots++;
    } else if (self) {
      if (!stack.length) roots++;
    } else stack.push(name);
    i = lt + m[0].length;
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(", ")}`);
  if (roots !== 1) problems.push(`expected one root element, found ${roots}`);
  return problems;
}

function f(over: Partial<ShareFinding> = {}): ShareFinding {
  return {
    detector: "cacheCreation-shift",
    signal: "cache-writes",
    severity: "alert",
    trigger: "version",
    agent: "claude",
    model: "claude-opus-5",
    servedModel: null,
    cliBefore: "2.1.271",
    cliAfter: "2.1.272",
    before: { value: 926, samples: 780, from: "2026-08-23", to: "2026-09-16" },
    after: { value: 3037, samples: 460, from: "2026-09-19", to: "2026-10-02" },
    ...over,
  };
}

function payload(findings: ShareFinding[]): SharePayload {
  return {
    schema: SHARE_SCHEMA,
    nerfWatchVersion: "0.3.0",
    window: { from: "2026-08-23", to: "2026-10-02" },
    agents: [
      { id: "claude", sessions: 32, turns: 1280 },
      { id: "codex", sessions: 24, turns: 720 },
    ],
    findings,
  };
}

const FINDINGS = [
  f({ severity: "warn", detector: "cacheHitRate-shift", signal: "cache-hit-rate", before: { value: 0.982, samples: 780, from: null, to: null }, after: { value: 0.8, samples: 460, from: null, to: null } }),
  f({ detector: "model-mismatch", signal: "model-reroute", trigger: "event", servedModel: "claude-sonnet-5", cliBefore: null, before: null, after: { value: 0.094, samples: 120, from: "2026-09-19", to: "2026-10-02" } }),
  f(),
  f({
    agent: "codex",
    severity: "warn",
    detector: "contextWindow-drift",
    signal: "context-shrink",
    trigger: "time",
    model: "gpt-5.5",
    cliBefore: "0.141.0",
    cliAfter: "0.141.0",
    before: { value: 353400, samples: 300, from: null, to: null },
    after: { value: 258400, samples: 200, from: null, to: null },
  }),
];

// En and em dash, built from code points so this file itself contains neither.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("card wording", () => {
  it("headlines the top finding: alerts first, then version changes", () => {
    const m = cardModel(payload(FINDINGS), { totalFindings: 5 });
    expect(m.kind).toBe("findings");
    expect(m.headline).toBe("Cache writes per turn up 3.3x after Claude Code 2.1.272");
    expect(m.rows.map((r) => [r.severity, r.title, r.before, r.after, r.unit, r.detail])).toEqual([
      ["alert", "Cache writes per turn up 3.3x", "926", "3,037", "tokens", "Claude Code 2.1.271 to 2.1.272 · claude-opus-5"],
      ["alert", "A different model answered", null, "9.4%", "of turns", "Claude Code 2.1.272 · asked claude-opus-5, got claude-sonnet-5"],
      ["warn", "Cache hit rate down", "98%", "80%", "", "Claude Code 2.1.271 to 2.1.272 · claude-opus-5"],
    ]);
    expect(m.more).toBe(2);
    expect(m.responses).toBe(2000);
    expect(m.sessions).toBe(56);
    expect(m.range).toBe("2026-08-23 to 2026-10-02");
  });

  it("says no silent changes over the window when nothing was found", () => {
    expect(cardModel(payload([]), { since: "30d" }).headline).toBe("No silent changes in Claude Code or Codex over the last 30 days");
    expect(cardModel(payload([]), { since: "2026-09-01" }).headline).toBe("No silent changes in Claude Code or Codex since 2026-09-01");
    expect(cardModel(payload([])).headline).toBe("No silent changes in Claude Code or Codex over 41 days of sessions");
    const one = { ...payload([]), agents: [{ id: "codex", sessions: 3, turns: 90 }] };
    expect(cardModel(one, { since: "2w" }).headline).toBe("No silent changes in Codex over the last 2 weeks");
  });

  it("only shows a --since value that is a span or a date", () => {
    expect(timePhrase(payload([]), "1d")).toBe("over the last day");
    expect(timePhrase(payload([]), "/Users/someone")).toBe("over 41 days of sessions");
  });

  it("phrases each kind of change", () => {
    const one = (x: Partial<ShareFinding>) => cardModel(payload([f(x)])).headline;
    expect(one({ detector: "effort-drop", signal: "effort-drop", agent: "codex", cliAfter: "0.141.0", before: { value: 4, samples: 8, from: null, to: null }, after: { value: 3, samples: 8, from: null, to: null } })).toBe(
      "Reasoning effort dropped from high to medium after Codex 0.141.0",
    );
    expect(FINDINGS[3] && one(FINDINGS[3])).toBe("Context window shrank from 353k to 258k on Codex 0.141.0 with no CLI update");
    expect(one({ detector: "toolErrorRate-drift", signal: "tool-errors", trigger: "time", before: { value: 0.03, samples: 400, from: null, to: null }, after: { value: 0.12, samples: 300, from: null, to: null } })).toBe(
      "Tool error rate up from 3% to 12% on Claude Code 2.1.272 with no CLI update",
    );
    expect(one({ detector: "hidden-model", signal: "other", trigger: "event", before: null, after: { value: 120, samples: 120, from: null, to: null } })).toBe(
      "An unrecognized model answered 120 turns on Claude Code 2.1.272",
    );
    expect(one({ detector: "firstTurnPrompt-shift", before: { value: 12000, samples: 10, from: null, to: null }, after: { value: 21600, samples: 10, from: null, to: null } })).toBe(
      "Startup prompt up 1.8x after Claude Code 2.1.272",
    );
  });
});

describe("card SVG", () => {
  const findingsSvg = buildCard(payload(FINDINGS), { totalFindings: 5 });
  const clearSvg = buildCard(payload([]), { since: "30d" });

  it("is well-formed XML, 1200x630, with a title and the footer", () => {
    for (const svg of [findingsSvg, clearSvg]) {
      expect(xmlProblems(svg)).toEqual([]);
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630" viewBox="0 0 1200 630"/);
      expect(svg).toContain("<title id=\"nw-title\">");
      expect(svg).toContain(">checked with nerf-watch</text>");
      expect(svg).toContain(`>${CARD_COMMAND}</text>`);
      expect(svg).toContain(`>${CARD_REPO}</text>`);
      expect(svg).toContain("@media (prefers-color-scheme: dark)");
      expect(svg).not.toMatch(DASHES);
      expect(svg).not.toMatch(/<script|<image|href=|url\(|@import/i); // self-contained, nothing to fetch
    }
  });

  it("the checker catches broken XML", () => {
    expect(xmlProblems("<svg><text>a & b</text></svg>")).not.toEqual([]);
    expect(xmlProblems("<svg><g></svg>")).not.toEqual([]);
    expect(xmlProblems('<svg a="1" a="2"/>')).not.toEqual([]);
    expect(xmlProblems("<svg/><svg/>")).not.toEqual([]);
  });

  it("escapes text", () => {
    const svg = buildCard(payload([f({ model: "a<b>&c" })]));
    expect(xmlProblems(svg)).toEqual([]);
    expect(svg).toContain("a&lt;b&gt;&amp;c");
  });

  it("matches the snapshots", () => {
    expect(findingsSvg).toMatchSnapshot("findings");
    expect(clearSvg).toMatchSnapshot("all clear");
  });
});

describe("card command end to end", () => {
  const CLI = resolve(__dirname, "..", "dist", "cli.js");
  const PLANTED_USER = "plantuser";
  const PLANTED_PATH = `/Users/${PLANTED_USER}/work/secret-client-repo`;
  let dir: string;
  let roots: string[];
  let cleanRoots: string[];
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
    // Sessions in a project folder named after the user, whose served model ids carry a path and the user name.
    const proj = join(d.claudeRoot, `-Users-${PLANTED_USER}-secret-client-repo`);
    mkdirSync(proj, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const s = claudeSession({ version: "2.1.272", model: i % 2 ? PLANTED_PATH : `claude-${PLANTED_USER}-7`, requested: "claude-opus-5", start: Date.UTC(2026, 8, 25 + i), turns: 10 });
      const lines = s.lines.map((l) => (typeof l === "object" && l && "cwd" in l ? { ...l, cwd: PLANTED_PATH } : l));
      writeFileSync(join(proj, `${s.sessionId}.jsonl`), toJsonl(lines));
    }
    roots = ["--root", `claude=${d.claudeRoot}`, "--root", `codex=${d.codexRoot}`];
    const c = writeDemo(join(dir, "clean"), undefined, { clean: true });
    cleanRoots = ["--root", `claude=${c.claudeRoot}`, "--root", `codex=${c.codexRoot}`];
  });

  it("writes the card, and nothing planted reaches it", () => {
    const r = run(["card", ...roots]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Wrote nerf-watch-card.svg (1200x630 SVG): Cache writes per turn up 3.3x after Claude Code 2.1.272");
    expect(r.out).toContain("rsvg-convert -o nerf-watch-card.png nerf-watch-card.svg");
    const svg = readFileSync(join(dir, "nerf-watch-card.svg"), "utf8");
    expect(xmlProblems(svg)).toEqual([]);
    for (const bad of [PLANTED_USER, PLANTED_PATH, "/Users/", "secret-client-repo", SENTINEL_PROMPT, SENTINEL_CWD, "sentinel", "demo-project", dir]) {
      expect(svg).not.toContain(bad);
    }
    expect(svg).not.toMatch(/[0-9a-f]{8}-0000-4000-8000/); // session ids
    expect(svg).not.toMatch(DASHES);
  });

  it("--json says what was written", () => {
    const j = JSON.parse(run(["card", "--json", "--agent", "codex", "--out", "codex.svg", ...roots]).out);
    expect(j).toEqual({ out: "codex.svg", kind: "findings", headline: "Reasoning effort dropped from high to medium after Codex 0.141.0", findings: 2, more: 0 });
    expect(xmlProblems(readFileSync(join(dir, "codex.svg"), "utf8"))).toEqual([]);
  });

  it("makes an all-clear card", () => {
    const r = run(["card", "--out", "clear.svg", ...cleanRoots]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Wrote clear.svg (1200x630 SVG): No silent changes in Claude Code or Codex over 41 days of sessions");
    const svg = readFileSync(join(dir, "clear.svg"), "utf8");
    expect(xmlProblems(svg)).toEqual([]);
    expect(svg).toContain(">CLEAR</text>");
  });

  it("writes no card when there is too little history", () => {
    const r = run(["card", "--out", "short.svg", "--since", "2026-09-29", cleanRoots[0], cleanRoots[1]]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No card yet: there is not enough history to compare");
    expect(existsSync(join(dir, "short.svg"))).toBe(false);
  });

  it("explains PNG and rejects other extensions", () => {
    const png = run(["card", "--out", "card.png", ...roots]);
    expect(png.code).toBe(2);
    expect(png.err).toContain("PNG output is not built in");
    expect(png.err).toContain("rsvg-convert -o card.png card.svg");
    expect(existsSync(join(dir, "card.png"))).toBe(false);
    expect(run(["card", "--out", "card.txt", ...roots]).err).toContain('--out must end in .svg, got "card.txt"');
  });

  it("check suggests a card when there is something to share, including all clear", () => {
    expect(run(["check", ...roots]).out).toContain("Make a shareable image of this result: nerf-watch card");
    expect(run(["check", "--agent", "codex", ...roots]).out).toContain("Make a shareable image of this result: nerf-watch card --agent codex");
    const clear = run(["check", "--since", "2026-08-01", ...cleanRoots]).out;
    expect(clear).toContain("Result: no changes crossed a threshold.");
    expect(clear).toContain("Make a shareable image of this result: nerf-watch card --since 2026-08-01");
    expect(run(["check", "--since", "2026-09-29", cleanRoots[0], cleanRoots[1]]).out).not.toContain("nerf-watch card");
  });
});
