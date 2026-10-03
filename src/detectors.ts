import {
  EFFORT_RANK,
  METRICS,
  cohortsByVersion,
  compareVersions,
  modalEffort,
  modelOf,
  normalizeModel,
  sessionCount,
  type Cohort,
} from "./metrics.js";
import type { Dataset, Evidence, Finding, Severity, Turn } from "./types.js";

const DAY = 86_400_000;

export interface CheckOptions {
  /** Length of the "recent" window for same-version time comparisons, in days. */
  recentDays?: number;
  /** Length of the baseline window that precedes it, in days. */
  baselineDays?: number;
}

type Direction = "up" | "down";

interface Rule {
  metric: keyof typeof METRICS;
  worse: Direction;
  judge(before: number, after: number): Severity | null;
  title(agent: string, model: string, where: string): string;
  explain(before: string, after: string): string;
}

const ratioUp = (warn: number, alert: number, minAbs: number) => (b: number, a: number): Severity | null => {
  if (a - b < minAbs) return null;
  const r = b > 0 ? a / b : Infinity;
  return r >= alert ? "alert" : r >= warn ? "warn" : null;
};

export const RULES: Rule[] = [
  {
    metric: "newInput",
    worse: "up",
    judge: ratioUp(1.5, 2.0, 500),
    title: (_a, _m, where) => `Uncached input per turn jumped ${where}`,
    explain: (b, a) =>
      `Each API call now sends a median of ${a} tokens that are not served from cache, up from ${b}. ` +
      `You pay full input price for these tokens, so the same work costs more and uses more of your rate limit. ` +
      `Common causes are a larger system prompt, more tool definitions, or a change in how the CLI builds requests.`,
  },
  {
    metric: "cacheCreation",
    worse: "up",
    judge: ratioUp(1.5, 2.0, 500),
    title: (_a, _m, where) => `Cache-creation tokens per turn jumped ${where}`,
    explain: (b, a) =>
      `Median cache writes per API call went from ${b} to ${a}. Cache writes are billed above the normal input price. ` +
      `A jump usually means the cached prefix is being invalidated and rebuilt more often.`,
  },
  {
    metric: "firstTurnPrompt",
    worse: "up",
    judge: ratioUp(1.3, 1.75, 2000),
    title: (_a, _m, where) => `Session startup prompt grew ${where}`,
    explain: (b, a) =>
      `The first request of a session now carries a median of ${a} prompt tokens, up from ${b}. ` +
      `That is fixed overhead (system prompt, tool schemas, injected context) paid by every new session and it shrinks the room left for your own work.`,
  },
  {
    metric: "cacheHitRate",
    worse: "down",
    judge: (b, a) => (b - a >= 0.3 ? "alert" : b - a >= 0.15 ? "warn" : null),
    title: (_a, _m, where) => `Cache hit rate collapsed ${where}`,
    explain: (b, a) =>
      `The share of prompt tokens served from cache fell from ${b} to ${a}. ` +
      `Uncached tokens cost several times more than cached ones and count harder against rate limits, so this shows up as faster limit exhaustion and higher bills for the same work.`,
  },
  {
    metric: "toolErrorRate",
    worse: "up",
    judge: (b, a) => {
      const d = a - b;
      const r = b > 0 ? a / b : Infinity;
      if (d >= 0.1 && r >= 2) return "alert";
      if (d >= 0.05 && r >= 1.5) return "warn";
      return null;
    },
    title: (_a, _m, where) => `Tool call error rate jumped ${where}`,
    explain: (b, a) =>
      `The share of tool calls that returned an error went from ${b} to ${a}. ` +
      `This can mean the model is producing malformed tool calls, the tool layer changed, or your environment changed (for example, a broken test suite). Check the last one first.`,
  },
  {
    metric: "contextWindow",
    worse: "down",
    judge: (b, a) => (b <= 0 ? null : a / b <= 0.6 ? "alert" : a / b <= 0.9 ? "warn" : null),
    title: (_a, _m, where) => `Context window shrank ${where}`,
    explain: (b, a) =>
      `The usable context went from about ${b} to ${a} tokens. Long sessions will compact or truncate sooner, and the model sees less of your code at once.`,
  },
];

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function merge(cs: Cohort[]): Cohort {
  return {
    turns: cs.flatMap((c) => c.turns),
    tools: cs.flatMap((c) => c.tools),
    compactions: cs.flatMap((c) => c.compactions),
  };
}

function span(c: Cohort): { from: string; to: string } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of c.turns) {
    if (t.timestamp < lo) lo = t.timestamp;
    if (t.timestamp > hi) hi = t.timestamp;
  }
  return Number.isFinite(lo) ? { from: iso(lo), to: iso(hi) } : { from: "", to: "" };
}

