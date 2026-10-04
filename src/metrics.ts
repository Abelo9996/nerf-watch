import type { AgentEvent, Dataset, Segment, ToolResult, Turn } from "./types.js";

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mode(xs: number[]): number {
  const c = new Map<number, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  let best = 0;
  let bestN = -1;
  for (const [v, n] of c) if (n > bestN || (n === bestN && v > best)) [best, bestN] = [v, n];
  return best;
}

export function promptTokens(t: Turn): number {
  return t.usage.input + t.usage.cacheRead + t.usage.cacheCreation;
}

export function normalizeModel(m: string): string {
  return m
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "") // Claude Code context suffix, e.g. "[1m]"
    .replace(/-\d{8}$/, "") // dated snapshot suffix
    .trim();
}

export function modelOf(t: Turn): string {
  return t.servedModel ?? t.requestedModel ?? "unknown";
}

export function cacheHitRate(turns: Turn[]): number | null {
  let read = 0;
  let all = 0;
  for (const t of turns) {
    read += t.usage.cacheRead;
    all += promptTokens(t);
  }
  return all === 0 ? null : read / all;
}

export const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** A bag of records that metrics are computed over. */
export interface Cohort {
  turns: Turn[];
  tools: ToolResult[];
  compactions: Extract<AgentEvent, { kind: "compaction" }>[];
}

export interface Minimums {
  /** Main-thread warm turns. */
  turns: number;
  sessions: number;
  /** Sessions with a first turn, for the startup prompt metric. */
  firstTurns: number;
  toolCalls: number;
  compactions: number;
  /** Turns that report a context window. */
  contextReports: number;
  /** Sessions those reports come from. */
  contextSessions: number;
}

/** Minimum data for a pooled before/after value. */
export const MIN: Minimums = {
  turns: 50,
  sessions: 5,
  firstTurns: 5,
  toolCalls: 100,
  compactions: 2,
  contextReports: 20,
  // A window is a per-session setting, and one session can be resumed with a
  // different config, so a change seen in one or two sessions is not evidence.
  contextSessions: 3,
};

/** Minimum data for one workload's value inside a stratified comparison. */
export const MIN_STRATUM: Minimums = {
  turns: 20,
  sessions: 1,
  // The startup prompt is nearly fixed for a given project and CLI version, so one session is informative.
  firstTurns: 1,
  toolCalls: 30,
  compactions: 2,
  contextReports: 20,
  contextSessions: 1,
};

export function sessionCount(xs: { sessionKey: string }[]): number {
  return new Set(xs.map((x) => x.sessionKey)).size;
}

/** Turns after the first of each session. The first turn always pays a cold cache. */
export function warmTurns(turns: Turn[]): Turn[] {
  return turns.filter((t) => !t.firstInSession);
}

/**
 * Main-thread turns. Subagent turns are left out of token metrics: their size
 * depends on which subagent ran and what it read, so a different mix of
 * subagents looks like a change in the agent when it is a change in the work.
 */
export function mainTurns(turns: Turn[]): Turn[] {
  return turns.filter((t) => !t.sidechain);
}

/**
 * Median of per-session medians. One long or unusual session cannot drag the
 * value, which matters because per-turn token counts are heavy tailed.
 */
export function sessionMedian(turns: Turn[], f: (t: Turn) => number): number {
  const by = new Map<string, number[]>();
  for (const t of turns) {
    const a = by.get(t.sessionKey);
    if (a) a.push(f(t));
    else by.set(t.sessionKey, [f(t)]);
  }
  return median([...by.values()].map(median));
}

export interface MetricDef {
  id: string;
  label: string;
  /** What the sample count counts, for display ("turns", "sessions", "tool calls"). */
  sampleUnit: string;
  /** Returns null when the cohort is too small for a stable value. `unit` overrides `sampleUnit`. */
  compute(c: Cohort, min?: Minimums): { value: number; samples: number; unit?: string } | null;
  /** The value with its unit, for example "3,037 tokens" or "80.2%". */
  format(v: number): string;
}

