/**
 * Measured attribution: run the agent's own CLI a few times with different
 * flags and read the startup token count from each run, so overhead is
 * attributed to real sources without editing any config file.
 *
 * Only CLI flags are used (--strict-mcp-config, --setting-sources, --mcp-config,
 * --add-dir): nothing in ~/.claude, ~/.claude.json or ~/.codex is changed. The
 * runs use the cheapest model that keeps the system-prompt shape, and the real
 * dollar cost of every run is summed from the CLI's own total_cost_usd.
 *
 * This is implemented for Claude Code, whose flags make clean ablation cheap and
 * reliable. Codex has no equivalent, so `overhead` falls back to config and log
 * evidence for it and says so.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ConfigEnv, claudeJsonPath, userClaudeMdPath } from "./config-scan.js";
import { median } from "./metrics.js";

const pexecFile = promisify(execFile);

export const MEASURE_PROMPT = "Reply with just: ok";
/** Cheapest model that still loads the full system prompt shape. */
export const DEFAULT_MEASURE_MODEL = "claude-haiku-5-5";
export const DEFAULT_REPEATS = 3;

export interface RunResult {
  total: number;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  cost: number;
  ok: boolean;
  error?: string;
}

export interface Profile {
  id: string;
  label: string;
  /** Extra args after the fixed base. */
  args: string[];
  /** Temp directory to run from (empty, so no project config interferes). */
  cwd: string;
}

export interface ProfileResult {
  id: string;
  label: string;
  runs: RunResult[];
  /** Median of the successful runs' totals, or null when all failed. */
  total: number | null;
  cost: number;
}

function claudeBin(c: ConfigEnv): string {
  return c.env.NERF_WATCH_CLAUDE_BIN || "claude";
}

/** One startup run. Total context = input + cache_creation + cache_read. */
export async function runOnce(c: ConfigEnv, model: string, p: Profile, timeoutMs = 120_000): Promise<RunResult> {
  const args = ["-p", MEASURE_PROMPT, "--output-format", "json", "--model", model, ...p.args];
  try {
    const { stdout } = await pexecFile(claudeBin(c), args, {
      cwd: p.cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: c.env,
    });
    const j = JSON.parse(stdout);
    const u = j.usage ?? {};
    const input = Number(u.input_tokens) || 0;
    const cacheCreation = Number(u.cache_creation_input_tokens) || 0;
    const cacheRead = Number(u.cache_read_input_tokens) || 0;
    return {
      total: input + cacheCreation + cacheRead,
      input,
      cacheCreation,
      cacheRead,
      cost: Number(j.total_cost_usd) || 0,
      ok: !j.is_error && input + cacheCreation + cacheRead > 0,
      error: j.is_error ? String(j.result ?? j.subtype ?? "error") : undefined,
    };
  } catch (e) {
    return { total: 0, input: 0, cacheCreation: 0, cacheRead: 0, cost: 0, ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) };
  }
}

/** Build the ablation profiles for Claude, plus the temp dirs they need. Call `cleanup` when done. */
export function planClaudeAblation(c: ConfigEnv): { profiles: Profile[]; cleanup: () => void } {
  const scratch = mkdtempSync(join(tmpdir(), "nerf-measure-"));
  const emptyCwd = join(scratch, "empty");
  mkdirSync(emptyCwd);
  const cleanupPaths = [scratch];
  const profiles: Profile[] = [
    { id: "baseline", label: "Everything on (a normal startup)", args: [], cwd: emptyCwd },
    { id: "no-mcp", label: "No MCP servers", args: ["--strict-mcp-config"], cwd: emptyCwd },
    { id: "no-user", label: "No MCP, no user setting sources", args: ["--strict-mcp-config", "--setting-sources", "project"], cwd: emptyCwd },
  ];

  // One profile per global MCP server, so each server's cost is isolated.
  let dot: any = null;
  try {
    dot = JSON.parse(readFileSync(claudeJsonPath(c), "utf8"));
  } catch {
    dot = null;
  }
  const servers = dot?.mcpServers && typeof dot.mcpServers === "object" ? dot.mcpServers : {};
  for (const name of Object.keys(servers)) {
    const file = join(scratch, `mcp-${name.replace(/[^\w.-]/g, "_")}.json`);
    writeFileSync(file, JSON.stringify({ mcpServers: { [name]: servers[name] } }));
    profiles.push({ id: `mcp:${name}`, label: `Only MCP server "${name}"`, args: ["--strict-mcp-config", "--mcp-config", file], cwd: emptyCwd });
  }

  // User memory, isolated: a temp copy of the memory file added to a run with no user sources.
  try {
    const src = userClaudeMdPath(c);
    const memDir = join(scratch, "mem");
    mkdirSync(memDir);
    copyFileSync(src, join(memDir, "CLAUDE.md"));
    profiles.push({ id: "memory", label: "User memory only (temp copy)", args: ["--strict-mcp-config", "--setting-sources", "project", "--add-dir", memDir], cwd: emptyCwd });
  } catch {
    // no user memory file; skip
  }

  return { profiles, cleanup: () => cleanupPaths.forEach((p) => rmSync(p, { recursive: true, force: true })) };
}

export interface MeasureProgress {
  (done: number, total: number, label: string): void;
}

/** Run every profile `repeats` times. Sequential, so cache state is consistent and cost stays predictable. */
export async function measure(c: ConfigEnv, profiles: Profile[], opts: { model?: string; repeats?: number; onProgress?: MeasureProgress } = {}): Promise<ProfileResult[]> {
  const model = opts.model ?? DEFAULT_MEASURE_MODEL;
  const repeats = opts.repeats ?? DEFAULT_REPEATS;
  const results: ProfileResult[] = [];
  const totalRuns = profiles.length * repeats;
  let done = 0;
  for (const p of profiles) {
    const runs: RunResult[] = [];
    for (let i = 0; i < repeats; i++) {
      runs.push(await runOnce(c, model, p));
      done++;
      opts.onProgress?.(done, totalRuns, p.label);
    }
    const good = runs.filter((r) => r.ok).map((r) => r.total);
    results.push({ id: p.id, label: p.label, runs, total: good.length ? median(good) : null, cost: runs.reduce((s, r) => s + r.cost, 0) });
  }
  return results;
}
