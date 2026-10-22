/**
 * `nerf-watch proof`: did the fix actually help? Compares your own sessions from
 * before and after a fix timestamp, on the same agent and model, and reports
 * startup tokens, tokens per turn, cache hit rate, and an estimate of how many
 * much of each request the startup change removes. Honest when there are too few sessions
 * on either side to say anything yet.
 */
import type { Dataset, Turn } from "./types.js";
import { cacheHitRate, mainTurns, median, modelOf, promptTokens, warmTurns } from "./metrics.js";
import { reducibleTotal, type StartupSample } from "./startup.js";
import { bold, dim, fmtPct, fmtTokens, table } from "./format.js";

const DAY = 86_400_000;

/** Minimum per side before a metric is reported. */
export const PROOF_MIN = { startupSessions: 3, warmTurns: 20, warmSessions: 3 };

export interface ProofMetric {
  before: number | null;
  after: number | null;
  beforeSamples: number;
  afterSamples: number;
  /** Signed change, after - before, when both sides are present. */
  delta: number | null;
}

export interface ProofRow {
  agent: string;
  model: string;
  startup: ProofMetric;
  perTurn: ProofMetric;
  cacheHit: ProofMetric;
  /**
   * Share of a typical warm request's prompt that the startup change removes:
   * (startup before - startup after) / per-turn prompt before. The startup context rides along on every request,
   * so this is the honest per-request saving. Null when either side is missing.
   */
  requestShare: number | null;
  /** Enough data on both sides for at least the startup comparison. */
  ready: boolean;
}

export interface ProofReport {
  fixTimestamp: number;
  fixDate: string;
  rows: ProofRow[];
  /** True when no (agent, model) has enough sessions on both sides. */
  tooFew: boolean;
  /** For the honest message: the largest side counts seen. */
  best: { agent: string; model: string; beforeSessions: number; afterSessions: number } | null;
}

function sessions(turns: Turn[]): number {
  return new Set(turns.map((t) => t.sessionKey)).size;
}

function metric(before: Turn[], after: Turn[], f: (ts: Turn[]) => number | null, min: number): ProofMetric {
  const b = before.length >= min ? f(before) : null;
  const a = after.length >= min ? f(after) : null;
  return { before: b, after: a, beforeSamples: before.length, afterSamples: after.length, delta: b !== null && a !== null ? a - b : null };
}

