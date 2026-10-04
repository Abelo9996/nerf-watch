import { MIN } from "./metrics.js";
import type { Dataset, Finding, Segment, Severity } from "./types.js";

const useColor = () => !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code: number, s: string) => (useColor() ? `\u001b[${code}m${s}\u001b[0m` : s);
export const red = (s: string) => paint(31, s);
export const yellow = (s: string) => paint(33, s);
export const dim = (s: string) => paint(2, s);
export const bold = (s: string) => paint(1, s);

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return fmtInt(n);
}

export function fmtPct(v: number | null): string {
  return v === null ? "-" : `${(v * 100).toFixed(1)}%`;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function table(headers: string[], rows: string[][], align?: ("l" | "r")[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (s: string, i: number) => ((align?.[i] ?? "l") === "r" ? s.padStart(widths[i]) : s.padEnd(widths[i]));
  const line = (r: string[]) => r.map(pad).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function segmentRows(segs: Segment[]): string[][] {
  return segs.map((s) => [
    s.agent,
    s.cliVersion,
    s.model,
    fmtInt(s.turns),
    s.subagentTurns ? fmtPct(s.subagentTurns / s.turns) : "-",
    fmtInt(s.sessions),
    `${isoDate(s.firstSeen)}..${isoDate(s.lastSeen).slice(5)}`,
    fmtTokens(s.medianPromptTokens),
    fmtTokens(s.medianNewInputTokens),
    fmtTokens(s.medianOutputTokens),
    fmtPct(s.cacheHitRate),
    s.toolCalls ? `${fmtPct(s.toolErrorRate)} of ${fmtInt(s.toolCalls)}` : "-",
    s.effort ?? "-",
    s.contextWindow ? fmtTokens(s.contextWindow) : "-",
  ]);
}

export const SEGMENT_HEADERS = [
  "agent",
  "cli",
  "model",
  "turns",
  "subagent",
  "sessions",
  "seen",
  "prompt/turn",
  "uncached/turn",
  "output/turn",
  "cache hit",
  "tool errors",
  "effort",
  "context",
];
export const SEGMENT_ALIGN: ("l" | "r")[] = ["l", "l", "l", "r", "r", "r", "l", "r", "r", "r", "r", "r", "l", "r"];

export function datasetSummary(ds: Dataset): string {
  const agents = Object.keys(ds.files).filter((a) => ds.files[a] > 0);
  const parts = agents.map((a) => {
    const turns = ds.turns.filter((t) => t.agent === a).length;
    return `${a}: ${fmtInt(ds.files[a])} session files, ${fmtInt(turns)} turns`;
  });
  if (!parts.length) return "no session logs found";
  let range = "";
  if (ds.turns.length) range = `, ${isoDate(ds.turns[0].timestamp)} to ${isoDate(ds.turns[ds.turns.length - 1].timestamp)}`;
  return parts.join("; ") + range;
}

const LABEL: Record<Severity, string> = { alert: "ALERT", warn: "WARN ", info: "INFO " };

export function severityLabel(s: Severity): string {
  const l = LABEL[s];
  return s === "alert" ? red(bold(l)) : s === "warn" ? yellow(l) : dim(l);
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.map((l) => indent + l).join("\n");
}

export function formatFinding(f: Finding): string {
  const head = `${severityLabel(f.severity)}  ${f.agent}  ${f.model ?? ""}  ${bold(f.title)}`;
  const w = Math.max(16, ...f.evidence.map((e) => e.display.length)) + 2;
  const cols = f.evidence.map((e) => {
    const v = e.versions?.length ? (e.versions.length > 2 ? `${e.versions[0]} to ${e.versions[e.versions.length - 1]}` : e.versions.join(", ")) : "";
    return {
      cli: v ? `cli ${v}` : "",
      when: e.from ? (e.from === e.to ? e.from : `${e.from} to ${e.to}`) : "",
      n: countWithUnit(e.samples, e.sampleUnit ?? "samples"),
    };
  });
  const cw = Math.max(0, ...cols.map((c) => c.cli.length));
  const ww = Math.max(0, ...cols.map((c) => c.when.length));
  const ev = f.evidence.map((e, i) => {
    const c = cols[i];
    const meta = [cw ? c.cli.padEnd(cw) : "", ww ? c.when.padEnd(ww) : "", c.n].filter(Boolean).join("   ");
    return `       ${e.label.padEnd(9)} ${e.display.padEnd(w)} ${dim(meta)}`;
  });
  const lines = [head, ...ev, wrap(f.explanation, 92, "       ")];
  if (f.nextStep) lines.push(wrap(`Next: ${f.nextStep}`, 92, "       "));
  return lines.join("\n");
}

/** "1 turn", "1,280 turns", "1 tool call". */
export function countWithUnit(n: number, unit: string): string {
  return `${fmtInt(n)} ${Math.round(n) === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}`;
}

/** "2 alerts and 3 warnings", "1 warning", "no changes". */
function countPhrase(c: Record<Severity, number>): string {
  const parts: string[] = [];
  if (c.alert) parts.push(`${c.alert} alert${c.alert === 1 ? "" : "s"}`);
  if (c.warn) parts.push(`${c.warn} warning${c.warn === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

/**
 * The plain-English lines printed above the findings: what was read, and the
 * verdict in one sentence.
 */
export function checkHeadline(ds: Dataset, findings: Finding[]): string[] {
  const agents = Object.keys(ds.files).filter((a) => ds.files[a] > 0);
  // Files that contributed at least one response (the --since filter goes by file time, which can keep extra files).
  const files = new Set(ds.turns.map((t) => t.sessionKey)).size;
  const per = agents.map((a) => `${a} ${fmtInt(ds.turns.filter((t) => t.agent === a).length)}`).join(", ");
  const range = ds.turns.length ? `, ${isoDate(ds.turns[0].timestamp)} to ${isoDate(ds.turns[ds.turns.length - 1].timestamp)}` : "";
  const read = `Read ${fmtInt(ds.turns.length)} model responses from ${fmtInt(files)} session files (${per})${range}.`;
  const c = countBySeverity(findings);
  let verdict: string;
  if (c.alert || c.warn) {
    verdict =
      `Result: ${countPhrase(c)}. ` +
      (c.alert ? "Alerts are large or clear-cut changes; warnings are smaller ones worth a look." : "A warning is worth a look, not proof of a regression.");
  } else {
    const notes = c.info ? ` ${c.info} note${c.info === 1 ? "" : "s"} below for context.` : "";
    verdict = tooLittleHistory(ds)
      ? "Result: nothing to report, but there is not much history to compare yet. A comparison needs at least 5 sessions and " +
        "50 turns on the same model on each side (before and after a CLI update, or older and recent). Run it again after more sessions." +
        notes
      : `Result: no changes crossed a threshold.${notes || " Nothing to do."}`;
  }
  return [read, verdict];
}

/**
 * True when no (agent, model) has enough main-thread history for even one
 * comparison: at least twice the per-side minimum of turns and sessions.
 */
export function tooLittleHistory(ds: Dataset): boolean {
  const groups = new Map<string, { turns: number; sessions: Set<string> }>();
  for (const t of ds.turns) {
    if (t.sidechain || t.firstInSession) continue;
    const k = `${t.agent}\u0000${t.servedModel ?? t.requestedModel ?? ""}`;
    const g = groups.get(k) ?? { turns: 0, sessions: new Set<string>() };
    g.turns++;
    g.sessions.add(t.sessionKey);
    groups.set(k, g);
  }
  return ![...groups.values()].some((g) => g.turns >= 2 * MIN.turns && g.sessions.size >= 2 * MIN.sessions);
}

export function countBySeverity(fs: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { alert: 0, warn: 0, info: 0 };
  for (const f of fs) c[f.severity]++;
  return c;
}
