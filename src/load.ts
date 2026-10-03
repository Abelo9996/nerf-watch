import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { adapters as allAdapters } from "./adapters/index.js";
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