export function buildProof(ds: Dataset, fixTimestamp: number): ProofReport {
  const groups = new Map<string, Turn[]>();
  for (const t of mainTurns(ds.turns)) {
    const k = `${t.agent}\u0000${modelOf(t)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const rows: ProofRow[] = [];
  let best: ProofReport["best"] = null;
  for (const [k, turns] of groups) {
    const [agent, model] = k.split("\u0000");
    const before = turns.filter((t) => t.timestamp < fixTimestamp);
    const after = turns.filter((t) => t.timestamp >= fixTimestamp);
    const beforeFirst = before.filter((t) => t.firstInSession);
    const afterFirst = after.filter((t) => t.firstInSession);
    const beforeWarm = warmTurns(before);
    const afterWarm = warmTurns(after);

    const startup = metric(beforeFirst, afterFirst, (ts) => median(ts.map(promptTokens)), PROOF_MIN.startupSessions);
    const perTurn = metric(beforeWarm, afterWarm, (ts) => median(ts.map(promptTokens)), PROOF_MIN.warmTurns);
    const cacheHit = metric(beforeWarm, afterWarm, (ts) => cacheHitRate(ts), PROOF_MIN.warmTurns);
    const ready = startup.before !== null && startup.after !== null;
    const requestShare =
      ready && perTurn.before !== null && perTurn.before > 0 ? (startup.before! - startup.after!) / perTurn.before : null;
    rows.push({ agent, model, startup, perTurn, cacheHit, requestShare, ready });

    const bs = sessions(beforeFirst);
    const as = sessions(afterFirst);
    if (!best || bs + as > best.beforeSessions + best.afterSessions) best = { agent, model, beforeSessions: bs, afterSessions: as };
  }
  rows.sort((a, b) => (b.startup.before ?? 0) - (a.startup.before ?? 0));
  return {
    fixTimestamp,
    fixDate: new Date(fixTimestamp).toISOString().slice(0, 10),
    rows,
    tooFew: !rows.some((r) => r.ready),
    best,
  };
}

/** How many more sessions the after side needs before the comparison is ready, for the honest message. */
export function sessionsStillNeeded(report: ProofReport): number {
  if (!report.best) return PROOF_MIN.startupSessions;
  const have = report.best.afterSessions;
  const need = PROOF_MIN.startupSessions;
  return Math.max(0, need - have) || Math.max(0, need - report.best.beforeSessions);
}

// ------------------------------------------ attachment-based startup proof

export interface StartupProofSide {
  sessions: number;
  /** Median reducible attachment tokens (what the fix removes). */
  attachment: number | null;
  /** Median real first-turn usage. */
  firstTurn: number | null;
}

export interface StartupProof {
  before: StartupProofSide;
  after: StartupProofSide;
}

function side(samples: StartupSample[]): StartupProofSide {
  if (!samples.length) return { sessions: 0, attachment: null, firstTurn: null };
  return {
    sessions: samples.length,
    attachment: median(samples.map(reducibleTotal)),
    firstTurn: median(samples.map((s) => s.calibratedTotal)),
  };
}

/** Split startup samples by the fix timestamp and compare the reducible attachment total and real first-turn usage. */
export function buildStartupProof(samples: StartupSample[], fixTimestamp: number): StartupProof {
  return {
    before: side(samples.filter((s) => s.timestamp < fixTimestamp)),
    after: side(samples.filter((s) => s.timestamp >= fixTimestamp)),
  };
}

export function formatStartupProof(p: StartupProof): string | null {
  if (!p.before.sessions && !p.after.sessions) return null;
  const arrow = (b: number | null, a: number | null) => `${b === null ? "?" : fmtTokens(b)} -> ${a === null ? "?" : fmtTokens(a)}`;
  const lines = [
    bold("Startup from attachments, before vs after the fix"),
    "",
    table(
      ["signal", "before -> after", "before/after sessions"],
      [
        ["attachment-based startup (reducible)", arrow(p.before.attachment, p.after.attachment), `${p.before.sessions} / ${p.after.sessions}`],
        ["real first-turn usage (whole startup)", arrow(p.before.firstTurn, p.after.firstTurn), `${p.before.sessions} / ${p.after.sessions}`],
      ],
      ["l", "l", "r"],
    ),
    "",
    dim(
      "attachment-based startup sums the skill/agent/instruction/hook/MCP tokens the fix can remove; real first-turn usage is the whole prompt the API billed on the first turn. Both are medians from your own logs.",
    ),
  ];
  return lines.join("\n");
}

// --------------------------------------------------------------- formatting

function cell(m: ProofMetric, fmt: (n: number) => string): string {
  if (m.before === null && m.after === null) return "-";
  const b = m.before === null ? "?" : fmt(m.before);
  const a = m.after === null ? "?" : fmt(m.after);
  return `${b} -> ${a}`;
}

export function formatProof(report: ProofReport): string {
  const lines: string[] = [bold(`Before vs after the fix on ${report.fixDate}`)];
  lines.push("");
  if (report.tooFew) {
    const need = sessionsStillNeeded(report);
    const have = report.best ? `${report.best.beforeSessions} before and ${report.best.afterSessions} after` : "0";
    lines.push(
      `Not enough sessions on both sides of the fix yet to compare (need at least ${PROOF_MIN.startupSessions} on each side; ` +
        `the best model has ${have}).`,
    );
    lines.push(need > 0 ? `Come back after about ${need} more session${need === 1 ? "" : "s"} since the fix.` : "Come back after a few more sessions since the fix.");
    return lines.join("\n");
  }
  const rows = report.rows
    .filter((r) => r.ready)
    .map((r) => [
      r.agent,
      r.model,
      cell(r.startup, fmtTokens),
      cell(r.perTurn, fmtTokens),
      cell(r.cacheHit, (v) => fmtPct(v)),
      r.requestShare !== null ? `${r.requestShare >= 0 ? "-" : "+"}${(Math.abs(r.requestShare) * 100).toFixed(1)}%` : "-",
    ]);
  lines.push(table(["agent", "model", "startup", "per turn", "cache hit", "saved per request"], rows, ["l", "l", "l", "l", "l", "r"]));
  lines.push("");
  lines.push(
    dim(
      "startup and per turn are median prompt tokens (lower is better); cache hit is the cached share of prompt tokens (higher is better). " +
        "saved per request is the startup change as a share of a typical warm request, since the startup context rides along on every request. " +
          "Most of it is usually served from the prompt cache, which is cheaper than fresh input. Your own logs, before vs after.",
    ),
  );
  const small = report.rows.filter((r) => r.ready && r.startup.before !== null && r.startup.after !== null && Math.abs(r.startup.after - r.startup.before) / Math.max(1, r.startup.before) < 0.05);
  if (small.length === report.rows.filter((r) => r.ready).length) lines.push("", "The change in startup overhead is small so far. Keep using the agent and run proof again later.");
  return lines.join("\n");
}
