/**
 * `nerf-watch fix`: turn the overhead table into reversible changes.
 *
 * Every change is reversible and never destructive. An MCP server is disabled
 * (stashed under a nerf-watch key), not deleted. A bulky memory section is moved
 * into an on-demand file and replaced with a pointer, not dropped. Hooks are
 * never edited: their injected output is flagged with its cost and left alone.
 * Credentials are never touched.
 *
 * Before any file is modified it is backed up verbatim, and `nerf-watch undo`
 * restores every touched file byte for byte. Dry run is the default; nothing is
 * written without --apply and an explicit selection.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ConfigEnv, type ConfigSource, claudeDir, claudeJsonPath } from "./config-scan.js";
import { estimateTokens, fmtTokensApprox } from "./tokens.js";
import type { Attribution } from "./overhead.js";

/** A single file change within a fix item. `transform` is applied to the current file text. */
export interface FixChange {
  path: string;
  summary: string;
  /** Returns the new file text, or null to leave it unchanged. For a new file, `before` is null. */
  transform: (before: string | null) => string | null;
  /** True when the change creates a file that did not exist. */
  creates?: boolean;
}

export interface FixItem {
  id: string;
  agent: string;
  title: string;
  description: string;
  /** "edit" items change files; "advice" items only explain (hooks, tool search). */
  kind: "edit" | "advice";
  /** Estimated tokens saved per request, when known. */
  estTokensSaved?: number;
  changes: FixChange[];
  caveat?: string;
}

const MEMORY_SECTION_MIN_TOKENS = 400;

function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Largest top-level `## heading` section of a markdown file, if it is big enough to be worth moving. */
function bulkiestSection(md: string): { heading: string; slug: string; body: string; tokens: number } | null {
  const lines = md.split("\n");
  const sections: { heading: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      if (sections.length) sections[sections.length - 1].end = i;
      sections.push({ heading: lines[i].replace(/^##\s+/, "").trim(), start: i, end: lines.length });
    }
  }
  let best: { heading: string; slug: string; body: string; tokens: number } | null = null;
  for (const s of sections) {
    const body = lines.slice(s.start, s.end).join("\n").trim();
    const tokens = estimateTokens(body);
    if (tokens >= MEMORY_SECTION_MIN_TOKENS && (!best || tokens > best.tokens)) {
      const slug = s.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "section";
      best = { heading: s.heading, slug, body, tokens };
    }
  }
  return best;
}

/**
 * Build the list of reversible fixes for the real setup. Token-saved figures
 * come from the measured attribution when available, otherwise from the local
 * config estimate. Pure: no files are read or written beyond the config scan
 * the caller already did, except reading memory files to size their sections.
 */
export function buildFixItems(cfg: ConfigEnv, sources: ConfigSource[], attribution?: Attribution | null): FixItem[] {
  const items: FixItem[] = [];
  const measured = new Map<string, number>();
  for (const r of attribution?.rows ?? []) measured.set(r.source, r.tokens);

  // 1. MCP servers (global, Claude): disable by stashing under a nerf-watch key.
  for (const s of sources.filter((x) => x.agent === "claude" && x.kind === "mcp" && x.scope === "user")) {
    const name = s.id.slice("claude:mcp:user:".length);
    const saved = measured.get(`MCP server "${name}"`);
    items.push({
      id: `disable-mcp:${name}`,
      agent: "claude",
      title: `Disable the global MCP server "${name}"`,
      description:
        `Its tool schemas are sent on every request in every project. Disabling stashes the server under a nerf-watch key in ~/.claude.json ` +
        `(it is not deleted); undo re-enables it. Re-enable it per project with .mcp.json where you actually use it.`,
      kind: "edit",
      estTokensSaved: saved,
      changes: [
        {
          path: claudeJsonPath(cfg),
          summary: `Move mcpServers["${name}"] to _nerfWatchDisabled.mcpServers in ~/.claude.json`,
          transform: (before) => disableMcpServer(before, name),
        },
      ],
      caveat: "If a project depends on this server, add it back there with a project .mcp.json.",
    });
  }

  // 2. Bulky memory section (Claude user CLAUDE.md): move to an on-demand file with a pointer.
  const userMem = sources.find((x) => x.id === "claude:memory:user");
  if (userMem?.path) {
    const md = readText(userMem.path);
    const section = md ? bulkiestSection(md) : null;
    if (md && section) {
      const onDemand = join(claudeDir(cfg), "memory", `${section.slug}.md`);
      items.push({
        id: `trim-memory:${section.slug}`,
        agent: "claude",
        title: `Move the bulky memory section "${section.heading}" out of CLAUDE.md`,
        description:
          `That section is about ${fmtTokensApprox(section.tokens)} loaded in every project. It is moved to ${onDemand.replace(cfg.home, "~")} ` +
          `and replaced with a one-line pointer, so the agent reads it only when it needs it. Undo restores CLAUDE.md and removes the new file.`,
        kind: "edit",
        estTokensSaved: section.tokens,
        changes: [
          { path: onDemand, creates: true, summary: `Write the section to ${onDemand.replace(cfg.home, "~")}`, transform: () => section.body + "\n" },
          { path: userMem.path, summary: `Replace the "${section.heading}" section in CLAUDE.md with a pointer`, transform: (b) => replaceSection(b, section.heading, onDemand.replace(cfg.home, "~")) },
        ],
      });
    }
  }

  // 3. Pin the effort level, only when it is not already pinned.
  const hasEffort = sources.some((x) => x.agent === "claude" && x.kind === "effort");
  if (!hasEffort) {
    const settings = join(claudeDir(cfg), "settings.json");
    items.push({
      id: "pin-effort",
      agent: "claude",
      title: "Pin an explicit reasoning effort",
      description: "Your default effort is unset, so it follows the client default and can change under you. Pinning it to \"high\" keeps it steady; undo removes the key.",
      kind: "edit",
      changes: [{ path: settings, summary: 'Set "effortLevel": "high" in settings.json', transform: (b) => setJsonKey(b, "effortLevel", "high") }],
    });
  }

  // 4. Context-injecting hooks: advice only, never edited.
  for (const s of sources.filter((x) => x.agent === "claude" && x.kind === "hook")) {
    items.push({
      id: `hook-${s.id.split(":").pop()}`,
      agent: "claude",
      title: `Review ${s.label}`,
      description:
        `${s.detail}. nerf-watch does not edit hook scripts. If the injected text is large, trim what the hook prints at session start, ` +
        `or move rarely needed context into a file the agent opens on demand.`,
      kind: "advice",
      changes: [],
    });
  }

  // 5. Tool search, when there is MCP overhead to defer.
  const mcpCount = sources.filter((x) => x.kind === "mcp").length;
  if (mcpCount) {
    items.push({
      id: "tool-search",
      agent: "claude",
      title: "Use tool search for MCP tools you use rarely",
      description:
        "Where the agent supports deferred tools, their schemas are fetched on demand instead of sent on every request. " +
        "Keep only the servers you use constantly loaded eagerly, and let the rest load through tool search.",
      kind: "advice",
      changes: [],
    });
  }

  // Edit items first, biggest saving first; advice after.
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "edit" ? -1 : 1;
    return (b.estTokensSaved ?? 0) - (a.estTokensSaved ?? 0);
  });
}

