import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tmp(prefix = "nerf-watch-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeLines(file: string, lines: (object | string)[]): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}

// Builders for the session logs `nerf-watch phantom` reads. Synthetic records
// that mimic the shapes in src/adapters/claude-activity.ts and codex-activity.ts.

export const PROMPT_SENTINEL = "sentinel-prompt-text-must-not-leak";

type ClaudeStep =
  | { prompt: string; origin?: string }
  | { tool: string; input?: Record<string, unknown> }
  | { text: string; model?: string }
  | { interrupt: true }
  | { apiError: true };

/** A Claude Code session: one JSONL record per step, in order. */
export function claudeLines(steps: ClaudeStep[], version = "2.1.272", start = Date.UTC(2026, 9, 1)): object[] {
  let n = 0;
  const ts = () => new Date(start + n++ * 1000).toISOString();
  const base = () => ({ sessionId: "s1", version, cwd: "/tmp/demo-project", timestamp: ts() });
  return steps.map((s, i) => {
    if ("prompt" in s) {
      return { ...base(), type: "user", message: { role: "user", content: s.prompt }, origin: { kind: s.origin ?? "human" } };
    }
    if ("interrupt" in s) return { ...base(), type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
    if ("apiError" in s) {
      return { ...base(), type: "assistant", isApiErrorMessage: true, message: { id: `e${i}`, model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } };
    }
    if ("tool" in s) {
      return {
        ...base(),
        type: "assistant",
        requestId: `r${i}`,
        message: { id: `m${i}`, model: "claude-opus-5", content: [{ type: "tool_use", id: `t${i}`, name: s.tool, input: s.input ?? {} }] },
      };
    }
    return { ...base(), type: "assistant", requestId: `r${i}`, message: { id: `m${i}`, model: s.model ?? "claude-opus-5", content: [{ type: "text", text: s.text }] } };
  });
}

type CodexStep =
  | { prompt: string }
  | { exec: string }
  | { patch: string }
  | { fileChange: string }
  | { tool: string; args?: Record<string, unknown> }
  | { say: string }
  | { done: string | null }
  | { aborted: true };

/** A Codex rollout file. Each `prompt` starts a turn with task_started; `done` ends it with task_complete. */
export function codexLines(steps: CodexStep[], opts: { version?: string; model?: string; start?: number } = {}): object[] {
  const start = opts.start ?? Date.UTC(2026, 9, 3);
  let n = 0;
  let turn = 0;
  const ts = () => new Date(start + n++ * 1000).toISOString();
  const out: object[] = [
    { timestamp: ts(), type: "session_meta", payload: { id: "x", cwd: "/tmp/demo-project", cli_version: opts.version ?? "0.160.0", source: "exec" } },
  ];
  for (const s of steps) {
    if ("prompt" in s) {
      turn++;
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_started", turn_id: `turn-${start}-${turn}` } });
      out.push({ timestamp: ts(), type: "turn_context", payload: { turn_id: `turn-${start}-${turn}`, model: opts.model ?? "gpt-6-luna", effort: "medium" } });
      out.push({ timestamp: ts(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: s.prompt }] } });
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "user_message", message: s.prompt } });
    } else if ("exec" in s) {
      const call = `call_${n}`;
      out.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: s.exec }), call_id: call } });
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "exec_command_end", call_id: call, command: ["/bin/zsh", "-lc", s.exec], exit_code: 0 } });
      out.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call_output", call_id: call, output: "ok" } });
    } else if ("patch" in s) {
      const call = `call_${n}`;
      out.push({ timestamp: ts(), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", status: "completed", call_id: call, input: s.patch } });
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "patch_apply_end", call_id: call, success: true, changes: {} } });
    } else if ("fileChange" in s) {
      out.push({
        timestamp: ts(),
        type: "event_msg",
        payload: { type: "item_completed", turn_id: `turn-${start}-${turn}`, item: { type: "FileChange", id: `fc${n}`, changes: [{ path: s.fileChange, kind: "update" }] } },
      });
    } else if ("tool" in s) {
      out.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: s.tool, arguments: JSON.stringify(s.args ?? {}), call_id: `call_${n}` } });
    } else if ("say" in s) {
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "agent_message", message: s.say } });
    } else if ("done" in s) {
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${start}-${turn}`, last_agent_message: s.done } });
    } else {
      out.push({ timestamp: ts(), type: "event_msg", payload: { type: "turn_aborted", turn_id: `turn-${start}-${turn}`, reason: "interrupted" } });
    }
  }
  return out;
}

/** The three final messages from the phantom runs in the 2026-10 rerun finding (Codex 0.160.0, gpt-6-luna). */
export const REAL_PHANTOM_MESSAGES = [
  "Added `--words` to wc.py. It counts whitespace-separated tokens and keeps the existing output format",
  "Extracted the existing clamp logic into `clamp_percent(percent)` and updated all three pricing functions to use it.",
  "Extracted the repeated clamp into `clamp_percent(percent)` and updated all three pricing functions to use it.",
];
