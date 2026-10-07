import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeActivity } from "../src/adapters/claude-activity.js";
import { parseCodexActivity } from "../src/adapters/codex-activity.js";
import { loadActivity } from "../src/load.js";
import { analyzePhantoms, classifyCommand, findEditClaim, formatPhantomReport, judgeTurn, truncate } from "../src/phantom.js";
import type { ActivityTurn } from "../src/types.js";
import { claudeLines, codexLines, PROMPT_SENTINEL, REAL_PHANTOM_MESSAGES, tmp, writeLines } from "./helpers.js";

const flagged = (turns: ActivityTurn[]) => turns.filter((t) => { const v = judgeTurn(t); return v.kind === "scanned" && v.phantom; });

describe("classifyCommand", () => {
  it("accepts commands that only read", () => {
    for (const c of [
      "cat wc.py",
      "sed -n '1,120p' pricing.py",
      "rg --files",
      "rg -n \"def clamp\" pricing.py 2>/dev/null",
      "git status --short",
      "git -C repo log --oneline -5",
      "ls -la && pwd",
      "nl -ba wc.py | sed -n '1,40p'",
      "find . -type f -name '*.py'",
      "head -n 20 a.py; tail -5 b.py",
      "grep -c x f 2>&1 | sort | uniq -c",
      "echo done",
      "cd /tmp && wc -l *.py",
    ]) {
      expect(classifyCommand(c).readOnly, c).toBe(true);
    }
    // Codex logs commands as argv arrays wrapped in a login shell.
    expect(classifyCommand(["/bin/zsh", "-lc", "sed -n 1,10p a.py"]).readOnly).toBe(true);
    expect(classifyCommand("/bin/zsh -lc 'cat a.py | head'").readOnly).toBe(true);
    expect(classifyCommand("bash -c 'echo x > a.py'").readOnly).toBe(false);
  });

  it("treats anything that could write as a possible edit", () => {
    for (const c of [
      "echo hi > wc.py",
      "echo hi >> wc.py",
      "printf x | tee wc.py",
      "sed -i 's/a/b/' wc.py",
      "sed -i '' 's/a/b/' wc.py",
      "sed -n '1w out.txt' wc.py",
      "perl -i -pe 's/a/b/' wc.py",
      "python -c \"open('a','w').write('x')\"",
      "python3 - <<'EOF'\nprint(1)\nEOF",
      "cat > wc.py <<EOF\nx\nEOF",
      "mv a.py b.py",
      "cp a.py b.py",
      "rm -f a.py",
      "touch a.py",
      "mkdir -p src",
      "git apply fix.diff",
      "git checkout -- wc.py",
      "git restore wc.py",
      "git commit -am x",
      "patch -p1 < fix.diff",
      "npm install",
      "prettier --write .",
      "find . -name '*.pyc' -delete",
      "find . -name '*.py' -exec sed -i s/a/b/ {} +",
      "rg -l x | xargs sed -i s/a/b/",
      "echo $(touch x)",
      "awk '{print > \"o.txt\"}' f",
      "sort -o out.txt in.txt",
      "some-unknown-tool --flag",
      ["apply_patch", "*** Begin Patch\n*** Update File: a.py\n*** End Patch"],
    ]) {
      expect(classifyCommand(c).readOnly, String(c)).toBe(false);
    }
  });

  it("marks commands that show existing changes", () => {
    expect(classifyCommand("git diff HEAD~1").history).toBe(true);
    expect(classifyCommand("git log -p -3").history).toBe(true);
    expect(classifyCommand("git status").history).toBe(false);
  });
});

