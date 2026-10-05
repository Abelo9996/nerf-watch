/**
 * `nerf-watch card`: a 1200x630 SVG image of the user's own result, sized for
 * X, Bluesky and link previews, to post or attach to a GitHub issue.
 *
 * The card is drawn only from the anonymized share payload (see share.ts),
 * after the same privacy scan `share` runs. Every string on it is either fixed
 * text from this file or a value the payload already allows: agent ids, CLI
 * versions, model ids, dates and numbers. No paths, project names, user names
 * or session ids can reach it.
 *
 * No dependencies: plain SVG with the system font stack. Colors follow the
 * open-agent-lab site; light values are presentation attributes, so renderers
 * that ignore CSS still draw the light card, and a prefers-color-scheme media
 * query switches to the dark palette where CSS is supported.
 */
import { EFFORT_RANK } from "./metrics.js";
import type { ShareFinding, SharePayload } from "./share.js";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const CARD_REPO = "github.com/Abelo9996/nerf-watch";
export const CARD_COMMAND = "npx nerf-watch check";
export const MAX_CARD_FINDINGS = 3;

const AGENT_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
const agentName = (id: string) => AGENT_NAME[id] ?? id;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

/** What `check` compares, in the words the card uses for the all-clear case. */
export const CHECKED_SIGNALS = [
  "token use",
  "cache writes",
  "cache hit rate",
  "tool errors",
  "context window",
  "reasoning effort",
  "model served",
];

export interface CardOptions {
  /** The --since value as typed. Only a span such as 30d or a YYYY-MM-DD date is shown. */
  since?: string;
  /** Warning and alert findings `check` reported, including any the payload could not carry. */
  totalFindings?: number;
  /** Sessions with at least one response in the window. Defaults to the payload's session file count. */
  sessions?: number;
}

export interface CardRow {
  severity: "warn" | "alert";
  title: string;
  before: string | null;
  after: string;
  unit: string;
  detail: string;
}

export interface CardModel {
  kind: "clear" | "findings";
  headline: string;
  rows: CardRow[];
  /** Findings not shown on the card. */
  more: number;
  responses: number;
  sessions: number;
  /** Days from the first to the last response, inclusive. */
  days: number | null;
  agents: string[];
  range: string | null;
  version: string;
}

