/**
 * `nerf-watch share`: turns findings into a small anonymized payload for the
 * open-agent-lab regression watch, and builds a prefilled GitHub issue URL.
 *
 * Nothing here touches the network. The payload is built only from structured
 * fields (detector ids, severities, CLI versions, model ids, dates, numbers);
 * free text such as finding titles and explanations is never included. Every
 * string goes through an allowlist, and the finished payload is scanned again
 * for anything that looks like a path, an email, a session id, a URL or a
 * local user or host name. If that scan finds anything, nothing is shared.
 */
import { spawn } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { basename } from "node:path";
import { compareVersions } from "./metrics.js";
import { scrubModel, toolVersion } from "./report.js";
import type { Dataset, Evidence, Finding } from "./types.js";

export const SHARE_SCHEMA = "nerf-watch-share/1";
export const LAB_REPO = "https://github.com/Abelo9996/open-agent-lab";
export const ISSUE_TEMPLATE = "regression-report.yml";
/** GitHub rejects very long URLs; stay well under the common 8 KB limit. */
export const MAX_URL_LENGTH = 7000;
export const MAX_SHARED_FINDINGS = 20;

/** Detector id to the signal names the regression watch uses. Detectors not listed here are never shared. */
export const DETECTOR_SIGNAL: Record<string, string> = {
  "newInput-shift": "tokens",
  "newInput-drift": "tokens",
  "firstTurnPrompt-shift": "tokens",
  "cacheCreation-shift": "cache-writes",
  "cacheCreation-drift": "cache-writes",
  "cacheHitRate-shift": "cache-hit-rate",
  "cacheHitRate-drift": "cache-hit-rate",
  "toolErrorRate-shift": "tool-errors",
  "toolErrorRate-drift": "tool-errors",
  "contextWindow-shift": "context-shrink",
  "contextWindow-drift": "context-shrink",
  "effort-drop": "effort-drop",
  "model-mismatch": "model-reroute",
  "hidden-model": "other",
};

const SIGNAL_PHRASE: Record<string, string> = {
  tokens: "token use per turn changed",
  "cache-writes": "cache writes per turn jumped",
  "cache-hit-rate": "cache hit rate fell",
  "tool-errors": "tool error rate rose",
  "context-shrink": "context window shrank",
  "effort-drop": "reasoning effort dropped",
  "model-reroute": "a different model answered",
  other: "an unrecognized model answered",
};

/** Agent ids to the option labels of the issue form's Agent dropdown. */
const AGENT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI" };

export interface ShareSide {
  value: number;
  samples: number;
  from: string | null;
  to: string | null;
}

export interface ShareFinding {
  detector: string;
  signal: string;
  severity: "warn" | "alert";
  trigger: "version" | "time" | "event";
  agent: string;
  /** Model requested. For model-mismatch this is the model the user picked. */
  model: string;
  /** Model that answered, when it differs from `model`. */
  servedModel: string | null;
  /** Last CLI version before the change, or null when there is no before side. */
  cliBefore: string | null;
  /** First CLI version showing the change. */
  cliAfter: string;
  before: ShareSide | null;
  after: ShareSide;
}

export interface SharePayload {
  schema: typeof SHARE_SCHEMA;
  nerfWatchVersion: string;
  window: { from: string | null; to: string | null };
  agents: { id: string; sessions: number; turns: number }[];
  findings: ShareFinding[];
}

const AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][\w.\-\[\]]{0,79}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Placeholders used when a model id or version could identify the user. Deliberately not hashed: a hash of a short secret can be guessed. */
export const CUSTOM_MODEL = "custom-model";
export const CUSTOM_VERSION = "custom-version";

/** Strings that are fixed vocabulary in the payload and so are never personal. */
const ENUM_VALUES = new Set<string>([
  SHARE_SCHEMA,
  ...Object.keys(DETECTOR_SIGNAL),
  ...Object.values(DETECTOR_SIGNAL),
  "warn",
  "alert",
  "version",
  "time",
  "event",
  CUSTOM_MODEL,
  CUSTOM_VERSION,
]);

/**
 * Names that identify this machine or user: the account name, the home
 * directory and its last segment, and the short host name. Anything shorter
 * than three characters is ignored, since it would match ordinary text.
 */