describe("findEditClaim", () => {
  it("finds the three real phantom claims", () => {
    expect(findEditClaim(REAL_PHANTOM_MESSAGES[0])).toBe("Added `--words` to wc.py.");
    expect(findEditClaim(REAL_PHANTOM_MESSAGES[1])).toBe(REAL_PHANTOM_MESSAGES[1]);
    expect(findEditClaim(REAL_PHANTOM_MESSAGES[2])).toBe(REAL_PHANTOM_MESSAGES[2]);
  });

  it("finds first-person and list-item claims", () => {
    expect(findEditClaim("I've updated `parse()` in src/load.ts so it skips blank lines.")).toContain("updated `parse()`");
    expect(findEditClaim("Done. Added a `--limit` flag to src/cli.ts.")).toBe("Added a `--limit` flag to src/cli.ts.");
    expect(findEditClaim("Summary:\n- **Renamed `foo` to `bar`** in util.py")).toBe("Renamed `foo` to `bar` in util.py");
  });

  it("ignores plans, hypotheticals, negations, questions and descriptions", () => {
    for (const m of [
      "I'll implement `slugify` in slug.py.",
      "I will add `--words` to wc.py next.",
      "Next, I would extract `clamp_percent` from pricing.py.",
      "If you want, I can add `--words` to wc.py.",
      "Let me add `--words` to wc.py.",
      "No changes were needed. `wc.py` already counts words.",
      "I didn't change anything. Added `--words` would conflict with `--lines` in wc.py.",
      "The function `clamp` in pricing.py already handles negative values.",
      "`clamp_percent` already exists in pricing.py.",
      "Updated `wc.py`?",
      "Want me to apply it? Added `--words` to wc.py.",
      "Here's the plan:\n1. Added `--words` to wc.py",
      "**Fixed header** - brand and nav in `index.html`",
      "Added nothing to wc.py.",
      "Updated the README with the new section.",
      "Fixed it.",
    ]) {
      expect(findEditClaim(m), m).toBeUndefined();
    }
  });

  it("ignores code blocks", () => {
    expect(findEditClaim("Output:\n```\nAdded `x` to y.py\n```")).toBeUndefined();
  });

  it("truncates long claims for display", () => {
    const long = "Added `x` to y.py " + "and more ".repeat(40);
    expect(truncate(long).length).toBeLessThanOrEqual(160);
    expect(truncate(long).endsWith("...")).toBe(true);
  });
});

describe("Claude Code turns", () => {
  async function turns(steps: Parameters<typeof claudeLines>[0]) {
    const f = writeLines(join(tmp(), "proj", "session.jsonl"), claudeLines(steps));
    return (await parseClaudeActivity(f)).turns;
  }
  const claim = "Added `--words` to wc.py. It counts whitespace-separated tokens.";

  it("flags a claim after only read-only actions", async () => {
    const t = await turns([
      { prompt: PROMPT_SENTINEL },
      { tool: "Read", input: { file_path: "/tmp/demo-project/wc.py" } },
      { tool: "Bash", input: { command: "sed -n '1,80p' wc.py && git status" } },
      { tool: "Grep", input: { pattern: "argparse" } },
      { text: claim },
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ agent: "claude", toolCalls: 3, cliVersion: "2.1.272", model: "claude-opus-5", line: 5 });
    expect(t[0].editAction).toBeUndefined();
    expect(flagged(t)).toHaveLength(1);
    expect(JSON.stringify(t)).not.toContain(PROMPT_SENTINEL);
  });

  it("does not flag a claim after an Edit, Write, MultiEdit or NotebookEdit", async () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      const t = await turns([{ prompt: "p" }, { tool: "Read" }, { tool, input: { file_path: "wc.py", new_string: "x" } }, { text: claim }]);
      expect(t[0].editAction, tool).toBe(tool);
      expect(flagged(t), tool).toHaveLength(0);
    }
  });

  it("does not flag a claim after a shell command that writes", async () => {
    const t = await turns([{ prompt: "p" }, { tool: "Bash", input: { command: "sed -i 's/a/b/' wc.py" } }, { text: claim }]);
    expect(t[0].editAction).toBe("Bash: sed -i");
    expect(flagged(t)).toHaveLength(0);
  });

  it("counts subagents and unknown tools as possible edits", async () => {
    for (const tool of ["Agent", "Task", "mcp__fs__write_file", "PowerShell"]) {
      const t = await turns([{ prompt: "p" }, { tool }, { text: claim }]);
      expect(flagged(t), tool).toHaveLength(0);
    }
  });

  it("keeps background task results in the turn that started the task", async () => {
    const t = await turns([
      { prompt: "p" },
      { tool: "Agent", input: { prompt: "edit wc.py" } },
      { text: "Started a subagent." },
      { prompt: "[task notification]", origin: "task-notification" },
      { text: claim },
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].editAction).toBe("Agent");
    expect(flagged(t)).toHaveLength(0);
  });

  it("does not flag plans, negations or descriptions", async () => {
    for (const text of ["I'll implement `--words` in wc.py.", "No changes were needed: wc.py already counts words.", "The function `count` in wc.py already handles tabs."]) {
      const t = await turns([{ prompt: "p" }, { tool: "Read" }, { text }]);
      expect(flagged(t), text).toHaveLength(0);
    }
  });

  it("skips interrupted and errored turns", async () => {
    const t = await turns([
      { prompt: "p" },
      { tool: "Read" },
      { text: claim },
      { interrupt: true },
      { prompt: "q" },
      { tool: "Read" },
      { apiError: true },
      { text: claim },
    ]);
    expect(t.map((x) => x.incomplete)).toEqual([true, true]);
    expect(t.map((x) => judgeTurn(x).kind)).toEqual(["skipped", "skipped"]);
  });

  it("does not flag a recap of an earlier turn's edit", async () => {
    const t = await turns([
      { prompt: "p" },
      { tool: "Edit", input: { file_path: "/tmp/demo-project/wc.py", old_string: "a", new_string: "parser.add_argument('--words')" } },
      { text: "Done." },
      { prompt: "q" },
      { text: claim },
    ]);
    expect(t).toHaveLength(2);
    expect(judgeTurn(t[1])).toMatchObject({ kind: "scanned", phantom: false, unflagged: "recap" });
  });

  it("only uses the text after the last tool call as the final message", async () => {
    const t = await turns([{ prompt: "p" }, { text: claim }, { tool: "Bash", input: { command: "touch wc.py" } }]);
    expect(t[0].finalMessage).toBe("");
  });

  it("skips subagent transcripts", async () => {
    const f = writeLines(join(tmp(), "proj", "s1", "subagents", "agent-1.jsonl"), claudeLines([{ prompt: "p" }, { tool: "Read" }, { text: claim }]));
    expect((await parseClaudeActivity(f)).turns).toHaveLength(0);
  });
});

