import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Recursively list files ending in `ext` under each root. Missing roots are ignored. */
export async function findFiles(roots: string[], ext = ".jsonl", maxDepth = 8): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(ext) && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  for (const r of roots) await walk(r, 0);
  return out.sort();
}

export async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Stream a file line by line. Lines that fail `filter` are never JSON-parsed. */
export async function* readJsonl(
  file: string,
  filter?: (line: string) => boolean,
): AsyncGenerator<{ value: any } | { bad: true }> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (filter && !filter(line)) continue;
    try {
      yield { value: JSON.parse(line) };
    } catch {
      yield { bad: true };
    }
  }
}

/** Opaque, non-reversible key for a session file. Never printed. */
export function sessionKeyFor(agent: string, file: string): string {
  return agent + ":" + createHash("sha256").update(file).digest("hex").slice(0, 16);
}

export function toMs(ts: unknown): number | undefined {
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Split an env var that may hold one or more paths (comma or the OS path delimiter). */
export function splitPathList(v: string | undefined, delimiter: string): string[] {
  if (!v) return [];
  return v
    .split(delimiter === ";" ? /[;,]/ : /[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Opaque, non-reversible key for a workload (project directory plus client). Never printed. */
export function workloadKeyFor(agent: string, project: string, client: string | undefined): string {
  return agent + ":w:" + createHash("sha256").update(`${project}\u0000${client ?? ""}`).digest("hex").slice(0, 16);
}
