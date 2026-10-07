import { dirname, join, sep } from "node:path";
import { normalizeModel } from "../metrics.js";
import type { Adapter, AgentEvent, DiscoverOptions, ParsedFile, ToolResult, Turn } from "../types.js";
import { parseClaudeActivity } from "./claude-activity.js";
import { findFiles, num, readJsonl, sessionKeyFor, splitPathList, toMs, workloadKeyFor } from "./util.js";

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
 *   identity record. The model picker can also set effort, so later turns
 *   count as user-chosen effort.
 * - "<command-name>/effort<": the user set the effort level; later turns in the
 *   file are not evidence of the default.
 * - entrypoint (cli, claude-desktop, ...) and the project directory form the
 *   workload key. message.stop_reason marks the final line of a response;
 *   responses that never got one have a partial output count.
 *
 * When the user switches models outside a recorded /model command (for example
 * from the desktop app), the served model changes one or two responses before
 * the identity record catches up. Mismatched turns that the next identity
 * record confirms are treated as part of the switch, not as a mismatch.
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
    // <root>/<project>/<session>.jsonl or <root>/<project>/<session>/subagents/<agent>.jsonl
    const projectDir = fileIsSubagent ? dirname(dirname(dirname(file))) : dirname(file);
    const turnsByKey = new Map<string, Turn>();
    const stopped = new Set<Turn>();
    const turns: Turn[] = [];
    const toolResults: ToolResult[] = [];
    const events: AgentEvent[] = [];
    let badLines = 0;
    let requested: string | undefined;
    let lastServed: string | undefined;
    let sawFirst = false;
    let userEffort = false;
    let client: string | undefined;
    // Main-thread turns whose served model differs from the requested one since the last identity record.
    let unconfirmed: Turn[] = [];

    const filter = (l: string) =>
      l.includes('"assistant"') ||
      l.includes('"tool_result"') ||
      l.includes('"model_consent_fallback"') ||
      l.includes('"compact_boundary"') ||
      l.includes('"identity"') ||
      l.includes("command-name>/model<") ||
      l.includes("command-name>/effort<");

    for await (const r of readJsonl(file, filter)) {
      if ("bad" in r) {
        badLines++;
        continue;
      }
      const o = r.value;
      if (!o || typeof o !== "object") continue;
      const ts = toMs(o.timestamp) ?? 0;
      const version: string | undefined = typeof o.version === "string" ? o.version : undefined;
      if (typeof o.entrypoint === "string" && o.entrypoint) client = o.entrypoint;
      const workloadKey = workloadKeyFor("claude", projectDir, client);

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
        const hasStop = typeof m.stop_reason === "string" && m.stop_reason !== "";
        const existing = key !== ":" ? turnsByKey.get(key) : undefined;
        if (existing) {
          // Later lines of the same response carry the final output count.
          existing.usage.output = Math.max(existing.usage.output, usage.output);
          if (usage.reasoning !== undefined) existing.usage.reasoning = Math.max(existing.usage.reasoning ?? 0, usage.reasoning);
          if (hasStop) stopped.add(existing);
          continue;
        }
        // Placeholder records with no token counts are not API responses.
        if (usage.input + usage.cacheRead + usage.cacheCreation + usage.output === 0) continue;
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
          workloadKey,
        };
        if (userEffort && !sidechain) t.effortSetByUser = true;
        if (hasStop) stopped.add(t);
        if (!sidechain && !sawFirst) {
          t.firstInSession = true;
          sawFirst = true;
        }
        if (!sidechain && t.requestedModel && model && normalizeModel(t.requestedModel) !== normalizeModel(model)) unconfirmed.push(t);
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
              workloadKey,
              sidechain: fileIsSubagent || o.isSidechain === true,
            });
          }
        }
        continue;
      }

      if (o.type === "user" || o.type === "system") {
        const cmd = slashCommand(o);
        if (cmd === "/model") {
          // The user ran /model. The log records the new choice only as a display
          // name, so stop comparing until the next identity record.
          requested = undefined;
          unconfirmed = [];
          userEffort = true;
          continue;
        }
        if (cmd === "/effort") {
          userEffort = true;
          continue;
        }
      }

      if (o.type === "attachment" && o.attachment?.type === "model") {
        const id = o.attachment.identity?.modelId;
        if (typeof id === "string" && id) {
          const next = normalizeModel(id);
          for (const t of unconfirmed) if (t.servedModel && normalizeModel(t.servedModel) === next) t.requestedModel = undefined;
          unconfirmed = [];
          requested = id;
        }
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
    // Only mark partial output when this file records stop reasons at all.
    if (stopped.size) for (const t of turns) if (!stopped.has(t)) t.partial = true;
    return { turns, toolResults, events, badLines };
  },

  parseActivity: parseClaudeActivity,
};

function slashCommand(o: any): string | undefined {
  const c = typeof o.message?.content === "string" ? o.message.content : typeof o.content === "string" ? o.content : "";
  if (c.includes("<command-name>/model<")) return "/model";
  if (c.includes("<command-name>/effort<")) return "/effort";
  return undefined;
}