describe("Codex turns", () => {
  async function turns(steps: Parameters<typeof codexLines>[0]) {
    const f = writeLines(join(tmp(), "2026", "10", "03", "rollout-a.jsonl"), codexLines(steps));
    return (await parseCodexActivity(f)).turns;
  }

  it("flags the three real phantom runs: read-only commands, then a claim", async () => {
    const reads = [
      ["cat wc.py", "git status --short"],
      ["rg --files", "sed -n '1,200p' pricing.py"],
      ["sed -n '1,200p' pricing.py", "rg -n clamp pricing.py", "git status"],
    ];
    for (let i = 0; i < 3; i++) {
      const t = await turns([{ prompt: PROMPT_SENTINEL }, ...reads[i].map((exec) => ({ exec })), { say: REAL_PHANTOM_MESSAGES[i] }, { done: REAL_PHANTOM_MESSAGES[i] }]);
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ agent: "codex", cliVersion: "0.160.0", model: "gpt-6-luna", toolCalls: reads[i].length });
      expect(flagged(t), REAL_PHANTOM_MESSAGES[i]).toHaveLength(1);
      expect(JSON.stringify(t)).not.toContain(PROMPT_SENTINEL);
    }
  });

  it("does not flag a claim after apply_patch or a file_change item", async () => {
    const msg = REAL_PHANTOM_MESSAGES[0];
    const patched = await turns([{ prompt: "p" }, { exec: "cat wc.py" }, { patch: "*** Begin Patch\n*** Update File: wc.py\n+x\n*** End Patch" }, { done: msg }]);
    expect(patched[0].editAction).toBe("apply_patch");
    expect(flagged(patched)).toHaveLength(0);
    const changed = await turns([{ prompt: "p" }, { exec: "cat wc.py" }, { fileChange: "wc.py" }, { done: msg }]);
    expect(changed[0].editAction).toBe("apply_patch");
    expect(flagged(changed)).toHaveLength(0);
  });

  it("does not flag a claim after a shell command that writes", async () => {
    for (const exec of ["cat > wc.py <<'EOF'\nprint(1)\nEOF", "python3 -c \"open('wc.py','a').write('x')\"", "git apply /tmp/p.diff"]) {
      const t = await turns([{ prompt: "p" }, { exec: "cat wc.py" }, { exec }, { done: REAL_PHANTOM_MESSAGES[0] }]);
      expect(flagged(t), exec).toHaveLength(0);
    }
  });

  it("counts unknown tools and spawned agents as possible edits, but not plan updates", async () => {
    expect(flagged(await turns([{ prompt: "p" }, { tool: "spawn_agent" }, { done: REAL_PHANTOM_MESSAGES[0] }]))).toHaveLength(0);
    expect(flagged(await turns([{ prompt: "p" }, { tool: "update_plan" }, { done: REAL_PHANTOM_MESSAGES[0] }]))).toHaveLength(1);
  });

  it("does not flag plans, negations or descriptions", async () => {
    for (const done of ["I'll implement `slugify` in slug.py.", "No changes were needed; pricing.py already clamps.", "`clamp_percent` in pricing.py already handles values over 100."]) {
      expect(flagged(await turns([{ prompt: "p" }, { exec: "cat pricing.py" }, { done }])), done).toHaveLength(0);
    }
  });

  it("skips aborted turns and splits one file into turns", async () => {
    const t = await turns([
      { prompt: "a" },
      { exec: "cat wc.py" },
      { aborted: true },
      { prompt: "b" },
      { exec: "cat wc.py" },
      { done: REAL_PHANTOM_MESSAGES[0] },
    ]);
    expect(t).toHaveLength(2);
    expect(t[0].incomplete).toBe(true);
    expect(flagged(t)).toHaveLength(1);
    expect(t.map((x) => x.dedupeKey)).toEqual(["codex:turn-1790985600000-1", "codex:turn-1790985600000-2"]);
  });

  it("reads the item_completed format", async () => {
    const f = writeLines(join(tmp(), "rollout-items.jsonl"), [
      { timestamp: "2026-10-03T08:32:32Z", type: "session_meta", payload: { cli_version: "0.160.0", source: "exec" } },
      { timestamp: "2026-10-03T08:32:32Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: "2026-10-03T08:32:33Z", type: "turn_context", payload: { turn_id: "t1", model: "gpt-6-luna" } },
      { timestamp: "2026-10-03T08:32:33Z", type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "UserMessage", content: [{ type: "text", text: PROMPT_SENTINEL }] } } },
      { timestamp: "2026-10-03T08:32:34Z", type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "CommandExecution", command: "/bin/zsh -lc 'cat wc.py'" } } },
      { timestamp: "2026-10-03T08:32:35Z", type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "AgentMessage", content: [{ type: "Text", text: REAL_PHANTOM_MESSAGES[0] }] } } },
      { timestamp: "2026-10-03T08:32:35Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: REAL_PHANTOM_MESSAGES[0] } },
    ]);
    const t = (await parseCodexActivity(f)).turns;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ toolCalls: 1, model: "gpt-6-luna", finalMessage: REAL_PHANTOM_MESSAGES[0] });
    expect(t[0].editAction).toBeUndefined();
    expect(flagged(t)).toHaveLength(1);
    expect(JSON.stringify(t)).not.toContain(PROMPT_SENTINEL);
  });
});

