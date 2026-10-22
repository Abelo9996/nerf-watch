/**
 * Read-only enumeration of the things an agent loads before you type anything:
 * memory files, MCP servers, skills, plugins, context-injecting hooks, and the
 * effort and model defaults. Nothing here writes, spawns a process or touches
 * the network; it only reads config files. Hook scripts are listed but never
 * executed (running them could have side effects), so their injected size is
 * reported as "not measured here", not guessed.
 *
 * Paths are resolved from a ConfigEnv so tests and `fix`/`undo` trials can point
 * at a temporary HOME instead of the real one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "./tokens.js";

export interface ConfigEnv {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Working directory, for project-level config (project CLAUDE.md, .mcp.json). */
  cwd: string;
}

export function configEnv(over: Partial<ConfigEnv> = {}): ConfigEnv {
  return {
    home: over.home ?? homedir(),
    env: over.env ?? process.env,
    platform: over.platform ?? process.platform,
    cwd: over.cwd ?? process.cwd(),
  };
}

export type SourceKind = "memory" | "mcp" | "skill" | "plugin" | "hook" | "effort" | "model";

export interface ConfigSource {
  agent: string;
  kind: SourceKind;
  /** Stable id, used by `fix --item`. */
  id: string;
  label: string;
  /** Local token estimate, when the text is on disk. Undefined when size is only knowable by measuring. */
  estTokens?: number;
  /** One short line of context for the table. */
  detail: string;
  /** File this source lives in, when it is a single file. */
  path?: string;
  /** Scope for MCP servers and memory: "user" (global) or "project". */
  scope?: "user" | "project";
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readJson(p: string): any | null {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function fileTokens(p: string): number | null {
  const t = readText(p);
  return t === null ? null : estimateTokens(t);
}

// --------------------------------------------------------------- path helpers

export function claudeJsonPath(c: ConfigEnv): string {
  return join(c.home, ".claude.json");
}

/** The user settings file Claude Code loads (settings.json, then settings.local.json overrides). */
export function claudeSettingsPaths(c: ConfigEnv): string[] {
  const dir = c.env.CLAUDE_CONFIG_DIR?.split(/[:;,]/)[0]?.trim() || join(c.home, ".claude");
  return [join(dir, "settings.json"), join(dir, "settings.local.json")];
}

export function claudeDir(c: ConfigEnv): string {
  return c.env.CLAUDE_CONFIG_DIR?.split(/[:;,]/)[0]?.trim() || join(c.home, ".claude");
}

export function userClaudeMdPath(c: ConfigEnv): string {
  return join(claudeDir(c), "CLAUDE.md");
}

export function codexHome(c: ConfigEnv): string {
  return c.env.CODEX_HOME?.split(/[:;,]/)[0]?.trim() || join(c.home, ".codex");
}

// --------------------------------------------------------------- Claude scan

function listDir(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The one-line description a skill contributes to the system prompt listing. */
function skillDescription(skillDir: string): { name: string; tokens: number } | null {
  const md = readText(join(skillDir, "SKILL.md"));
  if (md === null) return null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  const block = fm ? fm[1] : md.slice(0, 400);
  const nameM = /name:\s*(.+)/.exec(block);
  const descM = /description:\s*([\s\S]*?)(?:\n[a-z_]+:|$)/i.exec(block);
  const name = (nameM?.[1] ?? "").trim() || skillDir.split(/[\\/]/).pop() || "skill";
  const desc = (descM?.[1] ?? "").trim();
  // The harness lists "- name: description"; estimate from name plus description.
  return { name, tokens: estimateTokens(`- ${name}: ${desc}`) };
}

export function scanClaude(c: ConfigEnv): ConfigSource[] {
  const out: ConfigSource[] = [];
  const dot = readJson(claudeJsonPath(c));

  // Memory: user, then project.
  const userMd = userClaudeMdPath(c);
  const userTok = fileTokens(userMd);
  if (userTok !== null) {
    out.push({ agent: "claude", kind: "memory", id: "claude:memory:user", label: "User memory (CLAUDE.md)", estTokens: userTok, detail: "~/.claude/CLAUDE.md, loaded in every project", path: userMd, scope: "user" });
  }
  const projMd = join(c.cwd, "CLAUDE.md");
  const projTok = fileTokens(projMd);
  if (projTok !== null) {
    out.push({ agent: "claude", kind: "memory", id: "claude:memory:project", label: "Project memory (CLAUDE.md)", estTokens: projTok, detail: "./CLAUDE.md for this project", path: projMd, scope: "project" });
  }

  // MCP servers: global (~/.claude.json mcpServers), project (.mcp.json), and per-project entries.
  const globalMcp = dot?.mcpServers && typeof dot.mcpServers === "object" ? dot.mcpServers : {};
  for (const name of Object.keys(globalMcp)) {
    out.push({ agent: "claude", kind: "mcp", id: `claude:mcp:user:${name}`, label: `MCP server "${name}"`, detail: "global, loaded in every project; tool schemas sent each request", path: claudeJsonPath(c), scope: "user" });
  }
  const projMcp = readJson(join(c.cwd, ".mcp.json"));
  const projMcpServers = projMcp?.mcpServers && typeof projMcp.mcpServers === "object" ? projMcp.mcpServers : {};
  for (const name of Object.keys(projMcpServers)) {
    out.push({ agent: "claude", kind: "mcp", id: `claude:mcp:project:${name}`, label: `MCP server "${name}" (project)`, detail: "./.mcp.json for this project", path: join(c.cwd, ".mcp.json"), scope: "project" });
  }

  // Skills: each contributes a name + description line to the system prompt.
  const skillsRoot = join(claudeDir(c), "skills");
  const skillDirs = listDir(skillsRoot);
  if (skillDirs.length) {
    let tok = 0;
    let counted = 0;
    for (const d of skillDirs) {
      const s = skillDescription(join(skillsRoot, d));
      if (s) {
        tok += s.tokens;
        counted++;
      }
    }
    out.push({ agent: "claude", kind: "skill", id: "claude:skills", label: `Skills (${skillDirs.length})`, estTokens: tok, detail: `${counted} skill description(s) listed in the system prompt`, path: skillsRoot, scope: "user" });
  }

  // Plugins: only enabled ones cost tokens.
  const enabled = dot?.enabledPlugins && typeof dot.enabledPlugins === "object" ? dot.enabledPlugins : {};
  const enabledNames = Object.entries(enabled).filter(([, v]) => v).map(([k]) => k);
  if (enabledNames.length) {
    out.push({ agent: "claude", kind: "plugin", id: "claude:plugins", label: `Plugins (${enabledNames.length})`, detail: enabledNames.slice(0, 4).join(", ") + (enabledNames.length > 4 ? ", ..." : ""), scope: "user" });
  }

  // Hooks that inject context. Listed, never executed here.
  for (const p of claudeSettingsPaths(c)) {
    const s = readJson(p);
    if (!s?.hooks) continue;
    for (const ev of ["SessionStart", "UserPromptSubmit"]) {
      const groups = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      const cmds: string[] = [];
      for (const g of groups) for (const h of g?.hooks ?? []) if (h?.type === "command" && typeof h.command === "string") cmds.push(h.command);
      if (cmds.length) {
        out.push({
          agent: "claude",
          kind: "hook",
          id: `claude:hook:${ev}`,
          label: `${ev} hook(s) (${cmds.length})`,
          detail: `inject context into every ${ev === "SessionStart" ? "session start" : "prompt"}; size not measured here (scripts are not run)`,
          path: p,
          scope: "user",
        });
      }
    }
    // Effort and model defaults.
    if (typeof s.effortLevel === "string") {
      out.push({ agent: "claude", kind: "effort", id: "claude:effort", label: `Default effort: ${s.effortLevel}`, detail: "reasoning effort applied to every turn", path: p, scope: "user" });
    }
    if (typeof s.model === "string") {
      out.push({ agent: "claude", kind: "model", id: "claude:model", label: `Default model: ${s.model}`, detail: "model used when a session does not pick one", path: p, scope: "user" });
    }
    break; // settings.json is enough; local overrides rarely change these sources
  }
  return out;
}

// --------------------------------------------------------------- Codex scan

/** Minimal TOML read for the keys and section names we need. No dependency. */
function codexConfig(c: ConfigEnv): { text: string | null; path: string } {
  const path = join(codexHome(c), "config.toml");
  return { text: readText(path), path };
}

export function scanCodex(c: ConfigEnv): ConfigSource[] {
  const out: ConfigSource[] = [];
  const agentsMd = join(codexHome(c), "AGENTS.md");
  const tok = fileTokens(agentsMd);
  if (tok !== null) {
    out.push({ agent: "codex", kind: "memory", id: "codex:memory:user", label: "User memory (AGENTS.md)", estTokens: tok, detail: "~/.codex/AGENTS.md, loaded in every session", path: agentsMd, scope: "user" });
  }
  const projAgents = join(c.cwd, "AGENTS.md");
  const ptok = fileTokens(projAgents);
  if (ptok !== null) {
    out.push({ agent: "codex", kind: "memory", id: "codex:memory:project", label: "Project memory (AGENTS.md)", estTokens: ptok, detail: "./AGENTS.md for this project", path: projAgents, scope: "project" });
  }

  const { text, path } = codexConfig(c);
  if (text) {
    const seen = new Set<string>();
    for (const m of text.matchAll(/^\[mcp_servers\.([^.\]]+)/gm)) {
      const name = m[1].replace(/^["']|["']$/g, "");
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ agent: "codex", kind: "mcp", id: `codex:mcp:${name}`, label: `MCP server "${name}"`, detail: "from ~/.codex/config.toml", path, scope: "user" });
    }
    const plugins = [...text.matchAll(/^\[plugins\."([^"]+)"\]/gm)].map((m) => m[1]);
    const enabled = plugins.filter((name) => {
      const re = new RegExp(`\\[plugins\\."${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]\\s*\\n(?:[^\\[]*\\n)*?enabled\\s*=\\s*true`, "m");
      return re.test(text);
    });
    if (enabled.length) {
      out.push({ agent: "codex", kind: "plugin", id: "codex:plugins", label: `Plugins (${enabled.length})`, detail: enabled.slice(0, 4).join(", ") + (enabled.length > 4 ? ", ..." : ""), path, scope: "user" });
    }
    const effort = /^model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(text);
    if (effort) out.push({ agent: "codex", kind: "effort", id: "codex:effort", label: `Default effort: ${effort[1]}`, detail: "model_reasoning_effort in config.toml", path, scope: "user" });
    const model = /^model\s*=\s*["']([^"']+)["']/m.exec(text);
    if (model) out.push({ agent: "codex", kind: "model", id: "codex:model", label: `Default model: ${model[1]}`, detail: "model in config.toml", path, scope: "user" });
  }
  return out;
}

export function scanConfig(c: ConfigEnv, agents?: string[]): ConfigSource[] {
  const want = (a: string) => !agents?.length || agents.includes(a);
  const out: ConfigSource[] = [];
  if (want("claude")) out.push(...scanClaude(c));
  if (want("codex")) out.push(...scanCodex(c));
  return out;
}
