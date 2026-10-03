import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { adapters as allAdapters } from "./adapters/index.js";
import { compareVersions } from "./metrics.js";
import type { Adapter, Dataset, ParsedFile } from "./types.js";

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

export async function loadDataset(opts: LoadOptions = {}): Promise<Dataset> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const list = (opts.adapters ?? allAdapters).filter((a) => !opts.agents?.length || opts.agents.includes(a.id));
  const ds: Dataset = { turns: [], toolResults: [], events: [], files: {}, badLines: {} };

  for (const adapter of list) {
    const roots = opts.roots?.[adapter.id] ?? adapter.defaultRoots({ env, homedir: home, platform: process.platform });
    let files = await adapter.discover(roots);
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
    ds.files[adapter.id] = files.length;
    ds.badLines[adapter.id] = 0;

    const results: (ParsedFile & { badLines: number })[] = new Array(files.length);
    let next = 0;
    async function worker() {
      while (next < files.length) {
        const i = next++;
        try {
          results[i] = await adapter.parseFile(files[i]);
        } catch {
          ds.badLines[adapter.id]++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

    for (const r of results) {
      if (!r) continue;
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
