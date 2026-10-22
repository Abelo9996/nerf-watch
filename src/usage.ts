/**
 * Usage counting from the logs: how often each skill and each subagent was
 * actually invoked over a window. A skill the agent never reaches for still
 * costs tokens on every startup (its one-line description sits in the system
 * prompt); a subagent type you never spawn costs its line in the agent listing.
 *
 * Skills are counted from `Skill` tool_use inputs (input.skill, or input.command
 * for a slash-command invocation). Subagents are counted from `Task` / `Agent`
 * tool_use inputs (input.subagent_type). Built-in subagent types are recorded
 * too, but `fix` only ever proposes user-provided skills and agents.
 *
 * Reads raw session files, so this is local only, like `phantom`.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { claudeAdapter } from "./adapters/claude.js";
import { readJsonl } from "./adapters/util.js";

export interface UsageCounts {
  /** skill name (directory name for user skills, "plugin:skill" for plugin skills) -> invocations. */
  skills: Map<string, number>;
  /** subagent_type -> invocations. */
  agents: Map<string, number>;
  sessionsScanned: number;
  /** Epoch ms the window started, for display. */
  since: number;
}

export interface ReadUsageOptions {
  roots?: string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Only sessions touched at/after this epoch ms. */
  since?: number;
}

function claudeRoots(opts: ReadUsageOptions): string[] {
  if (opts.roots) return opts.roots;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  return claudeAdapter.defaultRoots({ env, homedir: home, platform: opts.platform ?? process.platform });
}

function bump(m: Map<string, number>, k: unknown): void {
  if (typeof k !== "string" || !k) return;
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Count Skill and subagent invocations across sessions in the window. */
export async function countUsage(opts: ReadUsageOptions = {}): Promise<UsageCounts> {
  const skills = new Map<string, number>();
  const agents = new Map<string, number>();
  const roots = claudeRoots(opts);
  const files = await claudeAdapter.discover(roots);
  let scanned = 0;
  for (const f of files) {
    if (opts.since !== undefined) {
      try {
        if ((await stat(f)).mtimeMs < opts.since) continue;
      } catch {
        continue;
      }
    }
    scanned++;
    const filter = (l: string) => l.includes('"tool_use"') && (l.includes('"Skill"') || l.includes("subagent_type") || l.includes('"Task"') || l.includes('"Agent"'));
    for await (const r of readJsonl(f, filter)) {
      if ("bad" in r) continue;
      const o = r.value;
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || b.type !== "tool_use") continue;
        if (b.name === "Skill") bump(skills, b.input?.skill ?? b.input?.command);
        else if (b.name === "Task" || b.name === "Agent") bump(agents, b.input?.subagent_type);
      }
    }
  }
  return { skills, agents, sessionsScanned: scanned, since: opts.since ?? 0 };
}