function versionLabel(vs: string[]): string {
  if (vs.length <= 1) return vs[0] ?? "?";
  return `${vs[0]} to ${vs[vs.length - 1]}`;
}

/** Group version cohorts by (agent, model), sorted by CLI version. */
function versionSeries(ds: Dataset) {
  const groups = new Map<string, { agent: string; model: string; series: (Cohort & { version: string })[] }>();
  for (const c of cohortsByVersion(ds).values()) {
    if (c.version === "unknown") continue;
    const k = `${c.agent}\u0000${c.model}`;
    let g = groups.get(k);
    if (!g) {
      g = { agent: c.agent, model: c.model, series: [] };
      groups.set(k, g);
    }
    g.series.push(c);
  }
  for (const g of groups.values()) g.series.sort((a, b) => compareVersions(a.version, b.version));
  return [...groups.values()];
}

const WINDOW_VERSIONS = 3;

/**
 * Change-point scan across CLI versions. For each version V, the versions
 * just before V (up to three, pooled) are compared with V plus up to two
 * following versions (pooled until there is enough data). When a rule trips,
 * the scan jumps past the "after" window and starts a fresh baseline there, so
 * one regression is reported once, at the version where it began.
 */
export function detectVersionShifts(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  for (const g of versionSeries(ds)) {
    if (g.model === "unknown") continue;
    for (const rule of RULES) {
      const m = METRICS[rule.metric];
      const s = g.series;
      let baseStart = 0;
      for (let i = 1; i < s.length; i++) {
        const baseline = s.slice(Math.max(baseStart, i - WINDOW_VERSIONS), i);
        if (!baseline.length) continue;
        const before = m.compute(merge(baseline));
        if (!before) continue;
        let after: { value: number; samples: number } | null = null;
        let j = i;
        for (; j < Math.min(s.length, i + WINDOW_VERSIONS); j++) {
          after = m.compute(merge(s.slice(i, j + 1)));
          if (after) break;
        }
        if (!after) continue;
        const sev = rule.judge(before.value, after.value);
        if (!sev) continue;
        const afterSet = s.slice(i, j + 1);
        const pooledBefore = merge(baseline);
        const pooledAfter = merge(afterSet);
        out.push({
          id: `${rule.metric}-shift`,
          severity: sev,
          agent: g.agent,
          model: g.model,
          trigger: "version",
          title: rule.title(g.agent, g.model, `after CLI ${s[i].version}`),
          explanation: rule.explain(m.format(before.value), m.format(after.value)),
          evidence: [
            { label: "before", versions: baseline.map((b) => b.version), ...span(pooledBefore), samples: before.samples, value: before.value, display: m.format(before.value) },
            { label: "after", versions: afterSet.map((b) => b.version), ...span(pooledAfter), samples: after.samples, value: after.value, display: m.format(after.value) },
          ],
        });
        // The after window becomes the new baseline; the next candidate is the version after it.
        baseStart = i;
        i = j;
      }
    }
  }
  return dropRedundant(out);
}

/**
 * For Claude, uncached input is almost entirely cache writes, so both rules
 * fire on the same change. Keep the more specific cache-creation finding.
 */
function dropRedundant(fs: Finding[]): Finding[] {
  const cc = new Set(
    fs.filter((f) => f.id.startsWith("cacheCreation")).map((f) => `${f.agent}|${f.model}|${f.evidence[1]?.versions?.[0]}|${f.trigger}`),
  );
  return fs.filter((f) => !(f.id.startsWith("newInput") && cc.has(`${f.agent}|${f.model}|${f.evidence[1]?.versions?.[0]}|${f.trigger}`)));
}

/**
 * Same CLI version, same model, different time: compares the most recent
 * window with the window before it. A shift here cannot be explained by an
 * update you installed.
 */
