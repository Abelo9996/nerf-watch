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

export const MIN = {
  turns: 50,
  sessions: 5,
  toolCalls: 100,
  compactions: 2,
};

export function sessionCount(xs: { sessionKey: string }[]): number {
  return new Set(xs.map((x) => x.sessionKey)).size;
}

/** Turns after the first of each session. The first turn always pays a cold cache. */
export function warmTurns(turns: Turn[]): Turn[] {
  return turns.filter((t) => !t.firstInSession);
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
  /** Returns null when the cohort is too small for a stable value. */
  compute(c: Cohort): { value: number; samples: number } | null;
  format(v: number): string;
}

const fmtTokens = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v).toLocaleString("en-US")}`);
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const METRICS: Record<string, MetricDef> = {
  newInput: {
    id: "newInput",
    label: "uncached input tokens per turn (median of session medians)",
    compute(c) {
      c = { ...c, turns: warmTurns(c.turns) };
      if (c.turns.length < MIN.turns || sessionCount(c.turns) < MIN.sessions) return null;
      return { value: sessionMedian(c.turns, (t) => t.usage.input + t.usage.cacheCreation), samples: c.turns.length };
    },
    format: fmtTokens,
  },
  cacheCreation: {
    id: "cacheCreation",
    label: "cache-creation tokens per turn (median of session medians)",
    compute(c) {
      c = { ...c, turns: warmTurns(c.turns) };
      if (c.turns.length < MIN.turns || sessionCount(c.turns) < MIN.sessions) return null;
      if (!c.turns.some((t) => t.usage.cacheCreation > 0)) return null;
      return { value: sessionMedian(c.turns, (t) => t.usage.cacheCreation), samples: c.turns.length };
    },
    format: fmtTokens,
  },
  firstTurnPrompt: {
    id: "firstTurnPrompt",
    label: "prompt tokens on the first turn of a session (median)",
    compute(c) {
      const f = c.turns.filter((t) => t.firstInSession);
      if (f.length < MIN.sessions) return null;
      return { value: median(f.map(promptTokens)), samples: f.length };
    },
    format: fmtTokens,
  },
  cacheHitRate: {
    id: "cacheHitRate",
    label: "cache hit rate (cached prompt tokens / all prompt tokens)",
    compute(c) {
      c = { ...c, turns: warmTurns(c.turns) };
      if (c.turns.length < MIN.turns || sessionCount(c.turns) < MIN.sessions) return null;
      const v = cacheHitRate(c.turns);
      return v === null ? null : { value: v, samples: c.turns.length };
    },
    format: fmtPct,
  },
  toolErrorRate: {
    id: "toolErrorRate",
    label: "tool call error rate",
    compute(c) {
      if (c.tools.length < MIN.toolCalls || sessionCount(c.tools) < MIN.sessions) return null;
      return { value: c.tools.filter((t) => t.isError).length / c.tools.length, samples: c.tools.length };
    },
    format: fmtPct,
  },
  contextWindow: {
    id: "contextWindow",
    label: "context window (reported, or prompt size at auto-compaction)",
    compute(c) {
      const reported = c.turns.map((t) => t.contextWindow ?? 0).filter((x) => x > 0);
      // Reported windows are discrete settings, so use the most common value
      // (ties go to the larger window, which avoids reporting a shrink on a tie).
      if (reported.length >= 1) return { value: mode(reported), samples: reported.length };
      const auto = c.compactions.filter((e) => e.auto).map((e) => e.preTokens);
      if (auto.length < MIN.compactions) return null;
      return { value: median(auto), samples: auto.length };
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
      sessions: new Set(c.turns.map((t) => t.sessionKey)).size,
      firstSeen: Math.min(...ts),
      lastSeen: Math.max(...ts),
      medianPromptTokens: median(c.turns.map(promptTokens)),
      medianNewInputTokens: median(c.turns.map((t) => t.usage.input + t.usage.cacheCreation)),
      medianCacheCreationTokens: median(c.turns.map((t) => t.usage.cacheCreation)),
      medianOutputTokens: median(c.turns.map((t) => t.usage.output)),
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
