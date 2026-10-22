/**
 * `nerf-watch overhead`: what you pay before you type anything, and why.
 *
 * Three views, from cheapest to most thorough:
 *  - from logs: current startup tokens per agent and model, the trend, cache
 *    hit rate, and startup overhead as a share of a typical turn;
 *  - from config (read only): the sources that make up that overhead;
 *  - measured (--measure): ablation runs through the agent's own CLI that
 *    attribute real tokens to each source.
 */
import type { Dataset, Turn } from "./types.js";
import { cacheHitRate, mainTurns, median, modelOf, promptTokens, warmTurns } from "./metrics.js";
import { type ConfigSource } from "./config-scan.js";
import type { ProfileResult } from "./measure.js";
import type { StartupAttribution, StartupGroup } from "./startup.js";
import { fmtTokensApprox } from "./tokens.js";
import { bold, dim, fmtPct, fmtTokens, table } from "./format.js";

const DAY = 86_400_000;

export interface LogOverhead {
  agent: string;
  model: string;
  /** Median prompt tokens on the first turn of a session: the fixed startup context. */
  startupMedian: number | null;
  startupSamples: number;
  /** Median prompt tokens on a warm turn, for the "share of a turn" figure. */
  perTurnMedian: number | null;
  cacheHitRate: number | null;
  warmSamples: number;
  /** Older vs recent first-turn medians, when both sides have enough sessions. */
  trend: { olderMedian: number; recentMedian: number; from: string; to: string } | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Per (agent, model) startup overhead read from the logs. */
export function logOverhead(ds: Dataset, opts: { recentDays?: number } = {}): LogOverhead[] {
  const recentDays = opts.recentDays ?? 7;
  const now = ds.turns.length ? ds.turns[ds.turns.length - 1].timestamp : Date.now();
  const cutoff = now - recentDays * DAY;
  const groups = new Map<string, Turn[]>();
  for (const t of mainTurns(ds.turns)) {
    const k = `${t.agent}\u0000${modelOf(t)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: LogOverhead[] = [];
  for (const [k, turns] of groups) {
    const [agent, model] = k.split("\u0000");
    const firsts = turns.filter((t) => t.firstInSession);
    const warm = warmTurns(turns);
    const startup = firsts.map(promptTokens);
    let trend: LogOverhead["trend"] = null;
    const older = firsts.filter((t) => t.timestamp < cutoff);
    const recent = firsts.filter((t) => t.timestamp >= cutoff);
    if (older.length >= 3 && recent.length >= 3) {
      trend = {
        olderMedian: median(older.map(promptTokens)),
        recentMedian: median(recent.map(promptTokens)),
        from: iso(older[0].timestamp),
        to: iso(recent[recent.length - 1].timestamp),
      };
    }
    out.push({
      agent,
      model,
      startupMedian: startup.length ? median(startup) : null,
      startupSamples: startup.length,
      perTurnMedian: warm.length ? median(warm.map(promptTokens)) : null,
      cacheHitRate: cacheHitRate(warm),
      warmSamples: warm.length,
      trend,
    });
  }
  return out.sort((a, b) => (b.startupMedian ?? 0) - (a.startupMedian ?? 0));
}

// ------------------------------------------------------------- attribution

export interface AttributionRow {
  source: string;
  /** Tokens per request attributed to this source. */
  tokens: number;
  /** Share of the measured startup total. */
  share: number;
  evidence: string;
  /** False for the base system prompt and built-in tools, which these flags cannot remove. */
  reducible: boolean;
}

export interface Attribution {
  model: string;
  /** Median measured startup total (everything on). */
  total: number;
  rows: AttributionRow[];
  /** total minus the sum of the rows: measurement noise and anything not attributed. */
  residual: number;
  /** A run came back with a lower-than-floor total (noise); worth a caveat. */
  noisy: boolean;
  totalCost: number;
}

function val(results: ProfileResult[], id: string): number | null {
  return results.find((r) => r.id === id)?.total ?? null;
}

// ------------------------------------------------------------- formatting

/** Share of a typical request that is fixed startup overhead (startup / per-turn prompt). */
export function fixedShare(o: LogOverhead): number | null {
  if (!o.startupMedian || !o.perTurnMedian) return null;
  return Math.min(1, o.startupMedian / Math.max(o.perTurnMedian, o.startupMedian));
}

export function formatLogOverhead(logs: LogOverhead[]): string {
  if (!logs.length) return dim("No model responses in the logs yet, so there is no startup trend to show.");
  const rows = logs.map((o) => {
    const trend = o.trend
      ? `${fmtTokens(o.trend.olderMedian)} -> ${fmtTokens(o.trend.recentMedian)}`
      : "-";
    return [
      o.agent,
      o.model,
      o.startupMedian === null ? "-" : fmtTokens(o.startupMedian),
      o.perTurnMedian === null ? "-" : fmtTokens(o.perTurnMedian),
      fixedShare(o) === null ? "-" : fmtPct(fixedShare(o)),
      o.cacheHitRate === null ? "-" : fmtPct(o.cacheHitRate),
      trend,
      String(o.startupSamples),
    ];
  });
  const headers = ["agent", "model", "startup", "per turn", "fixed/req", "cache hit", "startup trend", "sessions"];
  const align: ("l" | "r")[] = ["l", "l", "r", "r", "r", "r", "l", "r"];
  return (
    bold("Startup overhead, from your logs") +
    "\n\n" +
    table(headers, rows, align) +
    "\n\n" +
    dim("startup = median prompt tokens on the first turn of a session (the fixed context before you type). per turn = median prompt on a warm turn. fixed/req estimates the share of a typical request that is fixed startup overhead. trend compares the recent window to older sessions.")
  );
}

const GROUP_LABEL: Record<StartupGroup, string> = {
  base: "Base system prompt and built-in tools",
  skills: "Skill listing",
  agents: "Agent listing",
  instructions: "Instructions (CLAUDE.md)",
  hooks: "SessionStart hooks",
  mcp: "MCP instructions",
  tools: "Deferred tool listing",
  context: "Environment and session context",
};

/** The free, log-based attribution of the real interactive startup, by source then per file/hook. */
export function formatStartupAttribution(a: StartupAttribution): string {
  const lines: string[] = [
    bold("Startup attribution, from your logs (no measurement)"),
    "",
    `Real interactive startup: ${fmtTokens(a.calibratedTotal)} tokens, the median first-turn usage across ${a.sessions} recent ${a.model} session(s). Scripted claude -p and SDK sessions are left out.`,
    "",
  ];
  const share = (t: number) => (a.calibratedTotal > 0 ? fmtPct(t / a.calibratedTotal) : "-");
  lines.push(
    table(
      ["source", "tokens", "share", "detail"],
      a.groups.map((g) => [GROUP_LABEL[g.group], fmtTokens(g.tokens), share(g.tokens), g.detail]),
      ["l", "r", "r", "l"],
    ),
  );

  // Per file / per hook / per server drill-down. Explanatory, so it need not sum to the group total.
  for (const g of ["instructions", "hooks", "mcp"] as StartupGroup[]) {
    const rows = a.details.filter((r) => r.group === g);
    if (!rows.length || (rows.length <= 1 && g !== "instructions")) continue;
    const per = g === "instructions" ? "file" : g === "hooks" ? "hook" : "server";
    lines.push("", bold(`  ${GROUP_LABEL[g]}, per ${per} (typical cost when a session loads it):`));
    for (const r of rows) lines.push(`    ${r.label.padEnd(58)} ${fmtTokens(r.tokens).padStart(8)}`);
  }

  lines.push(
    "",
    dim(
      `The source rows sum to ${fmtTokens(a.calibratedTotal - a.residual)}, within ${fmtTokens(Math.abs(a.residual))} of the ${fmtTokens(a.calibratedTotal)} calibrated total. ` +
        `About ${fmtTokens(a.reducible)} is reducible (everything but the base); the base (${fmtTokens(a.base)}) is the system prompt and built-in tools, ` +
        "and cross-checks the ~31.7k that `claude -p` measures, since it loads the base but none of the attachments. Per-source figures are offline byte estimates.",
    ),
  );
  if (a.noisy) lines.push(dim("Some sessions estimated more attachment tokens than their first-turn usage, so their base was clamped to zero; per-source estimates are an upper bound there."));
  return lines.join("\n");
}

export function formatConfigSources(sources: ConfigSource[]): string {
  if (!sources.length) return dim("No config sources found.");
  const lines: string[] = [bold("Sources loaded before your first message, from config (read only)")];
  const agents = [...new Set(sources.map((s) => s.agent))];
  for (const a of agents) {
    lines.push("", `  ${a}`);
    for (const s of sources.filter((x) => x.agent === a)) {
      const size = s.estTokens !== undefined ? ` (~${fmtTokensApprox(s.estTokens)})` : "";
      lines.push(`    - ${s.label}${size}: ${s.detail}`);
    }
  }
  lines.push("", dim("Sizes marked ~ are local estimates. Run with --measure to attribute real tokens per source."));
  return lines.join("\n");
}

export function formatAttribution(a: Attribution): string {
  const rows = a.rows.map((r) => [r.source, fmtTokens(r.tokens), fmtPct(r.share), r.evidence]);
  const headers = ["source", "tokens/req", "share", "evidence"];
  const align: ("l" | "r")[] = ["l", "r", "r", "l"];
  const top = a.rows.filter((r) => r.reducible).slice(0, 3).map((r) => r.source);
  const lines = [
    bold(`Measured attribution (model ${a.model}, $${a.totalCost.toFixed(4)} spent)`),
    "",
    table(headers, rows, align),
    "",
    `Measured startup total: ${fmtTokens(a.total)} tokens. The parts above sum to within ${fmtTokens(Math.abs(a.residual))} of it (measurement noise).`,
  ];
  if (top.length) lines.push(`Top reducible sources: ${top.join(", ")}. Run \`nerf-watch fix\` to see reversible changes.`);
  if (a.noisy) lines.push(dim("Some runs came back below the no-sources floor; small negative deltas were treated as zero. Re-run with more repeats for a cleaner split."));
  return lines.join("\n");
}

/**
 * Turn the ablation profile medians into a ranked per-source table.
 * total = baseline. floor = no MCP, no user sources (base system prompt and
 * built-in tools). Each MCP server, the user memory, and the rest of the user
 * sources are differences between runs, so they add back up to the total.
 */
export function buildAttribution(results: ProfileResult[], config: ConfigSource[], model: string): Attribution | null {
  const baseline = val(results, "baseline");
  const noMcp = val(results, "no-mcp");
  const noUser = val(results, "no-user");
  if (baseline === null || noMcp === null || noUser === null) return null;

  const rows: AttributionRow[] = [];
  let noisy = false;
  const clamp = (n: number) => {
    if (n < 0) noisy = true;
    return Math.max(0, Math.round(n));
  };

  // MCP servers: one row each, measured against the no-server run.
  const mcpServers = results.filter((r) => r.id.startsWith("mcp:"));
  let mcpAccounted = 0;
  for (const s of mcpServers) {
    if (s.total === null) continue;
    const name = s.id.slice("mcp:".length);
    const tokens = clamp(s.total - noMcp);
    mcpAccounted += tokens;
    rows.push({ source: `MCP server "${name}"`, tokens, share: 0, evidence: "measured: startup with vs without this server", reducible: true });
  }
  // Any MCP cost not captured per-server (e.g. several servers at once), as one catch-all.
  const mcpTotal = clamp(baseline - noMcp);
  if (mcpServers.length === 0 && mcpTotal > 0) {
    rows.push({ source: "MCP servers", tokens: mcpTotal, share: 0, evidence: "measured: startup with vs without MCP (--strict-mcp-config)", reducible: true });
  }

  // User memory, isolated with a temp copy.
  const memory = val(results, "memory");
  const memTokens = memory !== null ? clamp(memory - noUser) : null;
  if (memTokens !== null && memTokens > 0) {
    const cfg = config.find((s) => s.id === "claude:memory:user");
    rows.push({ source: "User memory (CLAUDE.md)", tokens: memTokens, share: 0, evidence: `measured: a temp copy of the memory file added${cfg?.estTokens ? ` (local estimate ${fmtTokensApprox(cfg.estTokens)})` : ""}`, reducible: true });
  }

  // Everything else in the user setting sources: settings, context-injecting hooks, skills, plugins.
  const userTotal = clamp(noMcp - noUser);
  const userRest = clamp(userTotal - (memTokens ?? 0));
  if (userRest > 0) {
    const contributors = config
      .filter((s) => s.scope === "user" && (s.kind === "hook" || s.kind === "skill" || s.kind === "plugin"))
      .map((s) => s.label);
    rows.push({
      source: "User settings, hooks and skills",
      tokens: userRest,
      share: 0,
      evidence: contributors.length ? `measured: user setting sources on vs off; includes ${contributors.join(", ")}` : "measured: user setting sources on vs off",
      reducible: true,
    });
  }

  // The floor these flags cannot remove.
  rows.push({ source: "Base system prompt and built-in tools", tokens: clamp(noUser), share: 0, evidence: "measured floor: no MCP and no user sources", reducible: false });

  rows.sort((a, b) => b.tokens - a.tokens);
  for (const r of rows) r.share = baseline > 0 ? r.tokens / baseline : 0;
  const sum = rows.reduce((s, r) => s + r.tokens, 0);
  return { model, total: baseline, rows, residual: Math.round(baseline - sum), noisy, totalCost: results.reduce((s, r) => s + r.cost, 0) };
}