// ------------------------------------------------------------------ numbers

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1))}M`;
  if (n >= 10_000) return `${trim((n / 1000).toFixed(n >= 100_000 ? 0 : 1))}k`;
  return fmtInt(n);
}

function fmtPct(v: number): string {
  const p = v * 100;
  return `${trim(p.toFixed(p < 10 ? 1 : 0))}%`;
}

const trim = (s: string) => s.replace(/\.0$/, "");

function fmtRatio(r: number): string {
  return `${trim(r.toFixed(r < 10 ? 1 : 0))}x`;
}

const EFFORT_NAME = Object.fromEntries(Object.entries(EFFORT_RANK).map(([k, v]) => [v, k])) as Record<number, string>;
const effortName = (v: number) => EFFORT_NAME[Math.round(v)] ?? "unknown";

// ------------------------------------------------------------------ wording

interface Metric {
  name: string;
  kind: "tokens" | "rate" | "window";
  unit: string;
}

const METRIC: Record<string, Metric> = {
  newInput: { name: "Uncached input per turn", kind: "tokens", unit: "tokens" },
  cacheCreation: { name: "Cache writes per turn", kind: "tokens", unit: "tokens" },
  firstTurnPrompt: { name: "Startup prompt", kind: "tokens", unit: "tokens" },
  cacheHitRate: { name: "Cache hit rate", kind: "rate", unit: "" },
  toolErrorRate: { name: "Tool error rate", kind: "rate", unit: "" },
  contextWindow: { name: "Context window", kind: "window", unit: "tokens" },
};

interface Described {
  /** Short row title. */
  title: string;
  /** Fuller phrase for the headline. */
  phrase: string;
  before: string | null;
  after: string;
  unit: string;
}

function describe(f: ShareFinding): Described {
  const b = f.before?.value ?? null;
  const a = f.after.value;
  if (f.detector === "effort-drop") {
    const from = b === null ? null : effortName(b);
    const to = effortName(a);
    return {
      title: "Reasoning effort dropped",
      phrase: from ? `Reasoning effort dropped from ${from} to ${to}` : `Reasoning effort dropped to ${to}`,
      before: from,
      after: to,
      unit: "most common setting",
    };
  }
  if (f.detector === "model-mismatch") {
    return {
      title: "A different model answered",
      phrase: `A different model answered ${fmtPct(a)} of turns`,
      before: null,
      after: fmtPct(a),
      unit: "of turns",
    };
  }
  if (f.detector === "hidden-model") {
    return {
      title: "An unrecognized model answered",
      phrase: `An unrecognized model answered ${fmtInt(a)} turn${Math.round(a) === 1 ? "" : "s"}`,
      before: null,
      after: fmtInt(a),
      unit: Math.round(a) === 1 ? "turn" : "turns",
    };
  }
  const m = METRIC[f.detector.slice(0, f.detector.lastIndexOf("-"))];
  if (!m) {
    return { title: "Change detected", phrase: "A change was detected", before: b === null ? null : fmtInt(b), after: fmtInt(a), unit: "" };
  }
  if (m.kind === "tokens") {
    const up = b !== null && b > 0 ? `up ${fmtRatio(a / b)}` : "up";
    return { title: `${m.name} ${up}`, phrase: `${m.name} ${up}`, before: b === null ? null : fmtTokens(b), after: fmtTokens(a), unit: m.unit };
  }
  const fmt = m.kind === "rate" ? fmtPct : fmtTokens;
  const dir = b !== null && a > b ? "up" : "down";
  const verb = m.kind === "window" ? "shrank" : dir;
  return {
    title: `${m.name} ${verb}`,
    phrase: b === null ? `${m.name} ${verb} to ${fmt(a)}` : `${m.name} ${verb} from ${fmt(b)} to ${fmt(a)}`,
    before: b === null ? null : fmt(b),
    after: fmt(a),
    unit: m.unit,
  };
}

/** "after Claude Code 2.1.272", "on Codex 0.141.0 with no CLI update". */
function where(f: ShareFinding): string {
  const agent = agentName(f.agent);
  if (f.trigger === "version") return `after ${agent} ${f.cliAfter}`;
  if (f.trigger === "time") return `on ${agent} ${f.cliAfter} with no CLI update`;
  return `on ${agent} ${f.cliAfter}`;
}

function detail(f: ShareFinding): string {
  const agent = agentName(f.agent);
  const parts: string[] = [];
  if (f.trigger === "version" && f.cliBefore) parts.push(`${agent} ${f.cliBefore} to ${f.cliAfter}`);
  else if (f.trigger === "time") parts.push(`${agent} ${f.cliAfter}, no CLI update`);
  else parts.push(`${agent} ${f.cliAfter}`);
  if (f.detector === "model-mismatch" && f.servedModel) parts.push(`asked ${f.model}, got ${f.servedModel}`);
  else if (f.model && f.model !== "unknown") parts.push(f.model);
  return parts.join(" · ");
}

/** "over the last 30 days", "since 2026-09-01", or the span of the data. */
export function timePhrase(p: SharePayload, since?: string): string {
  const s = (since ?? "").trim();
  const rel = /^(\d+)\s*([hdw])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { h: "hour", d: "day", w: "week" }[rel[2].toLowerCase() as "h" | "d" | "w"];
    return n === 1 ? `over the last ${unit}` : `over the last ${n} ${unit}s`;
  }
  if (DATE_RE.test(s)) return `since ${s}`;
  const days = spanDays(p);
  return days ? `over ${days} day${days === 1 ? "" : "s"} of sessions` : "";
}

function spanDays(p: SharePayload): number | null {
  const { from, to } = p.window;
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) return null;
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
}

function joinNames(names: string[], word: "or" | "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${word} ${names[names.length - 1]}`;
}

