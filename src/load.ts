import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { adapters as allAdapters } from "./adapters/index.js";
import { compareVersions } from "./metrics.js";
import type { ActivityTurn, Adapter, Dataset } from "./types.js";

export interface LoadOptions {
  /** Restrict to these adapter ids. */
  agents?: string[];
  /** Only keep records at or after this epoch ms. */
  since?: number;
  /** Override the log root(s) for an adapter id. */
  roots?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  adapters?: Adapter[];
}

const CONCURRENCY = 8;

/** Session files for one adapter, after the `since` mtime filter. */
async function filesFor(adapter: Adapter, opts: LoadOptions, env: NodeJS.ProcessEnv, home: string) {
  const roots = opts.roots?.[adapter.id] ?? adapter.defaultRoots({ env, homedir: home, platform: process.platform });
  const found = await adapter.discover(roots);
  let files = found;
  if (opts.since !== undefined) {
    // Files untouched since the cutoff cannot contain newer records.
    const keep = await Promise.all(
      files.map(async (f) => {
        try {
          return (await stat(f)).mtimeMs >= opts.since!;
        } catch {
          return false;
        }
      }),
    );
    files = files.filter((_, i) => keep[i]);
  }
  return { roots, found: found.length, files };
}

/** Run `parse` over `files` with bounded concurrency. A file that throws yields undefined. */
async function parseAll<T>(files: string[], parse: (f: string) => Promise<T>): Promise<(T | undefined)[]> {
  const results: (T | undefined)[] = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      try {
        results[i] = await parse(files[i]);
      } catch {
        results[i] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return results;
}

function adapterList(opts: LoadOptions): Adapter[] {
  return (opts.adapters ?? allAdapters).filter((a) => !opts.agents?.length || opts.agents.includes(a.id));
}

export async function loadDataset(opts: LoadOptions = {}): Promise<Dataset> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const ds: Dataset = { turns: [], toolResults: [], events: [], files: {}, badLines: {}, roots: {}, filesFound: {} };

  for (const adapter of adapterList(opts)) {
    const { roots, found, files } = await filesFor(adapter, opts, env, home);
    ds.roots![adapter.id] = roots;
    ds.filesFound![adapter.id] = found;
    ds.files[adapter.id] = files.length;
    ds.badLines[adapter.id] = 0;

    const results = await parseAll(files, (f) => adapter.parseFile(f));
    for (const r of results) {
      if (!r) {
        ds.badLines[adapter.id]++;
        continue;
      }
      ds.badLines[adapter.id] += r.badLines;
      ds.turns.push(...r.turns);
      ds.toolResults.push(...r.toolResults);
      ds.events.push(...r.events);
    }
  }

  // Resumed and forked sessions copy earlier API responses into new files.
  const seen = new Set<string>();
  ds.turns = ds.turns.filter((t) => {
    if (!t.dedupeKey) return true;
    if (seen.has(t.dedupeKey)) return false;
    seen.add(t.dedupeKey);
    return true;
  });

  dropStaleCopies(ds);

  if (opts.since !== undefined) {
    const s = opts.since;
    ds.turns = ds.turns.filter((t) => t.timestamp >= s);
    ds.toolResults = ds.toolResults.filter((t) => t.timestamp >= s);
    ds.events = ds.events.filter((e) => e.timestamp >= s);
  }
  ds.turns.sort((a, b) => a.timestamp - b.timestamp);
  ds.toolResults.sort((a, b) => a.timestamp - b.timestamp);
  ds.events.sort((a, b) => a.timestamp - b.timestamp);
  return ds;
}

/** Number of older CLI versions that must first appear after a record before it counts as a stale copy. */
export const STALE_OLDER_VERSIONS = 3;

