// Synthetic session logs that mimic the Claude Code and Codex JSONL schemas.
// Used by the test suite and to produce the example output in the README.
// Nothing here comes from real logs: every value is generated.
//
// Usage: node scripts/make-demo-data.mjs <out-dir>
//   then: nerfwatch check --root claude=<out-dir>/claude/projects --root codex=<out-dir>/codex/sessions

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Deterministic PRNG so fixtures and README output are stable. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Value around `mean`, +/- `spread` (fraction). */
const around = (r, mean, spread = 0.25) => Math.max(0, Math.round(mean * (1 + (r() * 2 - 1) * spread)));

let uuidCounter = 0;
export function fakeUuid(prefix = "0000") {
  uuidCounter++;
  return `${prefix.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

export const SENTINEL_PROMPT = "SENTINEL_PROMPT_TEXT_do_not_leak";
export const SENTINEL_CWD = "/home/demo/sentinel-secret-project";

/**
 * One Claude Code session file.
 * @param {object} o
 * @param {string} o.version CLI version
 * @param {string} o.model served model
 * @param {string} [o.requested] model in the session's identity record
 * @param {number} o.start epoch ms
 * @param {number} [o.turns]
 * @param {number} [o.cacheCreation] mean cache-creation tokens per warm turn
 * @param {number} [o.cacheRead] mean cache-read tokens per turn
 * @param {number} [o.firstPrompt] cache-creation tokens on the first turn
 * @param {string} [o.effort]
 * @param {number} [o.toolErrorRate]
 * @param {() => number} [o.r]
 */
export function claudeSession(o) {
  const r = o.r ?? rng(1);
  const sessionId = fakeUuid("c1a0");
  const lines = [];
  const base = { cwd: SENTINEL_CWD, sessionId, version: o.version, gitBranch: "main", userType: "external", entrypoint: "cli", isSidechain: false };
  let t = o.start;
  const ts = () => new Date((t += 20_000 + Math.floor(r() * 40_000))).toISOString();
  lines.push({ type: "permission-mode", permissionMode: "default", sessionId });
  if (o.requested) {
    lines.push({ ...base, type: "attachment", uuid: fakeUuid(), timestamp: ts(), attachment: { type: "model", identity: { modelId: o.requested, marketingName: "Demo", knowledgeCutoff: "2026" } } });
  }
  lines.push({ ...base, type: "user", uuid: fakeUuid(), timestamp: ts(), message: { role: "user", content: SENTINEL_PROMPT } });
  const turns = o.turns ?? 40;
  for (let i = 0; i < turns; i++) {
    const first = i === 0;
    const usage = {
      input_tokens: around(r, 6, 0.5),
      cache_creation_input_tokens: first ? around(r, o.firstPrompt ?? 18000, 0.05) : around(r, o.cacheCreation ?? 900, 0.5),
      cache_read_input_tokens: first ? 0 : around(r, o.cacheRead ?? 40000, 0.3),
      output_tokens: around(r, 350, 0.6),
      output_tokens_details: { thinking_tokens: around(r, 120, 0.6) },
      service_tier: "standard",
    };
    const msgId = `msg_demo_${fakeUuid("aaaa")}`;
    const requestId = `req_demo_${fakeUuid("bbbb")}`;
    const toolId = `toolu_${fakeUuid("cccc")}`;
    const when = ts();
    // Claude Code writes one line per content block; usage repeats on each.
    lines.push({ ...base, type: "assistant", uuid: fakeUuid(), timestamp: when, requestId, effort: o.effort ?? "high", message: { id: msgId, type: "message", role: "assistant", model: o.model, content: [{ type: "thinking", thinking: "" }], usage: { ...usage, output_tokens: 1 } } });
    lines.push({ ...base, type: "assistant", uuid: fakeUuid(), timestamp: when, requestId, effort: o.effort ?? "high", message: { id: msgId, type: "message", role: "assistant", model: o.model, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "echo " + SENTINEL_PROMPT } }], usage } });
    const err = r() < (o.toolErrorRate ?? 0.03);
    lines.push({ ...base, type: "user", uuid: fakeUuid(), timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: err ? "Exit code 1" : "ok " + SENTINEL_CWD, is_error: err }] } });
  }
  lines.push({ type: "ai-title", aiTitle: SENTINEL_PROMPT, sessionId });
  return { sessionId, lines };
}

/**
 * One Codex rollout file.
 * @param {object} o
 * @param {string} o.version
 * @param {string} o.model requested model (turn_context)
 * @param {string} [o.effort]
 * @param {number} o.start
 * @param {number} [o.turns]
 * @param {number} [o.input] mean input tokens incl. cached
 * @param {number} [o.cachedShare]
 * @param {number} [o.contextWindow]
 * @param {number} [o.toolErrorRate]
 * @param {string} [o.servedModel] if set, emits a model_reroute style event
 * @param {() => number} [o.r]
 */
export function codexSession(o) {
  const r = o.r ?? rng(2);
  const id = fakeUuid("c0de");
  const lines = [];
  let t = o.start;
  const ts = () => new Date((t += 15_000 + Math.floor(r() * 30_000))).toISOString();
  const ctx = o.contextWindow ?? 258400;
  lines.push({ timestamp: ts(), type: "session_meta", payload: { id, timestamp: new Date(o.start).toISOString(), cwd: SENTINEL_CWD, originator: "codex-tui", cli_version: o.version, source: "cli", model_provider: "openai", base_instructions: { text: SENTINEL_PROMPT } } });
  const turnId = fakeUuid("7777");
  lines.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_started", turn_id: turnId, model_context_window: ctx } });
  lines.push({ timestamp: ts(), type: "turn_context", payload: { turn_id: turnId, cwd: SENTINEL_CWD, model: o.model, effort: o.effort ?? "medium", summary: "auto", approval_policy: "on-request" } });
  lines.push({ timestamp: ts(), type: "event_msg", payload: { type: "user_message", message: SENTINEL_PROMPT, images: [] } });
  if (o.servedModel) lines.push({ timestamp: ts(), type: "event_msg", payload: { type: "model_reroute", from_model: o.model, to_model: o.servedModel } });
  let total = 0;
  const turns = o.turns ?? 30;
  for (let i = 0; i < turns; i++) {
    const input = i === 0 ? around(r, o.firstPrompt ?? 12000, 0.05) : around(r, o.input ?? 30000, 0.3);
    const cached = i === 0 ? 0 : Math.round(input * (o.cachedShare ?? 0.9) * (0.95 + r() * 0.05));
    const output = around(r, 400, 0.6);
    const reasoning = Math.round(output * 0.4);
    total += input + output;
    const callId = `call_${fakeUuid("dddd")}`;
    lines.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: SENTINEL_PROMPT }), call_id: callId } });
    const err = r() < (o.toolErrorRate ?? 0.03);
    lines.push({ timestamp: ts(), type: "event_msg", payload: { type: "exec_command_end", call_id: callId, exit_code: err ? 1 : 0, status: err ? "failed" : "completed", stdout: SENTINEL_CWD, stderr: "" } });
    const info = {
      total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output },
      model_context_window: ctx,
    };
    const when = ts();
    lines.push({ timestamp: when, type: "event_msg", payload: { type: "token_count", info, rate_limits: { plan_type: "plus" } } });
    // Codex sometimes emits the same count twice.
    if (r() < 0.2) lines.push({ timestamp: when, type: "event_msg", payload: { type: "token_count", info, rate_limits: { plan_type: "plus" } } });
  }
  lines.push({ timestamp: ts(), type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: SENTINEL_PROMPT } });
  return { id, lines };
}

const DAY = 86_400_000;

export function toJsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Write a demo scenario with known regressions:
 * - Claude Code 2.1.270 -> 2.1.271 stable, then 2.1.272: cache writes per turn x3 and cache hit rate drops.
 * - A few Claude sessions configured for claude-opus-5 are answered by claude-sonnet-5.
 * - Codex 0.140.0 -> 0.141.0: default effort drops from high to medium.
 * - Codex 0.141.0, last 7 days: context window shrinks from 353.4k to 258.4k with no CLI change.
 */
export function writeDemo(dir, end = Date.UTC(2026, 9, 2, 18)) {
  uuidCounter = 0;
  const r = rng(7);
  const claudeDir = join(dir, "claude", "projects", "-home-demo-project");
  const codexRoot = join(dir, "codex", "sessions");
  mkdirSync(claudeDir, { recursive: true });
  const day = (n) => end - n * DAY;

  const claudePlan = [
    { version: "2.1.270", from: 40, to: 28, n: 10, cacheCreation: 900, cacheRead: 42000 },
    { version: "2.1.271", from: 27, to: 15, n: 10, cacheCreation: 950, cacheRead: 42000 },
    { version: "2.1.272", from: 14, to: 0, n: 12, cacheCreation: 2900, cacheRead: 12000 },
  ];
  for (const p of claudePlan) {
    for (let i = 0; i < p.n; i++) {
      const start = day(p.from - ((p.from - p.to) * i) / p.n);
      const mismatch = p.version === "2.1.272" && i % 4 === 0;
      const s = claudeSession({ version: p.version, model: mismatch ? "claude-sonnet-5" : "claude-opus-5", requested: "claude-opus-5", start, turns: 40, cacheCreation: p.cacheCreation, cacheRead: p.cacheRead, r });
      writeFileSync(join(claudeDir, `${s.sessionId}.jsonl`), toJsonl(s.lines));
    }
  }

  const codexPlan = [
    { version: "0.140.0", from: 40, to: 21, n: 8, effort: "high", ctx: 353400 },
    { version: "0.141.0", from: 20, to: 8, n: 8, effort: "medium", ctx: 353400 },
    { version: "0.141.0", from: 6, to: 0, n: 8, effort: "medium", ctx: 258400 },
  ];
  for (const p of codexPlan) {
    for (let i = 0; i < p.n; i++) {
      const start = day(p.from - ((p.from - p.to) * i) / p.n);
      const d = new Date(start);
      const sub = join(codexRoot, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
      mkdirSync(sub, { recursive: true });
      const s = codexSession({ version: p.version, model: "gpt-5.5", effort: p.effort, start, turns: 30, contextWindow: p.ctx, r });
      writeFileSync(join(sub, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, "-")}-${s.id}.jsonl`), toJsonl(s.lines));
    }
  }
  return { claudeRoot: join(dir, "claude", "projects"), codexRoot };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node scripts/make-demo-data.mjs <out-dir>");
    process.exit(2);
  }
  const { claudeRoot, codexRoot } = writeDemo(out);
  console.log(`Wrote synthetic logs.\n  nerfwatch check --root claude=${claudeRoot} --root codex=${codexRoot}`);
}