export function cardModel(p: SharePayload, o: CardOptions = {}): CardModel {
  const agents = p.agents.filter((a) => a.sessions > 0).map((a) => agentName(a.id));
  const base = {
    responses: p.agents.reduce((s, a) => s + a.turns, 0),
    sessions: o.sessions ?? p.agents.reduce((s, a) => s + a.sessions, 0),
    days: spanDays(p),
    agents,
    range: p.window.from && p.window.to ? (p.window.from === p.window.to ? p.window.from : `${p.window.from} to ${p.window.to}`) : null,
    version: p.nerfWatchVersion,
  };
  if (!p.findings.length) {
    const scope = agents.length ? ` in ${joinNames(agents, "or")}` : "";
    return { kind: "clear", headline: `No silent changes${scope} ${timePhrase(p, o.since)}`.trim(), rows: [], more: 0, ...base };
  }
  // Alerts first, then changes with a clear before and after (a CLI update), then the rest.
  const order = { version: 0, time: 1, event: 2 } as const;
  const sorted = p.findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.severity === b.f.severity ? 0 : a.f.severity === "alert" ? -1 : 1) || order[a.f.trigger] - order[b.f.trigger] || a.i - b.i)
    .map((x) => x.f);
  const shown = sorted.slice(0, MAX_CARD_FINDINGS);
  const rows: CardRow[] = shown.map((f) => {
    const d = describe(f);
    return { severity: f.severity, title: d.title, before: d.before, after: d.after, unit: d.unit, detail: detail(f) };
  });
  const top = shown[0];
  const total = Math.max(o.totalFindings ?? 0, p.findings.length);
  return { kind: "findings", headline: `${describe(top).phrase} ${where(top)}`, rows, more: total - shown.length, ...base };
}

// ------------------------------------------------------------------ text measurement

/**
 * Advance widths of Helvetica/Arial in 1/1000 em. System UI fonts (SF Pro,
 * Segoe UI, Roboto) are close; the safety factor below keeps estimates on the
 * wide side so text wraps early rather than running off the card.
 */
const W: Record<string, number> = {};
const setW = (chars: string, w: number) => {
  for (const c of chars) W[c] = w;
};
setW("0123456789abdeghnopqu$#?_", 556);
setW("ckszvxy", 500);
setW("fjt/!.,:;[] '|", 278);
setW("il", 222);
setW("r()-", 333);
setW("mM", 833);
setW("w", 722);
setW("ABEKPSVXY", 667);
setW("CDHNRUw", 722);
setW("GOQ", 778);
setW("FTZ", 611);
setW("L", 556);
setW("J", 500);
setW("I", 278);
setW("W", 944);
setW("%", 889);
setW("·", 333);

export function textWidth(s: string, size: number, weight: "regular" | "bold" = "regular"): number {
  let units = 0;
  for (const c of s) units += W[c] ?? 600;
  return (units / 1000) * size * (weight === "bold" ? 1.1 : 1.05) * 1.04;
}

/** Monospace advance: 0.6 em covers SF Mono, Menlo and DejaVu; Consolas is narrower. */
export function monoWidth(s: string, size: number): number {
  return [...s].length * size * 0.602;
}

function fitMono(s: string, size: number, max: number): string {
  if (monoWidth(s, size) <= max) return s;
  const chars = [...s];
  const keep = Math.max(1, Math.floor(max / (size * 0.602)) - 1);
  return chars.slice(0, keep).join("").trimEnd() + "…";
}

function fitText(s: string, size: number, max: number, weight: "regular" | "bold"): string {
  if (textWidth(s, size, weight) <= max) return s;
  let out = s;
  while (out.length > 1 && textWidth(out + "…", size, weight) > max) out = out.slice(0, -1);
  return out.trimEnd() + "…";
}