export function localIdentifiers(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const s = (v ?? "").trim();
    if (s.length >= 3) out.add(s);
  };
  try {
    add(userInfo().username);
  } catch {
    // no passwd entry (some containers)
  }
  add(env.USER);
  add(env.USERNAME);
  add(env.LOGNAME);
  for (const h of [homedir(), env.HOME, env.USERPROFILE]) {
    add(h);
    if (h) add(basename(h));
  }
  try {
    add(hostname().split(".")[0]);
  } catch {
    // ignore
  }
  return [...out];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `token` appears in `s` as a whole word (case-insensitive). */
function containsToken(s: string, token: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(token)}($|[^A-Za-z0-9])`, "i").test(s);
}

const LEAK_PATTERNS: [string, RegExp][] = [
  ["a file path", /[\/\\~]|^[A-Za-z]:|\.\./],
  ["an email address or handle", /@/],
  ["a URL", /:\/\/|^www\./i],
  ["a session or request id", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ["a long hex id", /[0-9a-f]{24,}/i],
  ["a long numeric id", /\d{10,}/],
  ["whitespace or control characters", /[\s\u0000-\u001f\u007f]/],
];

/** Why `s` cannot be shared, or null if it can. */
export function leakReason(s: string, identifiers: string[]): string | null {
  if (ENUM_VALUES.has(s)) return null;
  for (const [what, re] of LEAK_PATTERNS) if (re.test(s)) return `looks like ${what}`;
  for (const id of identifiers) {
    // Whole-word match for any name; substring match for longer ones, which cannot occur by chance.
    if (containsToken(s, id) || (id.length >= 6 && s.toLowerCase().includes(id.toLowerCase()))) {
      return "contains a local user, home directory or host name";
    }
  }
  return null;
}

/**
 * Last line of defense: walk every value in the payload. Returns one message
 * per problem; an empty list means the payload is safe to show and share.
 */
export function scanPayload(payload: unknown, identifiers: string[]): string[] {
  const problems: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) problems.push(`${path}: not a finite number`);
      return;
    }
    if (typeof v === "string") {
      const why = leakReason(v, identifiers);
      if (why) problems.push(`${path}: ${why}`);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!/^[A-Za-z]+$/.test(k)) problems.push(`${path}: unexpected key`);
        walk(x, path ? `${path}.${k}` : k);
      }
      return;
    }
    problems.push(`${path}: unexpected ${typeof v}`);
  };
  walk(payload, "");
  return problems;
}

function cleanModel(m: string | undefined, ids: string[]): string {
  if (!m) return "unknown";
  const s = scrubModel(m);
  if (s.startsWith("custom-model-") || !MODEL_RE.test(s) || leakReason(s, ids)) return CUSTOM_MODEL;
  return s;
}

function cleanVersion(v: string | undefined | null, ids: string[]): string | null {
  if (!v || v === "unknown") return null;
  return VERSION_RE.test(v) && !leakReason(v, ids) ? v : CUSTOM_VERSION;
}

const cleanDate = (d: string | undefined): string | null => (d && DATE_RE.test(d) ? d : null);

function side(e: Evidence | undefined): ShareSide | null {
  if (!e) return null;
  const value = Number.isFinite(e.value) ? Number(e.value.toPrecision(4)) : 0;
  return { value, samples: Math.max(0, Math.round(e.samples)), from: cleanDate(e.from), to: cleanDate(e.to) };
}

function shareFinding(f: Finding, ids: string[]): ShareFinding | null {
  const signal = DETECTOR_SIGNAL[f.id];
  if (!signal || (f.severity !== "warn" && f.severity !== "alert")) return null;
  if (!AGENT_RE.test(f.agent)) return null;
  const versionsOf = (e: Evidence | undefined) => (e?.versions ?? []).filter((v) => v !== "unknown").sort(compareVersions);
  let before: ShareSide | null;
  let after: ShareSide | null;
  let cliBefore: string | null;
  let cliAfter: string | null;
  if (f.id === "model-mismatch") {
    // evidence: [requested (value = all turns), served (value = share answered by the other model)]
    const served = f.evidence.find((e) => e.label === "served");
    before = null;
    after = side(served);
    cliBefore = null;
    cliAfter = versionsOf(served)[0] ?? null;
  } else if (f.trigger === "event") {
    const e = f.evidence[0];
    before = null;
    after = side(e);
    cliBefore = null;
    cliAfter = versionsOf(e)[0] ?? null;
  } else {
    const [b, a] = [f.evidence.find((e) => e.label === "before"), f.evidence.find((e) => e.label === "after")];
    before = side(b);
    after = side(a);
    const bv = versionsOf(b);
    cliBefore = bv[bv.length - 1] ?? null;
    cliAfter = versionsOf(a)[0] ?? null;
  }
  const cliAfterClean = cleanVersion(cliAfter, ids);
  if (!after || !cliAfterClean) return null;
  const isMismatch = f.id === "model-mismatch";
  return {
    detector: f.id,
    signal,
    severity: f.severity,
    trigger: f.trigger,
    agent: f.agent,
    model: cleanModel(isMismatch ? f.requestedModel : f.model, ids),
    servedModel: isMismatch ? cleanModel(f.model, ids) : null,
    cliBefore: cleanVersion(cliBefore, ids),
    cliAfter: cliAfterClean,
    before,
    after,
  };
}

export function buildSharePayload(ds: Dataset, findings: Finding[], identifiers: string[] = localIdentifiers()): SharePayload {
  const shared = findings
    .map((f) => shareFinding(f, identifiers))
    .filter((f): f is ShareFinding => f !== null)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "alert" ? -1 : 1))
    .slice(0, MAX_SHARED_FINDINGS);
  const agents = Object.keys(ds.files)
    .filter((a) => ds.files[a] > 0 && AGENT_RE.test(a))
    .map((a) => ({ id: a, sessions: ds.files[a], turns: ds.turns.filter((t) => t.agent === a).length }));
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    schema: SHARE_SCHEMA,
    nerfWatchVersion: cleanVersion(toolVersion(), identifiers) ?? "0.0.0",
    window: {
      from: ds.turns.length ? iso(Math.min(...ds.turns.map((t) => t.timestamp))) : null,
      to: ds.turns.length ? iso(Math.max(...ds.turns.map((t) => t.timestamp))) : null,
    },
    agents,
    findings: shared,
  };
}

const enc = encodeURIComponent;

function issueUrl(fields: Record<string, string>): string {
  const q = Object.entries({ template: ISSUE_TEMPLATE, ...fields })
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${enc(v)}`)
    .join("&");
  return `${LAB_REPO}/issues/new?${q}`;
}

