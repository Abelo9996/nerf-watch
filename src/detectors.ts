import {
  EFFORT_RANK,
  METRICS,
  MIN_STRATUM,
  cohortsByVersion,
  compareVersions,
  defaultEffortBySession,
  normalizeModel,
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
  /**
   * How workloads (projects) are controlled for.
   * - "paired": per-turn metrics that depend on the work. The change must show
   *   up inside several individual workloads that have data on both sides.
   * - "spread": the startup prompt. It is nearly fixed per project and CLI
   *   version, and sessions are too few to pair per project, so the pooled
   *   median only needs sessions from several workloads on each side.
   * - "none": discrete settings such as the context window, which do not
   *   depend on the work.
   */
  stratified: "paired" | "spread" | "none";
  judge(before: number, after: number): Severity | null;
  title(agent: string, model: string, where: string): string;
  explain(before: string, after: string): string;
  /** What to do next. `ctx.before` is the last CLI version before the change, if there is one. */
  next(ctx: NextContext): string;
}

interface NextContext {
  agent: string;
  trigger: "version" | "time";
  /** Last CLI version on the before side (version shifts only). */
  before?: string;
  /** First date on the after side. */
  since?: string;
}

const REPORT_IT = "report it to the agent's vendor with the output of `nerf-watch report` attached";

/** Next step for token and cache findings. */
function nextForTokens(ctx: NextContext): string {
  if (ctx.trigger === "time") {
    return `Run \`nerf-watch check\` again in a few days: same-version changes on the provider side are often temporary. If it persists, ${REPORT_IT}.`;
  }
  const back = ctx.before ? ` Going back to CLI ${ctx.before} for a day is the quickest way to confirm it.` : "";
  return `Run \`nerf-watch scan\` to see the numbers for each CLI version.${back} If it holds, ${REPORT_IT}.`;
}

const ratioUp = (warn: number, alert: number, minAbs: number) => (b: number, a: number): Severity | null => {
  if (a - b < minAbs) return null;
  const r = b > 0 ? a / b : Infinity;
  return r >= alert ? "alert" : r >= warn ? "warn" : null;
};