/** Greedy word wrap by estimated width. */
export function wrapText(s: string, size: number, max: number, weight: "regular" | "bold"): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, size, weight) > max) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Largest size at which the headline fits in two lines; truncates as a last resort. */
function fitHeadline(s: string, max: number): { size: number; lines: string[] } {
  for (const size of [56, 50, 44, 40]) {
    const lines = wrapText(s, size, max, "bold");
    if (lines.length <= 2) return { size, lines };
  }
  const lines = wrapText(s, 40, max, "bold");
  return { size: 40, lines: [lines[0], fitText(lines.slice(1).join(" "), 40, max, "bold")] };
}

// ------------------------------------------------------------------ SVG

const LIGHT = {
  bg: "#f2f5f3",
  surface: "#fcfdfc",
  ink: "#0f1614",
  ink2: "#39443f",
  muted: "#5a6661",
  rule: "#cdd6d1",
  axis: "#b5c0bb",
  accent: "#0a6650",
  signal: "#d4ef3f",
  signalInk: "#182000",
  alert: "#c62f2f",
  alertInk: "#ffffff",
  pass: "#d6ecd8",
  passInk: "#0b5e0b",
} as const;

const DARK: Record<keyof typeof LIGHT, string> = {
  bg: "#0c1110",
  surface: "#151b1a",
  ink: "#e7eeeb",
  ink2: "#b7c3be",
  muted: "#91a09a",
  rule: "#2c3734",
  axis: "#3d4a46",
  accent: "#5fd0ad",
  signal: "#cdea45",
  signalInk: "#182000",
  alert: "#d03b3b",
  alertInk: "#ffffff",
  pass: "#173a1d",
  passInk: "#7fdc7f",
};

type Token = keyof typeof LIGHT;

const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** fill="..." plus the class that switches it in dark mode. */
const fill = (t: Token) => `class="f-${t}" fill="${LIGHT[t]}"`;
const stroke = (t: Token) => `class="s-${t}" stroke="${LIGHT[t]}"`;

function style(): string {
  const rules = (Object.keys(DARK) as Token[]).flatMap((t) => [`.f-${t}{fill:${DARK[t]}}`, `.s-${t}{stroke:${DARK[t]}}`]);
  return `<style>@media (prefers-color-scheme: dark){${rules.join("")}}</style>`;
}

interface TextOpts {
  x: number;
  y: number;
  size: number;
  color: Token;
  weight?: number;
  mono?: boolean;
  anchor?: "start" | "middle" | "end";
  spacing?: number;
}

function text(s: string, o: TextOpts): string {
  const attrs = [
    `x="${o.x}"`,
    `y="${o.y}"`,
    `font-size="${o.size}"`,
    o.weight ? `font-weight="${o.weight}"` : "",
    o.mono ? `font-family="${MONO}"` : "",
    o.anchor && o.anchor !== "start" ? `text-anchor="${o.anchor}"` : "",
    o.spacing ? `letter-spacing="${o.spacing}"` : "",
    fill(o.color),
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${escapeXml(s)}</text>`;
}

const PAD = 64;
const RIGHT = CARD_WIDTH - PAD;

/** The site's signature: ruler ticks along the top edge. */
function ruler(): string {
  let minor = "";
  let major = "";
  for (let x = 0; x <= CARD_WIDTH; x += 8) {
    if (x % 80 === 0) major += `M${x + 0.5} 0V18`;
    else minor += `M${x + 0.5} 0V7`;
  }
  return `<path d="${minor}" stroke-width="1" ${stroke("axis")}/><path d="${major}" stroke-width="1.5" ${stroke("ink2")}/>`;
}

/** The open-agent-lab mark: four bars, the last one in the accent color. */
function logo(x: number, y: number, s: number): string {
  const k = s / 32;
  const bar = (bx: number, by: number, h: number, t: Token) =>
    `<rect x="${x + bx * k}" y="${y + by * k}" width="${5 * k}" height="${h * k}" rx="${k}" ${fill(t)}/>`;
  return bar(3, 12, 17, "ink") + bar(10, 5, 24, "ink") + bar(17, 15, 14, "ink") + bar(24, 5, 24, "accent");
}

function chip(label: string, x: number, y: number, bg: Token, ink: Token): string {
  const w = 104;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="34" rx="4" ${fill(bg)}/>` +
    text(label, { x: x + w / 2, y: y + 24, size: 19, weight: 700, mono: true, anchor: "middle", color: ink, spacing: 1 })
  );
}