export interface ShareLink {
  url: string;
  /** False when the JSON did not fit in the URL and must be pasted by hand. */
  reportPrefilled: boolean;
  json: string;
}

/**
 * Pretty-prints the payload with one agent or finding per line: readable in
 * the issue and short enough to fit in a link. This exact text is what the
 * terminal shows and what the link carries.
 */
export function formatPayload(p: SharePayload): string {
  const list = (xs: unknown[]) => (xs.length ? `[\n${xs.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : "[]");
  return [
    "{",
    `  "schema": ${JSON.stringify(p.schema)},`,
    `  "nerfWatchVersion": ${JSON.stringify(p.nerfWatchVersion)},`,
    `  "window": ${JSON.stringify(p.window)},`,
    `  "agents": ${list(p.agents)},`,
    `  "findings": ${list(p.findings)}`,
    "}",
  ].join("\n");
}

/** Builds the prefilled "new issue" URL for the regression-report form. */
export function shareLink(p: SharePayload, maxLength = MAX_URL_LENGTH): ShareLink {
  const json = formatPayload(p);
  const top = p.findings[0];
  const more = p.findings.length > 1 ? ` (+${p.findings.length - 1} more)` : "";
  const agentLabel = top ? AGENT_LABEL[top.agent] ?? "Other (say which below)" : "";
  const fields: Record<string, string> = top
    ? {
        title: `[regression] ${AGENT_LABEL[top.agent] ?? top.agent} ${top.cliAfter}: ${SIGNAL_PHRASE[top.signal]}${more}`,
        agent: agentLabel,
        cli_before: top.cliBefore ?? top.cliAfter,
        cli_after: top.cliAfter,
        model: top.model,
        model_served: top.servedModel ?? "",
        nerf_watch_version: p.nerfWatchVersion,
        first_seen: top.after.from ?? "",
      }
    : {};
  const url = issueUrl({ ...fields, report: json });
  if (url.length <= maxLength) return { url, reportPrefilled: true, json };
  return { url: issueUrl(fields), reportPrefilled: false, json };
}

/** Opens a URL in the default browser. The only side effect of `share`, and only with --open. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
