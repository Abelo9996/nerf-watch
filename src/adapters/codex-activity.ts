import { classifyCommand, SessionEdits } from "../phantom.js";
import type { ActivityTurn } from "../types.js";
import { readJsonl, toMs } from "./util.js";

/**
 * Splits a Codex rollout file into user turns for `nerf-watch phantom`.
 *
 * Record shapes used:
 * - session_meta: payload.cli_version; payload.source with "subagent" marks a
 *   spawned thread, which is skipped.
 * - turn_context: payload.model.
 * - event_msg/task_started (payload.turn_id) starts a turn; event_msg/user_message
 *   or event_msg/item_completed with item.type "UserMessage" marks the prompt
 *   (a second prompt without task_started starts a new turn). Prompt text is
 *   never kept.
 * - event_msg/task_complete: payload.last_agent_message is the final message.
 *   event_msg/turn_aborted and event_msg/error make the turn incomplete.
 * - Actions: response_item function_call (exec_command with arguments.cmd,
 *   shell / container.exec with arguments.command, apply_patch, and any other
 *   tool), custom_tool_call (apply_patch), local_shell_call (action.command),
 *   event_msg exec_command_end (command), patch_apply_begin/end, turn_diff,
 *   mcp_tool_call_end, and item_completed items (CommandExecution, FileChange,
 *   McpToolCall, ...).
 * - Text: event_msg/agent_message, response_item message role "assistant",
 *   item_completed AgentMessage. Used when task_complete has no message.
 */

/** Function tools that cannot change files. Every other tool counts as a possible edit. */
export const CODEX_READ_ONLY_TOOLS = new Set([
  "update_plan",
  "view_image",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "read_thread_terminal",
  "wait_agent",
  "web_search",
  "tool_search",
]);

const SHELL_TOOLS = new Set(["exec_command", "shell", "container.exec", "local_shell", "shell_command"]);

/** item_completed item types that are not actions. */
const NEUTRAL_ITEMS = new Set(["UserMessage", "AgentMessage", "Reasoning", "WebSearch", "Plan", "TodoList", "ContextCompaction", "ImageView"]);

/** Large records that never matter here. They are skipped before JSON parsing. */
const SKIP = /"type":\s*"(?:function_call_output|custom_tool_call_output|reasoning|token_count|tool_search_output)"|"type":\s*"compacted"|"role":\s*"(?:user|developer|system)"/;

function parseArgs(a: unknown): any {
  if (typeof a !== "string") return a && typeof a === "object" ? a : {};
  try {
    return JSON.parse(a);
  } catch {
    return {};
  }
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b && typeof b.text === "string" && (b.type === "output_text" || b.type === "text" || b.type === "Text"))
    .map((b: any) => b.text)
    .join("\n");
}