export const RULES: Rule[] = [
  {
    metric: "newInput",
    stratified: "paired",
    worse: "up",
    judge: ratioUp(1.5, 2.0, 500),
    title: (_a, _m, where) => `Uncached input per turn jumped ${where}`,
    explain: (b, a) =>
      `Each API call now sends a median of ${a} that are not served from cache, up from ${b}. ` +
      `You pay full input price for these tokens, so the same work costs more and uses more of your rate limit. ` +
      `Common causes are a larger system prompt, more tool definitions, or a change in how the CLI builds requests.`,
    next: nextForTokens,
  },
  {
    metric: "cacheCreation",
    stratified: "paired",
    worse: "up",
    judge: ratioUp(1.5, 2.0, 500),
    title: (_a, _m, where) => `Cache-creation tokens per turn jumped ${where}`,
    explain: (b, a) =>
      `Median cache writes per API call went from ${b} to ${a}. Cache writes are billed above the normal input price. ` +
      `A jump usually means the cached prefix is being invalidated and rebuilt more often.`,
    next: nextForTokens,
  },
  {
    metric: "firstTurnPrompt",
    stratified: "spread",
    worse: "up",
    judge: ratioUp(1.3, 1.75, 2000),
    title: (_a, _m, where) => `Session startup prompt grew ${where}`,
    explain: (b, a) =>
      `The first request of a session now carries a median prompt of ${a}, up from ${b}. ` +
      `That is fixed overhead (system prompt, tool schemas, injected context) paid by every new session and it shrinks the room left for your own work.`,
    next: (ctx) =>
      `First check whether you added MCP servers, skills, plugins or memory files (CLAUDE.md, AGENTS.md)${ctx.since ? ` around ${ctx.since}` : ""}: they grow the startup prompt too. If you did not, ${REPORT_IT}.`,
  },
  {
    metric: "cacheHitRate",
    stratified: "paired",
    worse: "down",
    judge: (b, a) => (b - a >= 0.3 ? "alert" : b - a >= 0.15 ? "warn" : null),
    title: (_a, _m, where) => `Cache hit rate collapsed ${where}`,
    explain: (b, a) =>
      `The share of prompt tokens served from cache fell from ${b} to ${a}. ` +
      `Uncached tokens cost several times more than cached ones and count harder against rate limits, so this shows up as faster limit exhaustion and higher bills for the same work.`,
    next: nextForTokens,
  },
  {
    metric: "toolErrorRate",
    stratified: "paired",
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
    next: () =>
      `Look at a few recent failed tool calls in your sessions first: a broken test command, a missing binary or a permissions change is the usual cause. If your environment did not change, ${REPORT_IT}.`,
  },
  {
    metric: "contextWindow",
    stratified: "none",
    worse: "down",
    judge: (b, a) => (b <= 0 ? null : a / b <= 0.6 ? "alert" : a / b <= 0.9 ? "warn" : null),
    title: (_a, _m, where) => `Context window shrank ${where}`,
    explain: (b, a) =>
      `The usable context went from about ${b} to ${a}. Long sessions will compact or truncate sooner, and the model sees less of your code at once.`,
    next: (ctx) =>
      ctx.agent === "codex"
        ? `Check model_context_window in ~/.codex/config.toml and in any profile you use. If you did not change it, ${REPORT_IT}.`
        : ctx.agent === "claude"
          ? `Check whether you switched between the 1M context variant of the model and the standard one, or changed the auto-compact setting. If you did not, ${REPORT_IT}.`
          : `Check whether you changed the context window or compaction settings. If you did not, ${REPORT_IT}.`,
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

/** Minimum number of workloads with enough data on both sides of a stratified comparison. */
export const MIN_WORKLOADS = 2;
/** Share of those workloads that must cross the threshold on their own. */
export const WORKLOAD_AGREEMENT = 2 / 3;

function byWorkload(c: Cohort): Map<string, Cohort> {
  const out = new Map<string, Cohort>();
  const get = (k: string | undefined) => {
    const key = k ?? "";
    let w = out.get(key);
    if (!w) out.set(key, (w = { turns: [], tools: [], compactions: [] }));
    return w;
  };
  for (const t of c.turns) get(t.workloadKey).turns.push(t);
  for (const t of c.tools) get(t.workloadKey).tools.push(t);
  // Compaction events carry no workload; they only feed the unstratified context window rule.
  return out;
}

interface Comparison {
  severity: Severity;
  before: { value: number; samples: number; unit?: string };
  after: { value: number; samples: number; unit?: string };
  /** For stratified rules: workloads compared, and how many crossed the threshold. */
  workloads?: { paired: number; agreeing: number };
}

const SEV_RANK: Record<Severity, number> = { info: 0, warn: 1, alert: 2 };

/**
 * Compare two cohorts under one rule. The pooled values must cross the
 * threshold. For stratified rules the change must also hold inside individual
 * workloads: at least MIN_WORKLOADS workloads with enough data on both sides,
 * and at least WORKLOAD_AGREEMENT of them crossing the threshold on their own.
 * That separates "the agent changed" (every project moves) from "the work
 * changed" (one project, or a different mix of projects, moves the pooled
 * median). Records without a workload key (adapters that cannot provide one)
 * are compared pooled only.
 */
export function compareCohorts(rule: Rule, before: Cohort, after: Cohort): Comparison | null {
  const m = METRICS[rule.metric];
  const b = m.compute(before);
  const a = m.compute(after);
  if (!b || !a) return null;
  const pooled = rule.judge(b.value, a.value);
  if (!pooled) return null;
  if (rule.stratified === "none") return { severity: pooled, before: b, after: a };
  const bw = byWorkload(before);
  const aw = byWorkload(after);
  if (rule.stratified === "spread") {
    const spread = (c: Cohort) => new Set(c.turns.filter((t) => t.firstInSession && !t.sidechain).map((t) => t.workloadKey ?? "")).size;
    const keyed = (c: Cohort) => c.turns.some((t) => t.workloadKey);
    if ((keyed(before) && spread(before) < MIN_WORKLOADS) || (keyed(after) && spread(after) < MIN_WORKLOADS)) return null;
    return { severity: pooled, before: b, after: a };
  }
  const keys = [...bw.keys()].filter((k) => aw.has(k));
  if (keys.length === 1 && keys[0] === "" && bw.size === 1 && aw.size === 1) return { severity: pooled, before: b, after: a };
  let paired = 0;
  let warn = 0;
  let alert = 0;
  for (const k of keys) {
    if (k === "") continue;
    const sb = m.compute(bw.get(k)!, MIN_STRATUM);
    const sa = m.compute(aw.get(k)!, MIN_STRATUM);
    if (!sb || !sa) continue;
    paired++;
    const sev = rule.judge(sb.value, sa.value);
    if (sev) warn++;
    if (sev === "alert") alert++;
  }
  if (paired < MIN_WORKLOADS || warn < MIN_WORKLOADS || warn < paired * WORKLOAD_AGREEMENT) return null;
  const strata: Severity = alert >= MIN_WORKLOADS && alert >= paired * WORKLOAD_AGREEMENT ? "alert" : "warn";
  const severity = SEV_RANK[strata] < SEV_RANK[pooled] ? strata : pooled;
  return { severity, before: b, after: a, workloads: { paired, agreeing: warn } };
}

function workloadNote(c: Comparison): string {
  if (!c.workloads) return "";
  return ` The change shows up in ${c.workloads.agreeing} of ${c.workloads.paired} separate workloads (projects) that have enough data on both sides, so it is not explained by a change in what you worked on.`;
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
/** CLI versions ship often, so sparse data may need a wider window to reach the minimums. */
const MAX_WINDOW_VERSIONS = 6;

/**
 * Change-point scan across CLI versions. For each version V, the versions
 * just before V (three, or up to six when three hold too little data, pooled)
 * are compared with V plus up to five following versions (pooled until there
 * is enough data). When a rule trips,
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
        // Baseline: the three versions before i, reaching further back (up to
        // MAX_WINDOW_VERSIONS) when they do not hold enough data on their own.
        let k = Math.max(baseStart, i - WINDOW_VERSIONS);
        while (k > Math.max(baseStart, i - MAX_WINDOW_VERSIONS) && !m.compute(merge(s.slice(k, i)))) k--;
        const baseline = s.slice(k, i);
        if (!baseline.length) continue;
        const pooledBefore = merge(baseline);
        if (!m.compute(pooledBefore)) continue;
        let after: { value: number; samples: number } | null = null;
        let j = i;
        for (; j < Math.min(s.length, i + MAX_WINDOW_VERSIONS); j++) {
          after = m.compute(merge(s.slice(i, j + 1)));
          if (after) break;
        }
        if (!after) continue;
        const afterSet = s.slice(i, j + 1);
        const pooledAfter = merge(afterSet);
        const cmp = compareCohorts(rule, pooledBefore, pooledAfter);
        if (!cmp) continue;
        const afterSpan = span(pooledAfter);
        out.push({
          id: `${rule.metric}-shift`,
          severity: cmp.severity,
          agent: g.agent,
          model: g.model,
          trigger: "version",
          title: rule.title(g.agent, g.model, afterSet.length > 1 ? `between CLI ${s[i].version} and ${afterSet[afterSet.length - 1].version}` : `after CLI ${s[i].version}`),
          explanation: rule.explain(m.format(cmp.before.value), m.format(cmp.after.value)) + workloadNote(cmp),
          nextStep: rule.next({ agent: g.agent, trigger: "version", before: baseline[baseline.length - 1]?.version, since: afterSpan.from || undefined }),
          evidence: [
            { label: "before", versions: baseline.map((b) => b.version), ...span(pooledBefore), samples: cmp.before.samples, sampleUnit: cmp.before.unit ?? m.sampleUnit, value: cmp.before.value, display: m.format(cmp.before.value) },
            { label: "after", versions: afterSet.map((b) => b.version), ...afterSpan, samples: cmp.after.samples, sampleUnit: cmp.after.unit ?? m.sampleUnit, value: cmp.after.value, display: m.format(cmp.after.value) },
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
      const cmp = compareCohorts(rule, before, after);
      if (!cmp) continue;
      const { before: b, after: a } = cmp;
      const afterSpan = span(after);
      out.push({
        id: `${rule.metric}-drift`,
        severity: cmp.severity,
        agent: g.agent,
        model: g.model,
        trigger: "time",
        // Dated, not "in the last N days": the recent window ends at this model's last use, which can be long ago.
        title: rule.title(g.agent, g.model, `in the ${recentDays} days to ${iso(end)} with no CLI change (${version})`),
        explanation:
          rule.explain(m.format(b.value), m.format(a.value)) +
          ` The CLI version (${version}) and model are the same in both windows, so the change did not come from an update you installed: it is on the provider side or in how you used the agent.` +
          workloadNote(cmp),
        nextStep: rule.next({ agent: g.agent, trigger: "time", since: afterSpan.from || undefined }),
        evidence: [
          { label: "before", versions: [version], ...span(before), samples: b.samples, sampleUnit: b.unit ?? m.sampleUnit, value: b.value, display: m.format(b.value) },
          { label: "after", versions: [version], ...afterSpan, samples: a.samples, sampleUnit: a.unit ?? m.sampleUnit, value: a.value, display: m.format(a.value) },
        ],
      });
    }
  }
  return out;
}

/** Minimum sessions (each counted once, by the effort it started with) per version for the effort check. */
export const EFFORT_MIN_SESSIONS = 3;
/** Share of those sessions that must agree on the effort level. */
export const EFFORT_MIN_SHARE = 0.6;

/**
 * Default reasoning effort went down across a CLI version boundary. Each
 * main-thread session counts once, by the effort it started with; turns after
 * the user changed effort (/effort, or the /model picker) are ignored. The
 * level must be the majority in several sessions from at least two workloads
 * on both sides, so one session where the user picked "max" cannot make the
 * next version look like a downgrade.
 */
export function detectEffortDrops(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  type Level = { version: string; effort: string; share: number; samples: number; c: Cohort };
  const level = (cur: Cohort & { version: string }): Level | null => {
    const sessions = defaultEffortBySession(cur.turns);
    if (sessions.length < EFFORT_MIN_SESSIONS) return null;
    const counts = new Map<string, number>();
    for (const x of sessions) counts.set(x.effort, (counts.get(x.effort) ?? 0) + 1);
    const [effort, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = n / sessions.length;
    if (share < EFFORT_MIN_SHARE) return null;
    const workloads = new Set(sessions.filter((x) => x.effort === effort).map((x) => x.workloadKey ?? ""));
    const keyed = sessions.some((x) => x.workloadKey);
    if (keyed && workloads.size < MIN_WORKLOADS) return null;
    return { version: cur.version, effort, share, samples: sessions.length, c: cur };
  };
  for (const g of versionSeries(ds)) {
    let prev: Level | null = null;
    for (const cur of g.series) {
      const e = level(cur);
      if (!e) continue;
      if (prev && EFFORT_RANK[e.effort] !== undefined && EFFORT_RANK[prev.effort] !== undefined && EFFORT_RANK[e.effort] < EFFORT_RANK[prev.effort]) {
        out.push({
          id: "effort-drop",
          severity: "warn",
          agent: g.agent,
          model: g.model,
          trigger: "version",
          title: `Reasoning effort dropped from ${prev.effort} to ${e.effort} after CLI ${cur.version}`,
          explanation:
            `Most sessions on ${prev.version} started at "${prev.effort}" effort; on ${cur.version} most start at "${e.effort}". ` +
            `Sessions where you changed the effort yourself are not counted. If you did not change the effort setting in your config either, the default changed under you. Lower effort is cheaper and faster but plans less and makes more mistakes on hard tasks.`,
          nextStep:
            g.agent === "codex"
              ? `If you want ${prev.effort}, set it explicitly (model_reasoning_effort in ~/.codex/config.toml) so a default change cannot lower it.`
              : g.agent === "claude"
                ? `If you want ${prev.effort}, set it explicitly with /effort so a default change cannot lower it.`
                : `If you want ${prev.effort}, set the effort explicitly in the agent's settings so a default change cannot lower it.`,
          evidence: [
            { label: "before", versions: [prev.version], ...span(prev.c), samples: prev.samples, sampleUnit: "sessions", value: EFFORT_RANK[prev.effort], display: `${prev.effort} (${Math.round(prev.share * 100)}% of sessions)` },
            { label: "after", versions: [cur.version], ...span(cur), samples: e.samples, sampleUnit: "sessions", value: EFFORT_RANK[e.effort], display: `${e.effort} (${Math.round(e.share * 100)}% of sessions)` },
          ],
        });
      }
      prev = e;
    }
  }
  return out;
}

/** The model that answered is not the model that was requested. */
export function detectModelMismatch(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  const groups = new Map<string, { agent: string; req: string; served: string; turns: Turn[] }>();
  const reqTurns = new Map<string, Turn[]>();
  for (const t of ds.turns) {
    if (t.sidechain || !t.requestedModel || !t.servedModel) continue;
    const req = normalizeModel(t.requestedModel);
    const served = normalizeModel(t.servedModel);
    const rk = `${t.agent}\u0000${req}`;
    const rt = reqTurns.get(rk);
    if (rt) rt.push(t);
    else reqTurns.set(rk, [t]);
    if (req === served) continue;
    const k = `${rk}\u0000${served}`;
    const g = groups.get(k) ?? { agent: t.agent, req, served, turns: [] };
    g.turns.push(t);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const requested = reqTurns.get(`${g.agent}\u0000${g.req}`) ?? g.turns;
    const total = requested.length;
    const share = g.turns.length / total;
    const severity: Severity =
      g.turns.length >= 5 && share >= 0.02 ? "alert" : g.turns.length >= 3 || share >= 0.005 ? "warn" : "info";
    const versionsOf = (ts: Turn[]) => [...new Set(ts.map((t) => t.cliVersion ?? "unknown"))].sort(compareVersions);
    const versions = versionsOf(g.turns);
    out.push({
      id: "model-mismatch",
      severity,
      agent: g.agent,
      model: g.served,
      requestedModel: g.req,
      trigger: "event",
      title: `Requested ${g.req} but ${g.served} answered`,
      explanation:
        `${g.turns.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} main-thread API responses (${(share * 100).toFixed(1)}%) for sessions configured to use ${g.req} were served by ${g.served}. ` +
        `If you switched models mid-session or use a mode that routes some turns to another model on purpose, this is expected. Otherwise you got a different model than you chose.`,
      nextStep: `If you did not switch models or turn on a mode that routes some turns to another model, ${REPORT_IT}.`,
      evidence: [
        // The requested side covers every main-thread response for that model; the served side only the mismatched ones.
        { label: "requested", versions: versionsOf(requested), ...span({ turns: requested, tools: [], compactions: [] }), samples: total, sampleUnit: "turns", value: total, display: g.req },
        { label: "served", versions, ...span({ turns: g.turns, tools: [], compactions: [] }), samples: g.turns.length, sampleUnit: "turns", value: share, display: `${g.served} (${(share * 100).toFixed(1)}% of turns)` },
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
      nextStep: `If you did not opt into a preview or set a custom model, gateway or proxy, ${REPORT_IT}.`,
      evidence: [
        { label: "served", versions, ...span({ turns: g.turns, tools: [], compactions: [] }), samples: g.turns.length, sampleUnit: "turns", value: g.turns.length, display: `${g.turns.length} turns` },
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
    nextStep: "Nothing to do unless it happens often.",
    evidence: [
      {
        label: "events",
        versions: [...g.versions].sort(compareVersions),
        from: iso(Math.min(...g.ts)),
        to: iso(Math.max(...g.ts)),
        samples: g.ts.length,
        sampleUnit: "events",
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
