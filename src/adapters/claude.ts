import { join, sep } from "node:path";
import type { Adapter, AgentEvent, DiscoverOptions, ParsedFile, ToolResult, Turn } from "../types.js";
import { findFiles, num, readJsonl, sessionKeyFor, splitPathList, toMs } from "./util.js";

/**
 * Claude Code writes one JSONL file per session under
 * <config>/projects/<encoded-project>/<session>.jsonl, with subagent
 * transcripts under <session>/subagents/*.jsonl.
 *
 * Record shapes used (all other records are skipped without parsing):
 * - type "assistant": message.model, message.id, requestId, message.usage
 *   { input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *   output_tokens, output_tokens_details.thinking_tokens }, version, effort,
 *   isSidechain, timestamp. One API response is split across several lines
 *   (one per content block) that repeat the same usage, so lines are merged
 *   by message.id + requestId.
 * - model "<synthetic>" with isApiErrorMessage: a client-side error stub.
 * - type "user" with message.content[].type "tool_result" and is_error.
 * - type "attachment" with attachment.type "model": identity.modelId is the
 *   model the session is configured to use.
 * - type "system" subtype "model_consent_fallback": originalModel -> fallbackModel.
 * - type "system" subtype "compact_boundary": compactMetadata.preTokens, trigger.
 * - a user or local_command record containing "<command-name>/model<": the user
 *   switched models by hand, so the requested model is unknown until the next
 *   identity record.
 */
export const claudeAdapter: Adapter = {
  id: "claude",
  displayName: "Claude Code",

  defaultRoots({ env, homedir, platform }: DiscoverOptions): string[] {
    const delim = platform === "win32" ? ";" : ":";
    const fromEnv = splitPathList(env.CLAUDE_CONFIG_DIR, delim);
    if (fromEnv.length) return fromEnv.map((d) => join(d, "projects"));
    const xdg = env.XDG_CONFIG_HOME || join(homedir, ".config");
    return [join(homedir, ".claude", "projects"), join(xdg, "claude", "projects")];
  },

  discover(roots: string[]): Promise<string[]> {
    return findFiles(roots, ".jsonl", 4);
  },

  async parseFile(file: string): Promise<ParsedFile & { badLines: number }> {
    const sessionKey = sessionKeyFor("claude", file);
    const fileIsSubagent = file.includes(`${sep}subagents${sep}`) || file.includes("/subagents/");
    const turnsByKey = new Map<string, Turn>();
    const turns: Turn[] = [];
    const toolResults: ToolResult[] = [];
    const events: AgentEvent[] = [];
    let badLines = 0;
    let requested: string | undefined;
    let lastServed: string | undefined;
    let sawFirst = false;

    const filter = (l: string) =>
      l.includes('"assistant"') ||
      l.includes('"tool_result"') ||
      l.includes('"model_consent_fallback"') ||
      l.includes('"compact_boundary"') ||
      l.includes('"identity"') ||
      l.includes("command-name>/model<");

    for await (const r of readJsonl(file, filter)) {
      if ("bad" in r) {
        badLines++;
        continue;
      }
      const o = r.value;
      if (!o || typeof o !== "object") continue;
      const ts = toMs(o.timestamp) ?? 0;
      const version: string | undefined = typeof o.version === "string" ? o.version : undefined;

      if (o.type === "assistant" && o.message && typeof o.message === "object") {
        const m = o.message;
        const model: string | undefined = typeof m.model === "string" ? m.model : undefined;
        if (model === "<synthetic>") {
          if (o.isApiErrorMessage) events.push({ kind: "api_error", agent: "claude", timestamp: ts, cliVersion: version, model: requested });
          continue;
        }
        const u = m.usage;
        if (!u || typeof u !== "object") continue;
        const key = `${m.id ?? ""}:${o.requestId ?? ""}`;
        const usage = {
          input: num(u.input_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheCreation: num(u.cache_creation_input_tokens),
          output: num(u.output_tokens),
          reasoning: u.output_tokens_details ? num(u.output_tokens_details.thinking_tokens) : undefined,
        };
        const existing = key !== ":" ? turnsByKey.get(key) : undefined;
        if (existing) {
          // Later lines of the same response carry the final output count.
          existing.usage.output = Math.max(existing.usage.output, usage.output);
          if (usage.reasoning !== undefined) existing.usage.reasoning = Math.max(existing.usage.reasoning ?? 0, usage.reasoning);
          continue;
        }
        const sidechain = fileIsSubagent || o.isSidechain === true;
        const t: Turn = {
          agent: "claude",
          sessionKey,
          dedupeKey: key !== ":" ? `claude:${key}` : undefined,
          timestamp: ts,
          cliVersion: version,
          requestedModel: sidechain ? undefined : requested,
          servedModel: model,
          effort: typeof o.effort === "string" ? o.effort : undefined,
          usage,
          sidechain,
        };
        if (!sidechain && !sawFirst) {
          t.firstInSession = true;
          sawFirst = true;
        }
        if (model) lastServed = model;
        if (key !== ":") turnsByKey.set(key, t);
        turns.push(t);
        continue;
      }

      if (o.type === "user" && o.message && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (b && b.type === "tool_result") {
            toolResults.push({
              agent: "claude",
              sessionKey,
              timestamp: ts,
              cliVersion: version,
              model: lastServed,
              isError: b.is_error === true,
            });
          }
        }
        continue;
      }

      if ((o.type === "user" || o.type === "system") && isModelCommand(o)) {
        // The user ran /model. The log records the new choice only as a display
        // name, so stop comparing until the next identity record.
        requested = undefined;
        continue;
      }

      if (o.type === "attachment" && o.attachment?.type === "model") {
        const id = o.attachment.identity?.modelId;
        if (typeof id === "string" && id) requested = id;
        continue;
      }

      if (o.type === "system" && o.subtype === "model_consent_fallback") {
        if (typeof o.originalModel === "string" && typeof o.fallbackModel === "string") {
          events.push({
            kind: "fallback",
            agent: "claude",
            timestamp: ts,
            cliVersion: version,
            fromModel: o.originalModel,
            toModel: o.fallbackModel,
          });
          requested = o.fallbackModel;
        }
        continue;
      }

      if (o.type === "system" && o.subtype === "compact_boundary") {
        const cm = o.compactMetadata;
        const pre = num(cm?.preTokens);
        if (pre > 0) {
          events.push({
            kind: "compaction",
            agent: "claude",
            timestamp: ts,
            cliVersion: version,
            model: lastServed,
            preTokens: pre,
            auto: cm?.trigger === "auto",
          });
        }
      }
    }
    return { turns, toolResults, events, badLines };
  },
};

function isModelCommand(o: any): boolean {
  const c = typeof o.message?.content === "string" ? o.message.content : typeof o.content === "string" ? o.content : "";
  return c.includes("<command-name>/model<");
}
