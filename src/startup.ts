/**
 * Log-based startup attribution (free, exact-ish, interactive sessions).
 *
 * Claude Code records every startup injection as `type: "attachment"` rows near
 * the top of a session file, each carrying the injected text. By sizing each of
 * those (skill listing, each CLAUDE.md file, each SessionStart hook's output,
 * the agent listing, deferred tools, MCP instructions, environment, session
 * context) and pinning the remainder against the session's own first-turn usage
 * (input + cache_creation + cache_read), we can attribute the real interactive
 * startup to each source without spending a cent or running the CLI.
 *
 * This reads raw session files (not the privacy-scrubbed Turn model), so its
 * output is local only: never part of share, card or report. It still avoids
 * printing anything but home-relative paths and source labels.
 *
 * The cross-check: the remainder (base system prompt plus built-in tools, the
 * part no attachment carries) lands near what `claude -p` measures as its
 * startup, because `claude -p` loads exactly that base and none of the
 * interactive attachments.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "./adapters/claude.js";
import { readJsonl } from "./adapters/util.js";
import { estimateTokens } from "./tokens.js";
import { median, normalizeModel } from "./metrics.js";

export type StartupGroup = "skills" | "agents" | "instructions" | "hooks" | "mcp" | "tools" | "context" | "base";

export interface StartupItem {
  /** Stable key, unique within a sample. Per-file and per-hook items use the path / hook name. */
  key: string;
  label: string;
  group: StartupGroup;
  tokens: number;
  reducible: boolean;
  detail?: string;
}

export interface StartupSample {
  sessionKey: string;
  timestamp: number;
  /** Normalized model that answered the first turn, for grouping like-with-like. */
  model: string;
  /** First-turn prompt tokens: input + cache_creation + cache_read. The calibration anchor. */
  calibratedTotal: number;
  /** Reducible attachment items only (base is derived per sample, not stored here). */
  items: StartupItem[];
}

/** A top-level group line: the per-session median of that group's total. These sum to the calibrated total. */
export interface StartupGroupRow {
  group: StartupGroup;
  tokens: number;
  reducible: boolean;
  detail: string;
}

/**
 * A per-file / per-hook / per-server drill-down line: the typical tokens that
 * source costs when a session loads it. These do NOT sum to the total, because
 * different sessions load different project files; they explain the group.
 */
export interface StartupDetailRow {
  key: string;
  label: string;
  group: StartupGroup;
  tokens: number;
  samples: number;
}

export interface StartupAttribution {
  /** The model these sessions ran on (the most common among the samples). */
  model: string;
  /** Sessions on this model that had both attachments and a first-turn usage. */
  sessions: number;
  /** Median first-turn usage across those sessions: the real interactive startup. */
  calibratedTotal: number;
  /** Group totals (per-session medians). Sum to within `residual` of the calibrated total. */
  groups: StartupGroupRow[];
  /** Per-file / per-hook / per-server drill-down. Explanatory, not summed. */
  details: StartupDetailRow[];
  /** Median per-session base (first-turn usage minus the attributed sources). */
  base: number;
  /** calibratedTotal minus the summed group medians: the residual the medians leave. */
  residual: number;
  /** Total reducible tokens (everything a fix could remove), per-session median. */
  reducible: number;
  /** True when a sample's attributed parts estimated to more than its first-turn usage (base clamped). */
  noisy: boolean;
}

export interface ReadStartupOptions {
  roots?: string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Only sessions whose file was touched at/after this epoch ms. */
  since?: number;
  /** Most recent N sessions with attachments to read. Default 40. */
  limit?: number;
}

function claudeRoots(opts: ReadStartupOptions): string[] {
  if (opts.roots) return opts.roots;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  return claudeAdapter.defaultRoots({ env, homedir: home, platform: opts.platform ?? process.platform });
}