describe("analyzePhantoms", () => {
  it("counts per agent and per (CLI version, model), newest examples first", async () => {
    const root = tmp();
    const codexRoot = join(root, "codex");
    writeLines(
      join(codexRoot, "2026", "10", "03", "rollout-1.jsonl"),
      codexLines([{ prompt: "a" }, { exec: "cat wc.py" }, { done: REAL_PHANTOM_MESSAGES[0] }, { prompt: "b" }, { patch: "*** Begin Patch\n*** Add File: x.py\n+x\n*** End Patch" }, { done: "Added `x` to x.py." }]),
    );
    writeLines(
      join(codexRoot, "2026", "10", "04", "rollout-2.jsonl"),
      codexLines([{ prompt: "c" }, { exec: "rg --files" }, { done: REAL_PHANTOM_MESSAGES[1] }, { prompt: "d" }, { exec: "ls" }, { done: "It works." }], {
        version: "0.161.0",
        start: Date.UTC(2026, 9, 4),
      }),
    );
    const act = await loadActivity({ roots: { codex: [codexRoot] }, agents: ["codex"] });
    const r = analyzePhantoms(act.turns, act.files, { limit: 1 });
    expect(r).toMatchObject({ turns: 4, editClaims: 3, phantom: 2, files: { codex: 2 } });
    expect(r.rate).toBeCloseTo(2 / 3);
    expect(r.byAgent).toEqual([{ agent: "codex", cliVersion: "all", model: "all", turns: 4, editClaims: 3, phantom: 2, rate: 2 / 3 }]);
    expect(r.groups.map((g) => [g.cliVersion, g.turns, g.editClaims, g.phantom])).toEqual([
      ["0.160.0", 2, 2, 1],
      ["0.161.0", 2, 1, 1],
    ]);
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toMatchObject({ date: "2026-10-04", cliVersion: "0.161.0", model: "gpt-6-luna", toolCalls: 1 });
    const text = formatPhantomReport(r, act.turns.length);
    expect(text).toContain("2 of 3 turns that claimed an edit (66.7%) had no file-modifying action.");
    expect(text).toContain("Detection is heuristic and conservative");
    expect(text).toContain("rollout-2.jsonl:");
  });
});
