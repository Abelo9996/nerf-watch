import { adapters } from "./adapters/index.js";

export class UsageError extends Error {}

/** Accepts YYYY-MM-DD, any ISO timestamp, or a relative span like 12h, 7d, 4w. */
export function parseSince(v: string | undefined, now = Date.now()): number | undefined {
  if (v === undefined || v === "") return undefined;
  const rel = /^(\d+)\s*([hdw])$/i.exec(String(v).trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 7 * 86_400_000;
    return now - n * ms;
  }
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new UsageError(`--since: cannot parse "${v}". Use YYYY-MM-DD or a span like 7d, 2w, 12h.`);
  return t;
}

export function parseAgents(v: unknown): string[] | undefined {
  if (v === undefined || v === true) return undefined;
  const list = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
  for (const a of list) {
    if (!adapters.some((ad) => ad.id === a)) {
      throw new UsageError(`--agent: unknown agent "${a}". Known: ${adapters.map((ad) => ad.id).join(", ")}`);
    }
  }
  return list.length ? list : undefined;
}

export function parseRoots(v: unknown): Record<string, string[]> | undefined {
  if (v === undefined) return undefined;
  const out: Record<string, string[]> = {};
  for (const item of Array.isArray(v) ? v : [v]) {
    const s = String(item);
    const i = s.indexOf("=");
    if (i <= 0) throw new UsageError(`--root expects agent=dir, got "${s}"`);
    const agent = s.slice(0, i).trim();
    if (!adapters.some((ad) => ad.id === agent)) {
      throw new UsageError(`--root: unknown agent "${agent}" in "${s}". Known: ${adapters.map((ad) => ad.id).join(", ")}`);
    }
    const dir = s.slice(i + 1).trim();
    if (!dir) throw new UsageError(`--root expects agent=dir, got "${s}"`);
    (out[agent] ??= []).push(dir);
  }
  return out;
}


/** A whole number of days, 1 or more. */
export function parsePositiveInt(flag: string, v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a whole number of days, 1 or more, got "${v}"`);
  return n;
}