function footer(): string {
  const y = 568;
  const h = CARD_HEIGHT - y;
  const base = y + h / 2 + 8;
  const size = 20;
  const left = "checked with nerf-watch";
  // Three groups spread across the width, a dot centered in each gap.
  const leftW = monoWidth(left, size);
  const cmdW = monoWidth(CARD_COMMAND, size) + 24;
  const gap = (RIGHT - PAD - leftW - cmdW - monoWidth(CARD_REPO, size)) / 2;
  const cmdX = PAD + leftW + gap;
  const dot = (x: number) => text("·", { x, y: base, size, mono: true, anchor: "middle", color: "bg" });
  return [
    `<rect x="0" y="${y}" width="${CARD_WIDTH}" height="${h}" ${fill("ink")}/>`,
    text(left, { x: PAD, y: base, size, mono: true, color: "bg" }),
    dot(cmdX - gap / 2),
    `<rect x="${cmdX}" y="${base - 25}" width="${cmdW}" height="36" rx="4" ${fill("signal")}/>`,
    text(CARD_COMMAND, { x: cmdX + cmdW / 2, y: base, size, mono: true, weight: 700, anchor: "middle", color: "signalInk" }),
    dot(cmdX + cmdW + gap / 2),
    text(CARD_REPO, { x: RIGHT, y: base, size, mono: true, anchor: "end", color: "bg" }),
  ].join("");
}

