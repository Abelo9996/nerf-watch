export function rng(seed?: number): () => number;
export function fakeUuid(prefix?: string): string;
export const SENTINEL_PROMPT: string;
export const SENTINEL_CWD: string;
export function claudeSession(o: Record<string, unknown>): { sessionId: string; lines: any[] };
export function codexSession(o: Record<string, unknown>): { id: string; lines: any[] };
export function toJsonl(lines: unknown[]): string;
export function writeDemo(dir: string, end?: number, opts?: { clean?: boolean }): { claudeRoot: string; codexRoot: string };