export async function parseCodexActivity(file: string): Promise<{ turns: ActivityTurn[]; badLines: number }> {
  const turns: ActivityTurn[] = [];
  let badLines = 0;
  let version: string | undefined;
  let model: string | undefined;
  let sidechain = false;
  const edits = new SessionEdits();
  type Open = ActivityTurn & { prompted?: boolean; done?: boolean };
  // Assigned inside the helpers below, so declared without narrowing to null.
  let cur = null as Open | null;

  const open = (turnId?: string): Open => {
    cur = { agent: "codex", file, line: 0, timestamp: 0, finalMessage: "", toolCalls: 0, cliVersion: version, model, sidechain };
    if (turnId) cur.dedupeKey = `codex:${turnId}`;
    return cur;
  };
  const close = () => {
    const t = cur;
    cur = null;
    edits.finish(t);
    if (!t) return;
    // A turn with no task_complete counts only if it ended on a message, not mid-action.
    if (!t.done && !t.finalMessage) t.incomplete = true;
    delete t.prompted;
    delete t.done;
    if (t.toolCalls > 0 || t.finalMessage || t.incomplete) turns.push(t);
  };
  /** Count an action. `edit` names a possible edit; unless the caller records its files, its target is unknown. */
  const action = (t: ActivityTurn, edit: string | undefined, history = false, known = false) => {
    t.toolCalls++;
    t.finalMessage = "";
    if (edit && !t.editAction) t.editAction = edit;
    if (edit && !known) edits.opaque();
    if (history) t.viewedHistory = true;
  };
  const patchEvent = (t: ActivityTurn, p: any) => {
    const changes = p.changes;
    const paths = Array.isArray(changes) ? changes.map((c: any) => c?.path) : changes && typeof changes === "object" ? Object.keys(changes) : [];
    if (paths.length) for (const f of paths) edits.file(f);
    edits.text(p.unified_diff);
    action(t, "apply_patch", false, paths.length > 0 || typeof p.unified_diff === "string");
  };
  const shell = (t: ActivityTurn, cmd: unknown, tool: string) => {
    const v = classifyCommand(cmd);
    action(t, v.readOnly ? undefined : `${tool}: ${v.reason ?? "command"}`, v.history);
  };
  const text = (t: ActivityTurn, s: string, line: number, ts: number) => {
    if (!s.trim()) return;
    t.finalMessage = s;
    t.line = line;
    t.timestamp = ts;
  };

  for await (const r of readJsonl(file, (l) => !SKIP.test(l.slice(0, 300)))) {
    if ("bad" in r) {
      badLines++;
      continue;
    }
    const o = r.value;
    if (!o || typeof o !== "object") continue;
    const p = o.payload && typeof o.payload === "object" ? o.payload : {};
    const ts = toMs(o.timestamp) ?? 0;

    if (o.type === "session_meta") {
      if (typeof p.cli_version === "string") version = p.cli_version;
      if (p.source && typeof p.source === "object" && "subagent" in p.source) sidechain = true;
      continue;
    }
    if (o.type === "turn_context") {
      if (typeof p.model === "string") {
        model = p.model;
        if (cur) cur.model = model;
      }
      continue;
    }

    if (o.type === "event_msg") {
      switch (p.type) {
        case "task_started":
          close();
          open(typeof p.turn_id === "string" ? p.turn_id : undefined);
          continue;
        case "user_message":
          if (!cur || cur.prompted) {
            close();
            open();
          }
          cur!.prompted = true;
          continue;
        case "task_complete": {
          const t = cur ?? open(typeof p.turn_id === "string" ? p.turn_id : undefined);
          if (typeof p.last_agent_message === "string" && p.last_agent_message.trim()) text(t, p.last_agent_message, r.line, ts);
          t.done = true;
          close();
          continue;
        }
        case "turn_aborted":
        case "error":
          if (cur) cur.incomplete = true;
          continue;
        case "agent_message":
          if (cur && typeof p.message === "string") text(cur, p.message, r.line, ts);
          continue;
        case "exec_command_end":
          // The matching function_call was already counted; this only adds commands that had none.
          if (cur) {
            const v = classifyCommand(p.command);
            if (!v.readOnly) {
              cur.editAction ??= `exec: ${v.reason ?? "command"}`;
              edits.opaque();
            }
          }
          continue;
        case "patch_apply_begin":
        case "patch_apply_end":
        case "turn_diff":
          if (cur) patchEvent(cur, p);
          continue;
        case "mcp_tool_call_end":
          if (cur) {
            cur.editAction ??= "MCP tool";
            edits.opaque();
          }
          continue;
        case "item_completed": {
          const item = p.item;
          if (!item || typeof item !== "object") continue;
          if (item.type === "UserMessage") {
            if (!cur || cur.prompted) {
              close();
              open(typeof p.turn_id === "string" ? p.turn_id : undefined);
            }
            cur!.prompted = true;
            continue;
          }
          const t = cur ?? open(typeof p.turn_id === "string" ? p.turn_id : undefined);
          if (item.type === "AgentMessage") text(t, assistantText(item.content), r.line, ts);
          else if (item.type === "CommandExecution" && item.command !== undefined) shell(t, item.command, "exec");
          else if (item.type === "FileChange") patchEvent(t, item);
          else if (!NEUTRAL_ITEMS.has(item.type)) action(t, String(item.type ?? "unknown item"));
          continue;
        }
      }
      continue;
    }

    if (o.type === "response_item") {
      const t = cur ?? open();
      switch (p.type) {
        case "message":
          if (p.role === "assistant") text(t, assistantText(p.content), r.line, ts);
          continue;
        case "function_call":
        case "custom_tool_call": {
          const name = typeof p.name === "string" ? p.name : "unknown tool";
          if (name === "apply_patch") {
            const a = p.type === "custom_tool_call" ? p.input : parseArgs(p.arguments).input;
            edits.patch(a);
            action(t, "apply_patch", false, true);
          }
          else if (SHELL_TOOLS.has(name)) {
            const a = parseArgs(p.arguments ?? p.input);
            shell(t, a.cmd ?? a.command, name);
          } else if (name === "write_stdin") {
            // Polling a running command sends no input; typing into it might do anything.
            const a = parseArgs(p.arguments);
            action(t, a.chars ? "write_stdin" : undefined);
          } else action(t, CODEX_READ_ONLY_TOOLS.has(name) ? undefined : name);
          continue;
        }
        case "local_shell_call":
          shell(t, p.action?.command, "local_shell");
          continue;
        case "web_search_call":
        case "tool_search_call":
          action(t, undefined);
          continue;
      }
    }
  }
  close();
  return { turns, badLines };
}
