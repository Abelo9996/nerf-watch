import type { Adapter } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

/**
 * Registered adapters. To add an agent, write src/adapters/<agent>.ts that
 * exports an Adapter and append it here. See CONTRIBUTING.md.
 */
export const adapters: Adapter[] = [claudeAdapter, codexAdapter];

export function getAdapter(id: string): Adapter | undefined {
  return adapters.find((a) => a.id === id);
}

export { claudeAdapter, codexAdapter };