// --------------------------------------------------------------- formatting

import { bold, dim } from "./format.js";

/** The dry-run listing: each item, what it changes, and the exact edits. */
export function formatFixDryRun(items: FixItem[], home: string): string {
  if (!items.length) return "No overhead sources that nerf-watch can fix were found.";
  const tilde = (p: string) => p.replace(home, "~");
  const edits = items.filter((i) => i.kind === "edit");
  const advice = items.filter((i) => i.kind === "advice");
  const lines: string[] = [bold("Reversible fixes (dry run; nothing is written)")];
  for (const i of edits) {
    const saved = i.estTokensSaved ? ` (~${fmtTokensApprox(i.estTokensSaved)}/request)` : "";
    lines.push("", `  [${i.id}]${saved}  ${i.title}`, `    ${i.description}`);
    for (const c of i.changes) lines.push(`    edit: ${c.summary}`, `          in ${tilde(c.path)}`);
    if (i.caveat) lines.push(dim(`    note: ${i.caveat}`));
  }
  if (advice.length) {
    lines.push("", bold("Advice (nerf-watch will not change these for you)"));
    for (const i of advice) lines.push("", `  [${i.id}]  ${i.title}`, `    ${i.description}`);
  }
  lines.push("", dim("Apply selected items: nerf-watch fix --apply --item <id>[,<id>]   Undo: nerf-watch undo"));
  return lines.join("\n");
}

// --------------------------------------------------------------- transforms

function parseJsonLoose(text: string | null): any {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Stash a global MCP server under _nerfWatchDisabled.mcpServers. Returns null if the server is gone. */
export function disableMcpServer(before: string | null, name: string): string | null {
  const j = parseJsonLoose(before);
  if (!j.mcpServers || !(name in j.mcpServers)) return null;
  j._nerfWatchDisabled ??= {};
  j._nerfWatchDisabled.mcpServers ??= {};
  j._nerfWatchDisabled.mcpServers[name] = j.mcpServers[name];
  delete j.mcpServers[name];
  return JSON.stringify(j, null, 2) + "\n";
}

/** Set a top-level key in a JSON settings file. */
export function setJsonKey(before: string | null, key: string, value: unknown): string | null {
  const j = parseJsonLoose(before);
  if (j[key] === value) return null;
  j[key] = value;
  return JSON.stringify(j, null, 2) + "\n";
}

/** Replace a `## heading` section body with a one-line pointer to an on-demand file. */
export function replaceSection(before: string | null, heading: string, pointerPath: string): string | null {
  if (before === null) return null;
  const lines = before.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(lines[i])) start = i;
    else if (start !== -1 && /^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1) return null;
  const pointer = [`## ${heading}`, "", `Moved out of this file to keep startup small. Read \`${pointerPath}\` when you need it.`, ""];
  return [...lines.slice(0, start), ...pointer, ...lines.slice(end)].join("\n");
}