export function detectTimeShifts(ds: Dataset, opts: CheckOptions = {}): Finding[] {
  const recentDays = opts.recentDays ?? 7;
  const baselineDays = opts.baselineDays ?? 28;
  const out: Finding[] = [];
  const byGroup = new Map<string, Cohort & { agent: string; model: string }>();
  for (const c of cohortsByVersion(ds).values()) {
    const k = `${c.agent}\u0000${c.model}`;
    const g = byGroup.get(k) ?? { agent: c.agent, model: c.model, turns: [], tools: [], compactions: [] };
    g.turns.push(...c.turns);
    g.tools.push(...c.tools);
    g.compactions.push(...c.compactions);
    byGroup.set(k, g);
  }
  for (const g of byGroup.values()) {
    if (g.model === "unknown" || !g.turns.length) continue;
    const end = Math.max(...g.turns.map((t) => t.timestamp));
    const cut = end - recentDays * DAY;
    const start = cut - baselineDays * DAY;
    // Dominant version in the recent window.
    const counts = new Map<string, number>();
    for (const t of g.turns) if (t.timestamp > cut && t.cliVersion) counts.set(t.cliVersion, (counts.get(t.cliVersion) ?? 0) + 1);
    const version = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!version) continue;
    const pick = (lo: number, hi: number): Cohort => ({
      turns: g.turns.filter((t) => t.cliVersion === version && t.timestamp > lo && t.timestamp <= hi),
      tools: g.tools.filter((t) => t.cliVersion === version && t.timestamp > lo && t.timestamp <= hi),
      compactions: g.compactions.filter((t) => t.cliVersion === version && t.timestamp > lo && t.timestamp <= hi),
    });
    const before = pick(start, cut);
    const after = pick(cut, end);
    for (const rule of RULES) {
      if (rule.metric === "firstTurnPrompt") continue; // fixed per version, so time adds nothing
      const m = METRICS[rule.metric];
      const b = m.compute(before);
      const a = m.compute(after);
      if (!a || !b) continue;
      const sev = rule.judge(b.value, a.value);
      if (!sev) continue;
      out.push({
        id: `${rule.metric}-drift`,
        severity: sev,
        agent: g.agent,
        model: g.model,
        trigger: "time",
        title: rule.title(g.agent, g.model, `in the last ${recentDays} days with no CLI change (${version})`),
        explanation:
          rule.explain(m.format(b.value), m.format(a.value)) +
          ` The CLI version (${version}) and model are the same in both windows, so the change is on the provider side or in how you used the agent.`,
        evidence: [
          { label: "before", versions: [version], ...span(before), samples: b.samples, value: b.value, display: m.format(b.value) },
          { label: "after", versions: [version], ...span(after), samples: a.samples, value: a.value, display: m.format(a.value) },
        ],
      });
    }
  }
  return out;
}

/** Default reasoning effort went down across a CLI version boundary. */
export function detectEffortDrops(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  for (const g of versionSeries(ds)) {
    let prev: { version: string; effort: string; share: number; samples: number; c: Cohort } | null = null;
    for (const cur of g.series) {
      const e = modalEffort(cur.turns);
      if (!e || e.samples < 30 || sessionCount(cur.turns) < 3) continue;
      if (prev && EFFORT_RANK[e.effort] !== undefined && EFFORT_RANK[prev.effort] !== undefined && EFFORT_RANK[e.effort] < EFFORT_RANK[prev.effort]) {
        out.push({
          id: "effort-drop",
          severity: "warn",
          agent: g.agent,
          model: g.model,
          trigger: "version",
          title: `Reasoning effort dropped from ${prev.effort} to ${e.effort} after CLI ${cur.version}`,
          explanation:
            `Most turns on ${prev.version} ran at "${prev.effort}" effort; on ${cur.version} most run at "${e.effort}". ` +
            `If you did not change the effort setting yourself, the default changed under you. Lower effort is cheaper and faster but plans less and makes more mistakes on hard tasks.`,
          evidence: [
            { label: "before", versions: [prev.version], ...span(prev.c), samples: prev.samples, value: EFFORT_RANK[prev.effort], display: `${prev.effort} (${Math.round(prev.share * 100)}% of turns)` },
            { label: "after", versions: [cur.version], ...span(cur), samples: e.samples, value: EFFORT_RANK[e.effort], display: `${e.effort} (${Math.round(e.share * 100)}% of turns)` },
          ],
        });
      }
      prev = { version: cur.version, ...e, c: cur };
    }
  }
  return out;
}

/** The model that answered is not the model that was requested. */
export function detectModelMismatch(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  const groups = new Map<string, { agent: string; req: string; served: string; turns: Turn[] }>();
  const reqTotals = new Map<string, number>();
  for (const t of ds.turns) {
    if (t.sidechain || !t.requestedModel || !t.servedModel) continue;
    const req = normalizeModel(t.requestedModel);
    const served = normalizeModel(t.servedModel);
    const rk = `${t.agent}\u0000${req}`;
    reqTotals.set(rk, (reqTotals.get(rk) ?? 0) + 1);
    if (req === served) continue;
    const k = `${rk}\u0000${served}`;
    const g = groups.get(k) ?? { agent: t.agent, req, served, turns: [] };
    g.turns.push(t);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const total = reqTotals.get(`${g.agent}\u0000${g.req}`) ?? g.turns.length;
    const share = g.turns.length / total;
    const severity: Severity =
      g.turns.length >= 5 && share >= 0.02 ? "alert" : g.turns.length >= 3 || share >= 0.005 ? "warn" : "info";
    const versions = [...new Set(g.turns.map((t) => t.cliVersion ?? "unknown"))].sort(compareVersions);
    out.push({
      id: "model-mismatch",
      severity,
      agent: g.agent,
      model: g.served,
      trigger: "event",
      title: `Requested ${g.req} but ${g.served} answered`,
      explanation:
        `${g.turns.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} main-thread API responses (${(share * 100).toFixed(1)}%) for sessions configured to use ${g.req} were served by ${g.served}. ` +
        `If you switched models mid-session or use a mode that routes some turns to another model on purpose, this is expected. Otherwise you got a different model than you chose.`,
      evidence: [
        { label: "requested", versions, ...span({ turns: g.turns, tools: [], compactions: [] }), samples: total, value: total, display: g.req },
        { label: "served", versions, ...span({ turns: g.turns, tools: [], compactions: [] }), samples: g.turns.length, value: share, display: `${g.served} (${g.turns.length} turns)` },
      ],
    });
  }
  return out;
}