function plural(n: number, word: string): string {
  return `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;
}

export function renderCardSvg(m: CardModel): string {
  const out: string[] = [];
  out.push(`<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" ${fill("bg")}/>`);
  out.push(ruler());

  // Header: mark, name, date range.
  out.push(logo(PAD, 56, 36));
  out.push(text("nerf-watch", { x: PAD + 50, y: 86, size: 32, weight: 700, color: "ink", spacing: -0.3 }));
  if (m.range) out.push(text(m.range, { x: RIGHT, y: 84, size: 22, mono: true, color: "muted", anchor: "end" }));

  // Headline.
  const hl = fitHeadline(m.headline, RIGHT - PAD);
  const lh = Math.round(hl.size * 1.12);
  let y = 118 + hl.size;
  hl.lines.forEach((line, i) => out.push(text(line, { x: PAD, y: y + i * lh, size: hl.size, weight: 760, color: "ink", spacing: -0.6 })));
  y += (hl.lines.length - 1) * lh;

  if (m.kind === "findings") {
    let top = y + 30;
    const rowH = 82;
    for (const r of m.rows) {
      out.push(`<path d="M${PAD} ${top + 0.5}H${RIGHT}" stroke-width="1" ${stroke("rule")}/>`);
      out.push(r.severity === "alert" ? chip("ALERT", PAD, top + 14, "alert", "alertInk") : chip("WARN", PAD, top + 14, "signal", "signalInk"));
      const numbers = r.before === null ? r.after : `${r.before} → ${r.after}`;
      const numSize = 32;
      const numW = monoWidth(numbers, numSize);
      const tx = PAD + 128;
      out.push(text(fitText(r.title, 28, RIGHT - tx - numW - 32, "bold"), { x: tx, y: top + 40, size: 28, weight: 650, color: "ink" }));
      out.push(text(numbers, { x: RIGHT, y: top + 42, size: numSize, weight: 700, mono: true, color: "ink", anchor: "end" }));
      const unitW = r.unit ? monoWidth(r.unit, 21) : 0;
      if (r.unit) out.push(text(r.unit, { x: RIGHT, y: top + 72, size: 21, mono: true, color: "muted", anchor: "end" }));
      out.push(text(fitMono(r.detail, 21, RIGHT - tx - unitW - 32), { x: tx, y: top + 72, size: 21, mono: true, color: "muted" }));
      top += rowH;
    }
  } else {
    // All clear: what was read, and what was compared.
    const top = y + 40;
    out.push(chip("CLEAR", PAD, top, "pass", "passInk"));
    out.push(text("No warnings or alerts. Compared across CLI updates and over time:", { x: PAD + 128, y: top + 25, size: 24, color: "ink2" }));
    // The list of signals, wrapped by monospace width into at most two lines.
    const maxW = RIGHT - PAD - 128;
    const lines: string[] = [];
    for (const sig of CHECKED_SIGNALS) {
      const last = lines[lines.length - 1];
      if (last !== undefined && monoWidth(`${last} · ${sig}`, 21) <= maxW) lines[lines.length - 1] = `${last} · ${sig}`;
      else lines.push(sig);
    }
    lines.slice(0, 2).forEach((l, i) => out.push(text(l, { x: PAD + 128, y: top + 62 + i * 30, size: 21, mono: true, color: "muted" })));
    const stats: [string, string][] = [
      [fmtInt(m.responses), m.responses === 1 ? "model response" : "model responses"],
      [fmtInt(m.sessions), m.sessions === 1 ? "session" : "sessions"],
    ];
    if (m.days) stats.push([fmtInt(m.days), m.days === 1 ? "day" : "days"]);
    const sy = top + 196;
    stats.forEach(([n, label], i) => {
      const x = PAD + i * 340;
      out.push(`<path d="M${x + 0.5} ${sy - 62}V${sy + 34}" stroke-width="3" ${stroke(i === 0 ? "accent" : "rule")}/>`);
      out.push(text(n, { x: x + 22, y: sy, size: 60, weight: 700, mono: true, color: "ink", spacing: -1 }));
      out.push(text(label, { x: x + 22, y: sy + 32, size: 22, mono: true, color: "muted" }));
    });
  }

  // What was read, just above the footer.
  const read = [plural(m.responses, "model response"), plural(m.sessions, "session"), joinNames(m.agents, "and")];
  if (m.kind === "findings" && m.more > 0) read.push(`+${m.more} more finding${m.more === 1 ? "" : "s"}`);
  if (m.kind === "findings") out.push(text(fitMono(read.filter(Boolean).join(" · "), 21, RIGHT - PAD), { x: PAD, y: 546, size: 21, mono: true, color: "muted" }));

  out.push(footer());

  const desc =
    m.kind === "clear"
      ? `${m.headline}. ${read.filter(Boolean).join(", ")}${m.range ? `, ${m.range}` : ""}. Checked with nerf-watch: ${CARD_COMMAND}, ${CARD_REPO}.`
      : `${m.headline}. ${m.rows.map((r) => `${r.severity}: ${r.title}, ${r.before === null ? r.after : `${r.before} to ${r.after}`} ${r.unit}`.trim()).join("; ")}. Checked with nerf-watch: ${CARD_COMMAND}, ${CARD_REPO}.`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-labelledby="nw-title nw-desc" font-family="${SANS}">`,
    `<title id="nw-title">${escapeXml(m.headline)}</title>`,
    `<desc id="nw-desc">${escapeXml(desc)}</desc>`,
    style(),
    ...out,
    "</svg>",
    "",
  ].join("\n");
}

export function buildCard(p: SharePayload, o: CardOptions = {}): string {
  return renderCardSvg(cardModel(p, o));
}