// --------------------------------------------------------------- apply / undo

export interface BackupEntry {
  path: string;
  /** Original bytes, base64; null when the file did not exist before (a created file). */
  originalBase64: string | null;
  sha256: string | null;
}

export interface BackupSet {
  schema: "nerf-watch-backup/1";
  createdAt: string;
  items: string[];
  entries: BackupEntry[];
}

export function backupsDir(cfg: ConfigEnv): string {
  return join(claudeDir(cfg), "nerf-watch-backups");
}

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface ApplyResult {
  backupId: string;
  backupPath: string;
  changed: { path: string; summary: string }[];
  skipped: { id: string; reason: string }[];
}

/**
 * Apply the selected items. Backs up every touched file first, then writes.
 * Returns the backup id to pass to `undo`.
 */
export function applyItems(cfg: ConfigEnv, items: FixItem[], selectedIds: string[]): ApplyResult {
  const selected = items.filter((i) => selectedIds.includes(i.id));
  const editItems = selected.filter((i) => i.kind === "edit");
  const skipped: { id: string; reason: string }[] = [];
  for (const i of selected) if (i.kind === "advice") skipped.push({ id: i.id, reason: "advice only, nothing to apply" });

  // Compute the new text for each path, in item order.
  const current = new Map<string, string | null>();
  const createdPaths = new Set<string>();
  const applied: { path: string; summary: string }[] = [];
  const touchedItems: string[] = [];
  for (const item of editItems) {
    let itemChanged = false;
    for (const ch of item.changes) {
      if (!current.has(ch.path)) current.set(ch.path, readText(ch.path));
      if (ch.creates && !existsSync(ch.path)) createdPaths.add(ch.path);
      const next = ch.transform(current.get(ch.path) ?? null);
      if (next === null || next === current.get(ch.path)) continue;
      current.set(ch.path, next);
      applied.push({ path: ch.path, summary: ch.summary });
      itemChanged = true;
    }
    if (itemChanged) touchedItems.push(item.id);
    else skipped.push({ id: item.id, reason: "already applied or nothing to change" });
  }

  const backupId = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(backupsDir(cfg), backupId);
  const touchedPaths = [...new Set(applied.map((a) => a.path))];
  const entries: BackupEntry[] = [];
  for (const p of touchedPaths) {
    const existed = existsSync(p) && !createdPaths.has(p);
    const orig = existed ? readFileSync(p) : null;
    entries.push({ path: p, originalBase64: orig ? orig.toString("base64") : null, sha256: orig ? sha(orig) : null });
  }

  if (touchedPaths.length) {
    mkdirSync(dir, { recursive: true });
    const set: BackupSet = { schema: "nerf-watch-backup/1", createdAt: new Date().toISOString(), items: touchedItems, entries };
    writeFileSync(join(dir, "backup.json"), JSON.stringify(set, null, 2));
    // Write the new file contents.
    for (const p of touchedPaths) {
      const text = current.get(p);
      if (text === null || text === undefined) continue;
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    }
  }

  return { backupId, backupPath: dir, changed: applied, skipped };
}

export interface UndoResult {
  backupId: string;
  restored: string[];
  removed: string[];
  mismatches: string[];
}

/** List backup ids, newest first. */
export function listBackups(cfg: ConfigEnv): string[] {
  try {
    return readdirSync(backupsDir(cfg), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(backupsDir(cfg), e.name, "backup.json")))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Restore every file in a backup set to its original bytes. Files that did not
 * exist before are removed. Pass a backup id or restore the newest set.
 */
export function undo(cfg: ConfigEnv, backupId?: string): UndoResult {
  const id = backupId ?? listBackups(cfg)[0];
  if (!id) throw new Error("No nerf-watch backups to undo.");
  const path = join(backupsDir(cfg), id, "backup.json");
  const set: BackupSet = JSON.parse(readFileSync(path, "utf8"));
  const restored: string[] = [];
  const removed: string[] = [];
  const mismatches: string[] = [];
  for (const e of set.entries) {
    if (e.originalBase64 === null) {
      // The file was created by the fix; remove it to return to the original state.
      if (existsSync(e.path)) rmSync(e.path);
      removed.push(e.path);
      continue;
    }
    const buf = Buffer.from(e.originalBase64, "base64");
    writeFileSync(e.path, buf);
    if (e.sha256 && sha(buf) !== e.sha256) mismatches.push(e.path);
    restored.push(e.path);
  }
  return { backupId: id, restored, removed, mismatches };
}