const fmtTokens = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v).toLocaleString("en-US")}`) + " tokens";
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const METRICS: Record<string, MetricDef> = {
  newInput: {
    id: "newInput",
    sampleUnit: "turns",
    label: "uncached input tokens per turn (median of session medians)",
    compute(c, min = MIN) {
      c = { ...c, turns: warmTurns(mainTurns(c.turns)) };
      if (c.turns.length < min.turns || sessionCount(c.turns) < min.sessions) return null;
      return { value: sessionMedian(c.turns, (t) => t.usage.input + t.usage.cacheCreation), samples: c.turns.length };
    },
    format: fmtTokens,
  },
  cacheCreation: {
    id: "cacheCreation",
    sampleUnit: "turns",
    label: "cache-creation tokens per turn (median of session medians)",
    compute(c, min = MIN) {
      c = { ...c, turns: warmTurns(mainTurns(c.turns)) };
      if (c.turns.length < min.turns || sessionCount(c.turns) < min.sessions) return null;
      if (!c.turns.some((t) => t.usage.cacheCreation > 0)) return null;
      return { value: sessionMedian(c.turns, (t) => t.usage.cacheCreation), samples: c.turns.length };
    },
    format: fmtTokens,
  },
  firstTurnPrompt: {
    id: "firstTurnPrompt",
    sampleUnit: "sessions",
    label: "prompt tokens on the first turn of a session (median)",
    compute(c, min = MIN) {
      const f = c.turns.filter((t) => t.firstInSession && !t.sidechain);
      if (f.length < min.firstTurns) return null;
      return { value: median(f.map(promptTokens)), samples: f.length };
    },
    format: fmtTokens,
  },
  cacheHitRate: {
    id: "cacheHitRate",
    sampleUnit: "turns",
    label: "cache hit rate (cached prompt tokens / all prompt tokens)",
    compute(c, min = MIN) {
      c = { ...c, turns: warmTurns(mainTurns(c.turns)) };
      if (c.turns.length < min.turns || sessionCount(c.turns) < min.sessions) return null;
      const v = cacheHitRate(c.turns);
      return v === null ? null : { value: v, samples: c.turns.length };
    },
    format: fmtPct,
  },
  toolErrorRate: {
    id: "toolErrorRate",
    sampleUnit: "tool calls",
    label: "tool call error rate",
    compute(c, min = MIN) {
      if (c.tools.length < min.toolCalls || sessionCount(c.tools) < min.sessions) return null;
      return { value: c.tools.filter((t) => t.isError).length / c.tools.length, samples: c.tools.length };
    },
    format: fmtPct,
  },
  contextWindow: {
    id: "contextWindow",
    sampleUnit: "turns",
    label: "context window (reported, or prompt size at auto-compaction)",
    compute(c, min = MIN) {
      const reportedTurns = c.turns.filter((t) => (t.contextWindow ?? 0) > 0);
      // Reported windows are discrete settings, so use the most common value:
      // first per session, then across sessions, so one long session cannot
      // outvote the others (ties go to the larger window, which avoids
      // reporting a shrink on a tie).
      if (reportedTurns.length) {
        const bySession = new Map<string, number[]>();
        for (const t of reportedTurns) {
          const a = bySession.get(t.sessionKey);
          if (a) a.push(t.contextWindow!);
          else bySession.set(t.sessionKey, [t.contextWindow!]);
        }
        if (reportedTurns.length < min.contextReports || bySession.size < min.contextSessions) return null;
        return { value: mode([...bySession.values()].map(mode)), samples: reportedTurns.length };
      }
      const auto = c.compactions.filter((e) => e.auto).map((e) => e.preTokens);
      if (auto.length < min.compactions) return null;
      return { value: median(auto), samples: auto.length, unit: "compactions" };
    },
    format: fmtTokens,
  },
};

export function modalEffort(turns: Turn[]): { effort: string; share: number; samples: number } | null {
  const counts = new Map<string, number>();
  let n = 0;
  for (const t of turns) {
    if (!t.effort) continue;
    counts.set(t.effort, (counts.get(t.effort) ?? 0) + 1);
    n++;
  }
  if (!n) return null;
  let best = "";
  let bestN = -1;
  for (const [k, v] of counts) if (v > bestN) [best, bestN] = [k, v];
  return { effort: best, share: bestN / n, samples: n };
}

/**
 * The effort each session started with, before the user changed it. Only
 * main-thread turns count; subagents inherit the parent's setting and would
 * let one long session outvote every other session.
 */
export function defaultEffortBySession(turns: Turn[]): { sessionKey: string; workloadKey?: string; effort: string }[] {
  const out = new Map<string, { sessionKey: string; workloadKey?: string; effort: string }>();
  for (const t of turns) {
    if (t.sidechain || !t.effort || t.effortSetByUser || out.has(t.sessionKey)) continue;
    out.set(t.sessionKey, { sessionKey: t.sessionKey, workloadKey: t.workloadKey, effort: t.effort });
  }
  return [...out.values()];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return 1; // "1.2.0" > "1.2.0-alpha"
    if (y === undefined) return -1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Group key helpers. */
export const segKey = (agent: string, version: string, model: string) => `${agent}\u0000${version}\u0000${model}`;

/** Partition the dataset into cohorts keyed by (agent, cli_version, model). */
export function cohortsByVersion(ds: Dataset): Map<string, Cohort & { agent: string; version: string; model: string }> {
  const map = new Map<string, Cohort & { agent: string; version: string; model: string }>();
  const get = (agent: string, version: string, model: string) => {
    const k = segKey(agent, version, model);
    let c = map.get(k);
    if (!c) {
      c = { agent, version, model, turns: [], tools: [], compactions: [] };
      map.set(k, c);
    }
    return c;
  };
  for (const t of ds.turns) get(t.agent, t.cliVersion ?? "unknown", modelOf(t)).turns.push(t);
  for (const r of ds.toolResults) {
    if (!r.model) continue;
    get(r.agent, r.cliVersion ?? "unknown", r.model).tools.push(r);
  }
  for (const e of ds.events) {
    if (e.kind === "compaction" && e.model) get(e.agent, e.cliVersion ?? "unknown", e.model).compactions.push(e);
  }
  // Drop cohorts that only exist because of tool results or events.
  for (const [k, c] of map) if (!c.turns.length) map.delete(k);
  return map;
}

export function buildSegments(ds: Dataset): Segment[] {
  const out: Segment[] = [];
  for (const c of cohortsByVersion(ds).values()) {
    const ts = c.turns.map((t) => t.timestamp);
    const firsts = c.turns.filter((t) => t.firstInSession).map(promptTokens);
    const errs = c.tools.filter((t) => t.isError).length;
    const ctx = METRICS.contextWindow.compute(c);
    out.push({
      agent: c.agent,
      cliVersion: c.version,
      model: c.model,
      turns: c.turns.length,
      subagentTurns: c.turns.filter((t) => t.sidechain).length,
      sessions: new Set(c.turns.map((t) => t.sessionKey)).size,
      firstSeen: Math.min(...ts),
      lastSeen: Math.max(...ts),
      medianPromptTokens: median(c.turns.map(promptTokens)),
      medianNewInputTokens: median(c.turns.map((t) => t.usage.input + t.usage.cacheCreation)),
      medianCacheCreationTokens: median(c.turns.map((t) => t.usage.cacheCreation)),
      medianOutputTokens: median((c.turns.some((t) => !t.partial) ? c.turns.filter((t) => !t.partial) : c.turns).map((t) => t.usage.output)),
      medianFirstTurnPromptTokens: firsts.length ? median(firsts) : null,
      cacheHitRate: cacheHitRate(c.turns),
      toolCalls: c.tools.length,
      toolErrors: errs,
      toolErrorRate: c.tools.length ? errs / c.tools.length : null,
      effort: modalEffort(c.turns)?.effort ?? null,
      contextWindow: ctx ? ctx.value : null,
    });
  }
  return out.sort(
    (a, b) => a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model) || compareVersions(a.cliVersion, b.cliVersion),
  );
}