/**
 * Some ways of continuing a session (forks, imports, moving a session between
 * machines) copy the earlier conversation into a new file and stamp every
 * copied record with the CLI version that did the copying, while keeping the
 * original timestamps. When the original file is gone, deduplication cannot
 * catch these copies, and they put weeks-old traffic into a new version's
 * baseline. A record is dropped as a stale copy when at least
 * STALE_OLDER_VERSIONS older CLI versions of the same agent were first seen
 * after its timestamp: CLI versions roll out in order, so a genuine record
 * cannot predate several of its predecessors.
 */
export function dropStaleCopies(ds: Dataset): void {
  type R = { agent: string; cliVersion?: string; timestamp: number };
  const all: R[] = [...ds.turns, ...ds.toolResults, ...ds.events];
  const firstSeen = new Map<string, Map<string, number>>();
  for (const r of all) {
    if (!r.cliVersion) continue;
    let m = firstSeen.get(r.agent);
    if (!m) firstSeen.set(r.agent, (m = new Map()));
    const prev = m.get(r.cliVersion);
    if (prev === undefined || r.timestamp < prev) m.set(r.cliVersion, r.timestamp);
  }
  // For each agent: versions in ascending order with their first sighting.
  const ordered = new Map<string, { v: string; first: number }[]>();
  for (const [agent, m] of firstSeen) {
    ordered.set(agent, [...m.entries()].map(([v, first]) => ({ v, first })).sort((a, b) => compareVersions(a.v, b.v)));
  }
  const cache = new Map<string, boolean>();
  const stale = (r: R): boolean => {
    if (!r.cliVersion) return false;
    const list = ordered.get(r.agent);
    if (!list) return false;
    const k = `${r.agent}\u0000${r.cliVersion}\u0000${r.timestamp}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let later = 0;
    for (const e of list) {
      if (compareVersions(e.v, r.cliVersion) >= 0) break;
      if (e.first > r.timestamp && ++later >= STALE_OLDER_VERSIONS) break;
    }
    const res = later >= STALE_OLDER_VERSIONS;
    cache.set(k, res);
    return res;
  };
  ds.turns = ds.turns.filter((t) => !stale(t));
  ds.toolResults = ds.toolResults.filter((t) => !stale(t));
  ds.events = ds.events.filter((e) => !stale(e));
}

export interface ActivityDataset {
  turns: ActivityTurn[];
  /** Session files read per agent. */
  files: Record<string, number>;
  badLines: Record<string, number>;
  roots: Record<string, string[]>;
  filesFound: Record<string, number>;
}

/**
 * Read user turns (prompt through final message) for `nerf-watch phantom`.
 * Same discovery, `since` and `agents` handling as loadDataset. Adapters
 * without `parseActivity` are skipped.
 */
export async function loadActivity(opts: LoadOptions = {}): Promise<ActivityDataset> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const out: ActivityDataset = { turns: [], files: {}, badLines: {}, roots: {}, filesFound: {} };
  for (const adapter of adapterList(opts)) {
    const parse = adapter.parseActivity;
    if (!parse) continue;
    const { roots, found, files } = await filesFor(adapter, opts, env, home);
    out.roots[adapter.id] = roots;
    out.filesFound[adapter.id] = found;
    out.files[adapter.id] = files.length;
    out.badLines[adapter.id] = 0;
    for (const r of await parseAll(files, (f) => parse(f))) {
      if (!r) {
        out.badLines[adapter.id]++;
        continue;
      }
      out.badLines[adapter.id] += r.badLines;
      out.turns.push(...r.turns);
    }
  }
  // Resumed and forked sessions copy earlier turns into new files.
  const seen = new Set<string>();
  out.turns = out.turns.filter((t) => {
    if (!t.dedupeKey) return true;
    if (seen.has(t.dedupeKey)) return false;
    seen.add(t.dedupeKey);
    return true;
  });
  if (opts.since !== undefined) {
    const s = opts.since;
    out.turns = out.turns.filter((t) => t.timestamp >= s);
  }
  out.turns.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