const PUBLIC_MODEL = /^(claude-[a-z]+-\d[\w.-]*|claude-\d[\w.-]*|gpt-\d[\w.-]*|o\d[\w.-]*|codex-[\w.-]+|gemini-[\w.-]+|deepseek-[\w.-]+|qwen[\w.-]*|kimi-[\w.-]+|glm-[\w.-]+|grok-[\w.-]+)$/i;
const INTERNAL_HINT = /(internal|experiment|\bexp\b|-exp-|staging|canary|shadow|sandbox|nightly|snapshot|eval|test|dev-|-ab-|alpha|bench)/i;

/** A served model id that does not look like a public model id. */
export function detectHiddenModels(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, { agent: string; model: string; turns: Turn[] }>();
  for (const t of ds.turns) {
    if (!t.servedModel) continue;
    const k = `${t.agent}\u0000${t.servedModel}`;
    const g = seen.get(k) ?? { agent: t.agent, model: t.servedModel, turns: [] };
    g.turns.push(t);
    seen.set(k, g);
  }
  for (const g of seen.values()) {
    const m = normalizeModel(g.model);
    if (PUBLIC_MODEL.test(m) && !INTERNAL_HINT.test(m)) continue;
    const versions = [...new Set(g.turns.map((t) => t.cliVersion ?? "unknown"))].sort(compareVersions);
    out.push({
      id: "hidden-model",
      severity: "warn",
      agent: g.agent,
      model: g.model,
      trigger: "event",
      title: `Unrecognized model id answered: ${g.model}`,
      explanation:
        `${g.turns.length} API responses came from "${g.model}", which does not match any public model naming pattern nerf-watch knows. ` +
        `It may be an internal, experimental or A/B test model. If you did not opt into a preview, you were served something other than a released model.`,
      evidence: [
        { label: "served", versions, ...span({ turns: g.turns, tools: [], compactions: [] }), samples: g.turns.length, value: g.turns.length, display: `${g.turns.length} turns` },
      ],
    });
  }
  return out;
}

/** Explicit model fallbacks recorded by the agent. */
export function detectFallbacks(ds: Dataset): Finding[] {
  const groups = new Map<string, { agent: string; from: string; to: string; ts: number[]; versions: Set<string> }>();
  for (const e of ds.events) {
    if (e.kind !== "fallback") continue;
    const k = `${e.agent}\u0000${e.fromModel}\u0000${e.toModel}`;
    const g = groups.get(k) ?? { agent: e.agent, from: e.fromModel, to: e.toModel, ts: [], versions: new Set<string>() };
    g.ts.push(e.timestamp);
    if (e.cliVersion) g.versions.add(e.cliVersion);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({
    id: "model-fallback",
    severity: "info" as Severity,
    agent: g.agent,
    model: g.from,
    trigger: "event" as const,
    title: `Fell back from ${g.from} to ${g.to} (${g.ts.length}x)`,
    explanation:
      `The agent recorded ${g.ts.length} fallback event(s) that moved the session from ${g.from} to ${g.to}, usually because the first model was unavailable or over capacity.`,
    evidence: [
      {
        label: "events",
        versions: [...g.versions].sort(compareVersions),
        from: iso(Math.min(...g.ts)),
        to: iso(Math.max(...g.ts)),
        samples: g.ts.length,
        value: g.ts.length,
        display: `${g.ts.length} fallback(s)`,
      } satisfies Evidence,
    ],
  }));
}

const SEV_ORDER: Record<Severity, number> = { alert: 0, warn: 1, info: 2 };

export function runDetectors(ds: Dataset, opts: CheckOptions = {}): Finding[] {
  const all = [
    ...detectModelMismatch(ds),
    ...detectHiddenModels(ds),
    ...detectEffortDrops(ds),
    ...detectVersionShifts(ds),
    ...dropRedundant(detectTimeShifts(ds, opts)),
    ...detectFallbacks(ds),
  ];
  return all.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.agent.localeCompare(b.agent));
}
