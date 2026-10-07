import { sep } from "node:path";
import { classifyCommand, SessionEdits } from "../phantom.js";
import type { ActivityTurn } from "../types.js";
import { readJsonl, toMs } from "./util.js";

/**
 * Splits a Claude Code session file into user turns for `nerf-watch phantom`.
 *
 * Record shapes used:
 * - type "user" with string content or text blocks, not isMeta, not
 *   isCompactSummary, and origin.kind "human" (or no origin.kind on older
 *   versions): a user prompt, which starts a turn. Prompt text is never kept.
 *   Records with origin.kind "task-notification", "peer" or "coordinator"
 *   (background task results, subagent hand-backs) continue the current turn.
 * - "[Request interrupted by user" text, or a tool_result saying the user did
 *   not want to proceed: the turn is incomplete.
 * - type "assistant": message.content blocks. tool_use blocks are actions
 *   (name, input.command for Bash); text blocks after the last tool_use form
 *   the final message. message.model "<synthetic>" with isApiErrorMessage is
 *   an API error. message.id + requestId identify the response.
 * - Subagent transcripts (<session>/subagents/*.jsonl) and isSidechain records
 *   are skipped: their "user" is another agent.
 */

/** Tools that change files. */
export const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools that cannot change files. Every other tool counts as a possible edit. */
export const CLAUDE_READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "TodoWrite",
  "TodoRead",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "BashOutput",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ListAgents",
  "ReadNotifications",
]);

const SHELL_TOOLS = new Set(["Bash", "bash"]);

export async function parseClaudeActivity(file: string): Promise<{ turns: ActivityTurn[]; badLines: number }> {
  if (file.includes(`${sep}subagents${sep}`) || file.includes("/subagents/")) return { turns: [], badLines: 0 };
  const turns: ActivityTurn[] = [];
  let badLines = 0;
  // Assigned inside close(), so declared without narrowing to null.
  let cur = null as ActivityTurn | null;
  let version: string | undefined;
  const edits = new SessionEdits();

  const open = (): ActivityTurn => ({
    agent: "claude",
    file,
    line: 0,
    timestamp: 0,
    finalMessage: "",
    toolCalls: 0,
  });
  const close = () => {
    edits.finish(cur);
    if (cur && (cur.toolCalls > 0 || cur.finalMessage || cur.incomplete)) turns.push(cur);
    cur = null;
  };

  // Tool results are large and only matter when they record a rejection; they are never JSON-parsed.
  const filter = (l: string) => {
    if (l.includes('"tool_result"') && l.includes('"type":"user"')) {
      if ((l.includes("doesn't want to proceed") || l.includes("[Request interrupted by user")) && cur) cur.incomplete = true;
      return false;
    }
    return l.includes('"type":"user"') || l.includes('"type":"assistant"');
  };

  for await (const r of readJsonl(file, filter)) {
    if ("bad" in r) {
      badLines++;
      continue;
    }
    const o = r.value;
    if (!o || typeof o !== "object" || o.isSidechain === true) continue;
    if (typeof o.version === "string") version = o.version;

    if (o.type === "user") {
      const content = o.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) continue;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text)
                .join("\n")
            : "";
      if (text.startsWith("[Request interrupted by user")) {
        if (cur) cur.incomplete = true;
        continue;
      }
      if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) continue;
      const kind = o.origin && typeof o.origin === "object" ? o.origin.kind : undefined;
      if (kind !== undefined && kind !== "human") continue;
      if (text.includes("<local-command-stdout>") || text.includes("<local-command-caveat>")) continue;
      close();
      cur = open();
      continue;
    }

    if (o.type !== "assistant" || !o.message || typeof o.message !== "object") continue;
    const m = o.message;
    cur ??= open();
    if (m.model === "<synthetic>") {
      if (o.isApiErrorMessage) cur.incomplete = true;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        cur.toolCalls++;
        cur.finalMessage = "";
        const name = typeof b.name === "string" ? b.name : "unknown tool";
        const input = b.input && typeof b.input === "object" ? b.input : {};
        let edit: string | undefined;
        if (CLAUDE_EDIT_TOOLS.has(name)) {
          edit = name;
          edits.file(input.file_path ?? input.notebook_path);
          edits.text(input.new_string);
          edits.text(input.content);
          edits.text(input.new_source);
          if (Array.isArray(input.edits)) for (const e of input.edits) edits.text(e?.new_string);
        } else if (SHELL_TOOLS.has(name)) {
          const v = classifyCommand(input.command);
          if (!v.readOnly) edit = `${name}: ${v.reason ?? "command"}`;
          else if (v.history) cur.viewedHistory = true;
          if (edit) edits.opaque();
        } else if (!CLAUDE_READ_ONLY_TOOLS.has(name)) {
          edit = name;
          edits.opaque();
        }
        if (edit && !cur.editAction) cur.editAction = edit;
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        cur.finalMessage = cur.finalMessage ? `${cur.finalMessage}\n\n${b.text}` : b.text;
        cur.line = r.line;
        cur.timestamp = toMs(o.timestamp) ?? cur.timestamp;
        cur.cliVersion = version;
        cur.model = typeof m.model === "string" ? m.model : cur.model;
        cur.dedupeKey = m.id ? `claude:${m.id}:${o.requestId ?? ""}` : undefined;
      }
    }
  }
  close();
  return { turns, badLines };
}