/** The text a SessionStart hook actually injects: its stdout, or the content field when stdout is empty. */
function hookInjected(a: any): string {
  const stdout = typeof a.stdout === "string" ? a.stdout : "";
  if (stdout) return stdout;
  return typeof a.content === "string" ? a.content : "";
}

/** The slug Claude Code uses for a hook event, for the "startup" / "prompt" distinction. */
function isStartupHook(a: any): boolean {
  if (a.hookEvent === "SessionStart") return true;
  return typeof a.hookName === "string" && a.hookName.startsWith("SessionStart");
}

/**
 * Parse one session file's startup: the attachment rows before the first model
 * response, plus that response's prompt-token total. Returns null when the file
 * has no attachments (older CLI versions) or never reached a first response.
 */
export async function parseStartupFile(file: string, home: string): Promise<StartupSample | null> {
  const tilde = (p: string) => (p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const items: StartupItem[] = [];
  let calibratedTotal: number | null = null;
  let firstTs = 0;
  let model = "unknown";
  const filter = (l: string) => l.includes('"attachment"') || l.includes('"assistant"');

  for await (const r of readJsonl(file, filter)) {
    if ("bad" in r) continue;
    const o = r.value;
    if (!o || typeof o !== "object") continue;

    if (o.type === "attachment" && o.attachment && typeof o.attachment === "object") {
      const a = o.attachment;
      switch (a.type) {
        case "skill_listing": {
          const tok = estimateTokens(typeof a.content === "string" ? a.content : "");
          const n = typeof a.skillCount === "number" ? a.skillCount : Array.isArray(a.names) ? a.names.length : 0;
          if (tok > 0) items.push({ key: "skills", label: "Skill listing", group: "skills", tokens: tok, reducible: true, detail: `${n} skill description(s) in the system prompt` });
          break;
        }
        case "agent_listing_delta": {
          const added = Array.isArray(a.addedLines) ? a.addedLines : [];
          const tok = estimateTokens(added.join("\n"));
          const nUser = Array.isArray(a.addedTypes) ? a.addedTypes.length : added.length;
          const nBuilt = Array.isArray(a.builtInTypes) ? a.builtInTypes.length : 0;
          if (tok > 0) items.push({ key: "agents", label: "Agent listing", group: "agents", tokens: tok, reducible: true, detail: `${nUser} user agent(s) plus ${nBuilt} built-in` });
          break;
        }
        case "deferred_tools_delta": {
          const added = Array.isArray(a.addedLines) ? a.addedLines : [];
          const defs = Array.isArray(a.surfacedDefinitions) ? a.surfacedDefinitions.map((d: any) => d?.definition ?? "").join("\n") : "";
          const tok = estimateTokens(added.join("\n")) + estimateTokens(defs);
          const n = Array.isArray(a.addedNames) ? a.addedNames.length : added.length;
          if (tok > 0) items.push({ key: "tools", label: "Deferred tool listing", group: "tools", tokens: tok, reducible: true, detail: `${n} tool(s) listed for on-demand search` });
          break;
        }
        case "mcp_instructions_delta": {
          const names = Array.isArray(a.addedNames) ? a.addedNames : [];
          const blocks = Array.isArray(a.addedBlocks) ? a.addedBlocks : [];
          for (let i = 0; i < blocks.length; i++) {
            const tok = estimateTokens(String(blocks[i] ?? ""));
            const name = String(names[i] ?? `server ${i + 1}`);
            if (tok > 0) items.push({ key: `mcp:${name}`, label: `MCP instructions "${name}"`, group: "mcp", tokens: tok, reducible: true });
          }
          break;
        }
        case "instructions": {
          const files = Array.isArray(a.files) ? a.files : [];
          for (const f of files) {
            const tok = estimateTokens(typeof f?.content === "string" ? f.content : "");
            if (tok <= 0 || typeof f?.path !== "string") continue;
            const kind = typeof f.type === "string" ? f.type : "memory";
            items.push({ key: `instructions:${f.path}`, label: `${tilde(f.path)} (${kind})`, group: "instructions", tokens: tok, reducible: true });
          }
          break;
        }
        case "hook_success": {
          if (!isStartupHook(a)) break;
          const tok = estimateTokens(hookInjected(a));
          if (tok <= 0) break;
          const name = typeof a.hookName === "string" ? a.hookName : "SessionStart hook";
          items.push({ key: `hook:${name}`, label: `${name} hook`, group: "hooks", tokens: tok, reducible: true, detail: hookCommand(a) });
          break;
        }
        case "environment": {
          const tok = estimateTokens(JSON.stringify(a.snapshot ?? {}));
          if (tok > 0) items.push({ key: "environment", label: "Environment", group: "context", tokens: tok, reducible: true });
          break;
        }
        case "session_context": {
          const tok = estimateTokens(JSON.stringify(a.context ?? {}));
          if (tok > 0) items.push({ key: "session_context", label: "Session context", group: "context", tokens: tok, reducible: true });
          break;
        }
      }
      continue;
    }

    if (o.type === "assistant" && o.message && typeof o.message === "object") {
      const u = o.message.usage;
      if (!u || typeof u !== "object") continue;
      const total = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
      if (total <= 0) continue; // placeholder record, not a real response
      calibratedTotal = total;
      firstTs = Date.parse(o.timestamp) || 0;
      if (typeof o.message.model === "string" && o.message.model && o.message.model !== "<synthetic>") model = normalizeModel(o.message.model);
      break; // the first real response pins the startup; later rows do not matter
    }
  }

  if (calibratedTotal === null || !items.length) return null;
  // Collapse duplicate keys (a source can appear on more than one row).
  const byKey = new Map<string, StartupItem>();
  for (const it of items) {
    const prev = byKey.get(it.key);
    if (prev) prev.tokens += it.tokens;
    else byKey.set(it.key, { ...it });
  }
  return { sessionKey: file, timestamp: firstTs, model, calibratedTotal, items: [...byKey.values()] };
}

function hookCommand(a: any): string | undefined {
  if (typeof a.command !== "string" || !a.command) return undefined;
  // The command is a shell string with absolute paths; keep only the script basename.
  const m = a.command.match(/[\w.-]+\.(?:c?js|mjs|ts|py|sh)\b/);
  return m ? m[0] : undefined;
}

/** Read the most recent sessions with attachments and return one sample each. */
export async function readStartupSamples(opts: ReadStartupOptions = {}): Promise<StartupSample[]> {
  const home = opts.home ?? homedir();
  const roots = claudeRoots(opts);
  const files = await claudeAdapter.discover(roots);
  // Most-recently-touched first, so the newest sessions are read first.
  const withMtime = await Promise.all(
    files.map(async (f) => {
      try {
        return { f, m: (await stat(f)).mtimeMs };
      } catch {
        return { f, m: 0 };
      }
    }),
  );
  let candidates = withMtime;
  if (opts.since !== undefined) candidates = candidates.filter((c) => c.m >= opts.since!);
  candidates.sort((a, b) => b.m - a.m);
  const limit = opts.limit ?? 40;
  const out: StartupSample[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    const s = await parseStartupFile(c.f, home);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Aggregate the samples into one attribution. Sessions are grouped by the model
 * that answered, and the most-sampled model is attributed, so a handful of cheap
 * experimental sessions on another model cannot dilute the picture of a typical
 * interactive startup. The base is computed per session (its own first-turn
 * usage minus its own attributed sources) and then taken as a median, so mixing
 * models never produces a nonsensical base.
 */
export function aggregateStartup(samples: StartupSample[]): StartupAttribution | null {
  if (!samples.length) return null;

  // Pick the model with the most samples (ties: the larger median startup, the heavier setup).
  const byModel = new Map<string, StartupSample[]>();
  for (const s of samples) (byModel.get(s.model) ?? byModel.set(s.model, []).get(s.model)!).push(s);
  let model = "";
  let group: StartupSample[] = [];
  for (const [m, g] of byModel) {
    const better =
      !model ||
      g.length > group.length ||
      (g.length === group.length && median(g.map((x) => x.calibratedTotal)) > median(group.map((x) => x.calibratedTotal)));
    if (better) {
      model = m;
      group = g;
    }
  }

  const calibratedTotal = median(group.map((s) => s.calibratedTotal));
  const GROUP_KINDS: StartupGroup[] = ["skills", "agents", "instructions", "hooks", "mcp", "tools", "context"];

  // Per-session group totals and bases, so the group medians reflect one real session.
  const perGroupTotals = new Map<StartupGroup, number[]>();
  for (const g of GROUP_KINDS) perGroupTotals.set(g, []);
  const bases: number[] = [];
  const reducibles: number[] = [];
  let noisy = false;
  const byKey = new Map<string, { label: string; group: StartupGroup; tokens: number[] }>();
  for (const s of group) {
    const groupSum = new Map<StartupGroup, number>();
    let attributed = 0;
    for (const it of s.items) {
      if (!it.reducible) continue;
      attributed += it.tokens;
      groupSum.set(it.group, (groupSum.get(it.group) ?? 0) + it.tokens);
      let e = byKey.get(it.key);
      if (!e) byKey.set(it.key, (e = { label: it.label, group: it.group, tokens: [] }));
      e.tokens.push(it.tokens);
    }
    for (const g of GROUP_KINDS) perGroupTotals.get(g)!.push(groupSum.get(g) ?? 0);
    reducibles.push(attributed);
    let base = s.calibratedTotal - attributed;
    if (base < 0) {
      noisy = true;
      base = 0;
    }
    bases.push(base);
  }

  const base = Math.round(median(bases));
  const groups: StartupGroupRow[] = [];
  const countKeys = (g: StartupGroup) => new Set([...byKey].filter(([, e]) => e.group === g).map(([k]) => k)).size;
  for (const g of GROUP_KINDS) {
    const tok = Math.round(median(perGroupTotals.get(g)!));
    if (tok <= 0) continue;
    const n = countKeys(g);
    const detail =
      g === "skills" ? detailNote(group, "skills")
      : g === "agents" ? detailNote(group, "agents")
      : g === "instructions" ? `${n} file(s) per session (typical)`
      : g === "hooks" ? `${n} hook(s)`
      : g === "mcp" ? `${n} server(s)`
      : g === "tools" ? "deferred tool search listing"
      : "environment and session context";
    groups.push({ group: g, tokens: tok, reducible: true, detail });
  }
  groups.push({ group: "base", tokens: base, reducible: false, detail: "system prompt and built-in tools; cross-checks the `claude -p` startup" });
  groups.sort((a, b) => b.tokens - a.tokens);

  const details: StartupDetailRow[] = [];
  for (const [key, e] of byKey) {
    details.push({ key, label: e.label, group: e.group, tokens: Math.round(median(e.tokens)), samples: e.tokens.length });
  }
  details.sort((a, b) => b.tokens - a.tokens);

  const summed = groups.reduce((n, r) => n + r.tokens, 0);
  return {
    model,
    sessions: group.length,
    calibratedTotal: Math.round(calibratedTotal),
    groups,
    details,
    base,
    residual: Math.round(calibratedTotal - summed),
    reducible: Math.round(median(reducibles)),
    noisy,
  };
}

/** The "N skills" / "N user agents plus M built-in" note from a sample's detail string. */
function detailNote(samples: StartupSample[], group: "skills" | "agents"): string {
  for (const s of samples) {
    const it = s.items.find((x) => x.group === group);
    if (it?.detail) return it.detail;
  }
  return group === "skills" ? "skill descriptions" : "user agents";
}

/** Sum the reducible attachment tokens (everything the fix could remove), per sample. */
export function reducibleTotal(sample: StartupSample): number {
  return sample.items.reduce((n, it) => n + (it.reducible ? it.tokens : 0), 0);
}
