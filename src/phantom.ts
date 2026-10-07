import { homedir } from "node:os";
import { sep } from "node:path";
import { bold, dim, fmtInt, fmtPct, isoDate, table } from "./format.js";
import { compareVersions } from "./metrics.js";
import type { ActivityTurn, EditRecord } from "./types.js";

/**
 * Phantom edits: turns where the agent's final message says it changed code,
 * but nothing in the turn changed a file.
 *
 * Precision matters far more than recall here, because a false accusation is
 * worse than a miss. So a turn is flagged only when every action in it is
 * positively known to be read-only, and only when the final message contains a
 * plain past-tense claim of an edit that names code. Anything unknown counts as
 * a possible edit.
 */

export const FINDINGS_URL = "https://abelo9996.github.io/open-agent-lab/findings/2026-10-rerun-10x/";

// ---------------------------------------------------------------------------
// Shell commands

export interface CommandVerdict {
  /** Every part of the command is known not to write files. */
  readOnly: boolean;
  /** The command shows existing changes (git diff, log, show, blame). */
  history: boolean;
  /** For a command that is not read-only: the part that made it so. */
  reason?: string;
}

const SHELLS = /^(?:.*\/)?(?:ba|z|da|k|fi)?sh$/;

/** Turn a command as logged (a string, or an argv array such as ["bash", "-lc", "..."]) into one shell string. */
export function commandText(cmd: unknown): string | undefined {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd) || !cmd.every((c) => typeof c === "string")) return undefined;
  if (cmd.length >= 3 && SHELLS.test(cmd[0]) && /^-l?c$/.test(cmd[1])) return cmd.slice(2).join(" ");
  return cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

type Lexed = { segments: string[][] } | { unsafe: string };

/**
 * Split a shell command into simple commands (argv lists). Returns `unsafe` for
 * anything that can hide a write: command substitution, heredocs, process
 * substitution, or output redirection to anything but /dev/null or another fd.
 */
function lex(cmd: string): Lexed {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return { unsafe: "unbalanced quote" };
      cur += cmd.slice(i + 1, j);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          s += cmd[j + 1];
          j += 2;
          continue;
        }
        if (cmd[j] === "`" || (cmd[j] === "$" && cmd[j + 1] === "(")) return { unsafe: "command substitution" };
        s += cmd[j++];
      }
      if (j >= cmd.length) return { unsafe: "unbalanced quote" };
      cur += s;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (cmd[i + 1] === "\n") i += 2;
      else {
        cur += cmd[i + 1] ?? "";
        inWord = true;
        i += 2;
      }
      continue;
    }
    if (c === "`" || (c === "$" && cmd[i + 1] === "(")) return { unsafe: "command substitution" };
    if (c === "<") {
      if (cmd[i + 1] === "<" || cmd[i + 1] === "(") return { unsafe: "heredoc or process substitution" };
      // Input redirection reads a file: skip the operator and its target.
      endWord();
      i++;
      while (cmd[i] === " " || cmd[i] === "\t") i++;
      while (i < cmd.length && !/[\s;&|()<>]/.test(cmd[i])) i++;
      continue;
    }
    if (c === ">" || (c === "&" && cmd[i + 1] === ">")) {
      // Output redirection. Only /dev/null and fd duplication (2>&1) are allowed.
      if (inWord && !/^\d$/.test(cur)) endWord();
      else {
        cur = "";
        inWord = false;
      }
      i += c === "&" ? 2 : 1;
      if (cmd[i] === ">") i++;
      if (cmd[i] === "&" && /[\d-]/.test(cmd[i + 1] ?? "")) {
        i += 2;
        continue;
      }
      while (cmd[i] === " " || cmd[i] === "\t") i++;
      let target = "";
      while (i < cmd.length && !/[\s;&|()<>]/.test(cmd[i])) target += cmd[i++];
      if (target.replace(/^["']|["']$/g, "") !== "/dev/null") return { unsafe: "output redirection" };
      continue;
    }
    if (c === "&" || c === "|" || c === ";" || c === "\n" || c === "(" || c === ")") {
      endSegment();
      i += (c === "&" || c === "|") && (cmd[i + 1] === c || (c === "|" && cmd[i + 1] === "&")) ? 2 : 1;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < cmd.length && cmd[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    cur += c;
    inWord = true;
    i++;
  }
  endSegment();
  return { segments };
}

/** Commands that only read, whatever their arguments (output redirection is checked separately). */
const READ_ONLY = new Set(
  (
    "cat head tail less more ls ll la pwd echo printf wc grep egrep fgrep rg ag ack which whereis type whoami date file stat du df " +
    "tree nl cut tr column sort diff cmp comm basename dirname realpath readlink true false test [ printenv uname hostname id jq " +
    "hexdump od strings sleep cd pushd popd ps lsof uptime md5 md5sum shasum sha1sum sha256sum cksum tac rev fold paste seq " +
    "whatis locale groups sw_vers arch nproc export unset exit wait"
  ).split(" "),
);

/** git subcommands that only read. */
const GIT_READ_ONLY = new Set(
  (
    "status diff log show blame annotate rev-parse ls-files ls-tree ls-remote grep describe shortlog cat-file merge-base " +
    "rev-list name-rev for-each-ref count-objects check-ignore show-ref var whatchanged help version cherry range-diff"
  ).split(" "),
);
const GIT_HISTORY = new Set(["diff", "log", "show", "blame", "annotate", "whatchanged", "range-diff", "shortlog", "cherry"]);

const base = (w: string) => w.slice(w.lastIndexOf("/") + 1);

function simpleCommand(words: string[]): { ok: boolean; history?: boolean; reason?: string } {
  let w = words;
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
  if (w[0] === "time" || w[0] === "nice") w = w.slice(1);
  if (w[0] === "timeout") {
    w = w.slice(1);
    while (w[0]?.startsWith("-")) w = w.slice(1);
    w = w.slice(1);
  }
  if (!w.length) return { ok: true };
  const name = base(w[0]);
  const args = w.slice(1);
  const no = { ok: false, reason: name };
  if (args.length === 1 && (args[0] === "--version" || args[0] === "--help")) return { ok: true };
  const has = (re: RegExp) => args.some((a) => re.test(a));

  if (READ_ONLY.has(name)) {
    if (name === "rg" && has(/^--pre(=|$)/)) return no;
    if (name === "sort" && has(/^(-o|--output)/)) return no;
    if (name === "tail" && has(/^--pid/)) return { ok: true };
    return { ok: true };
  }
  switch (name) {
    case "sed": {
      if (has(/^(-i|-I|--in-place)/) || has(/^-[a-zA-Z]*[iI]/)) return { ok: false, reason: "sed -i" };
      // The w and e commands write files or run commands from inside the script.
      if (args.some((a) => !a.startsWith("-") && (/(^|[;{}\n\/\d$pgIiMm])\s*[wW]\s+\S/.test(a) || /(^|[;{}\n])\s*e(\s|$)/.test(a) || /\/[gpIiMm\d]*e[gpIiMm\d]*$/.test(a)))) {
        return { ok: false, reason: "sed script that writes" };
      }
      return { ok: true };
    }
    case "awk":
    case "gawk":
    case "mawk":
      if (args.some((a) => /system\s*\(|[>|]|getline/.test(a)) || has(/^-i/)) return no;
      return { ok: true };
    case "find":
      if (has(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/)) return { ok: false, reason: "find with -delete or -exec" };
      return { ok: true };
    case "fd":
      if (has(/^(-x|-X|--exec|--exec-batch)/)) return { ok: false, reason: "fd --exec" };
      return { ok: true };
    case "uniq":
      return args.filter((a) => !a.startsWith("-")).length <= 1 ? { ok: true } : no;
    case "yq":
      return has(/^(-i|--inplace)/) ? no : { ok: true };
    case "env":
      return args.length === 0 ? { ok: true } : no;
    case "command":
      return args[0] === "-v" || args[0] === "-V" ? { ok: true } : no;
    case "sysctl":
      return has(/^-w|=/) ? no : { ok: true };
    case "git":
      return gitCommand(args);
  }
  return no;
}

function gitCommand(args: string[]): { ok: boolean; history?: boolean; reason?: string } {
  let a = args;
  // Global options before the subcommand.
  while (a.length && a[0].startsWith("-")) {
    if (a[0] === "-C" || a[0] === "-c" || a[0] === "--git-dir" || a[0] === "--work-tree") a = a.slice(2);
    else a = a.slice(1);
  }
  const sub = a[0];
  const rest = a.slice(1);
  const no = { ok: false, reason: `git ${sub ?? ""}`.trim() };
  if (!sub) return { ok: true };
  if (GIT_READ_ONLY.has(sub)) {
    if (rest.some((x) => /^--output(=|$)/.test(x)) || (sub === "grep" && rest.some((x) => /^(-O|--open-files-in-pager)/.test(x)))) return no;
    return { ok: true, history: GIT_HISTORY.has(sub) };
  }
  const flagsOnly = rest.every((x) => x.startsWith("-"));
  switch (sub) {
    case "branch":
      return flagsOnly && !rest.some((x) => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description|track)/.test(x))
        ? { ok: true }
        : no;
    case "remote":
      return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "show" || rest[0] === "get-url" ? { ok: true } : no;
    case "config":
      return rest.some((x) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(x)) ? { ok: true } : no;
    case "tag":
      return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list" ? { ok: true } : no;
    case "stash":
    case "worktree":
      return rest[0] === "list" || (sub === "stash" && rest[0] === "show") ? { ok: true, history: sub === "stash" } : no;
    case "reflog":
      return rest.length === 0 || rest[0] === "show" ? { ok: true, history: true } : no;
  }
  return no;
}

/**
 * Is this shell command known not to write any file? Unknown commands, writes,
 * redirection, command substitution and anything that runs other code count as
 * possible writes.
 */
export function classifyCommand(cmd: unknown, depth = 0): CommandVerdict {
  const text = commandText(cmd);
  if (text === undefined || !text.trim()) return { readOnly: false, history: false, reason: "unrecognized command" };
  const lexed = lex(text);
  if ("unsafe" in lexed) return { readOnly: false, history: false, reason: lexed.unsafe };
  let history = false;
  for (const seg of lexed.segments) {
    // A nested `bash -lc '<script>'`: judge the script.
    if (depth < 2 && seg.length === 3 && SHELLS.test(seg[0]) && /^-l?c$/.test(seg[1])) {
      const inner = classifyCommand(seg[2], depth + 1);
      if (!inner.readOnly) return { ...inner, history: history || inner.history };
      if (inner.history) history = true;
      continue;
    }
    const v = simpleCommand(seg);
    if (!v.ok) return { readOnly: false, history, reason: v.reason };
    if (v.history) history = true;
  }
  return { readOnly: true, history };
}

// ---------------------------------------------------------------------------
// Edits across the turns of one session

/** Edit text kept per turn. A turn with more counts as opaque, so a cut-off name cannot cause a flag. */
export const EDIT_TEXT_MAX = 200_000;

/**
 * Collects what each turn of one session file edited. Parsers call `opaque`,
 * `file` and `text` while reading a turn and `finish` when it ends.
 */
export class SessionEdits {
  readonly edits: EditRecord[] = [];
  private cur: EditRecord | null = null;

  private get rec(): EditRecord {
    return (this.cur ??= { opaque: false, paths: [], text: "" });
  }

  /** An edit whose target is unknown: a shell command, a subagent, an unknown tool. */
  opaque(): void {
    this.rec.opaque = true;
  }

  file(path: unknown): void {
    if (typeof path === "string" && path) this.rec.paths.push(path);
    else this.opaque();
  }

  text(t: unknown): void {
    if (typeof t !== "string" || !t) return;
    const r = this.rec;
    if (r.text.length + t.length > EDIT_TEXT_MAX) r.opaque = true;
    else r.text += t + "\n";
  }

  /** Paths and text of an apply_patch patch. */
  patch(p: unknown): void {
    if (typeof p !== "string" || !p) return this.opaque();
    let named = false;
    for (const m of p.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
      this.file((m[1] ?? m[2]).trim());
      named = true;
    }
    if (!named) this.opaque();
    this.text(p);
  }

  /** End of a turn: give it the edits of the turns before it, then record its own. */
  finish(t: ActivityTurn | null): void {
    if (t) t.prior = { edits: this.edits, count: this.edits.length };
    if (this.cur) this.edits.push(this.cur);
    this.cur = null;
  }
}

// ---------------------------------------------------------------------------
// Edit claims in the final message

const VERBS = [
  "added",
  "updated",
  "extracted",
  "implemented",
  "fixed",
  "created",
  "renamed",
  "refactored",
  "changed",
  "modified",
  "removed",
  "replaced",
  "wrote",
  "rewrote",
  "moved",
  "deleted",
  "inserted",
  "converted",
  "applied",
  "introduced",
  "edited",
  "patched",
  "adjusted",
  "tweaked",
  "simplified",
  "reworked",
  "inlined",
  "consolidated",
  "restructured",
  "reorganized",
  "swapped",
  "switched",
  "bumped",
  "migrated",
  "corrected",
  "wired",
  "hooked",
  "commented",
  "uncommented",
  "deduplicated",
];

const CLAIM_START = new RegExp(
  String.raw`^(?:(?:done|all set|ok(?:ay)?)[.,:!]?\s+)?(?:i(?:'ve|’ve| have)?\s+)?(?:(?:also|now|just|then|successfully|finally|first|additionally)\s+)?(?:${VERBS.join("|")})\b`,
  "i",
);

const EXTENSIONS =
  "py|pyi|ipynb|ts|tsx|js|jsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|rst|txt|yml|yaml|toml|ini|cfg|conf|env|lock|xml|html|htm|css|scss|sass|less|" +
  "vue|svelte|astro|rs|go|java|kt|kts|scala|rb|php|c|h|cc|cpp|cxx|hpp|hh|cs|fs|swift|m|mm|sh|bash|zsh|fish|ps1|sql|graphql|gql|proto|" +
  "tf|hcl|lua|r|dart|ex|exs|erl|hs|ml|clj|cljs|el|vim|nix|gradle|cmake|mk|csv|tsv|svg|plist|bzl|sol|zig|jl|pl|pm|tex|bib";
const FILE_REF_SRC = String.raw`(?:^|[^\w.\/-])((?:[\w.~-]+\/)*[\w-][\w.-]*\.(?:${EXTENSIONS}))(?![\w-])`;
const FILE_REF = new RegExp(FILE_REF_SRC, "i");
const CODE_SPAN = /`[^`\n]+`/;

/** Plans, hypotheticals, hedges and negations inside the claim sentence itself. */
const SENTENCE_EXCLUDE =
  /\b(?:i'll|i’ll|i will|i'd|i’d|i would|i can|i could|i'm going to|i am going to|we'll|we will|let me|let's|should|would|could|might|may|next|planning|plan to|going to|if you want|if you'd like|need to|needs to|want to|wants to|will|no|not|never|nothing|none|neither|nor|without|already|instead of|in progress)\b|n't\b|n’t\b/i;

/** Messages that say no edit was made, or offer edits instead of reporting them. */
const MESSAGE_EXCLUDE = new RegExp(
  [
    String.raw`\bno (?:code |file |source )?(?:changes|edits|modifications)\b`,
    String.raw`\b(?:did ?n[o']t|did not|have ?n[o']t|have not|has ?n[o']t|has not|haven[’']t|hasn[’']t|didn[’']t) (?:actually |yet )?(?:change|modify|edit|touch|write|make|apply|save|commit)`,
    String.raw`\bnothing (?:to|was|needed to|needs to) (?:change|be changed|edit|fix|update)`,
    String.raw`\b(?:left|leave|leaving) (?:\S+ ){0,3}(?:unchanged|untouched|as is|alone)\b`,
    String.raw`\bwithout (?:changing|modifying|editing|touching|writing)\b`,
    String.raw`\bread[- ]only\b`,
    String.raw`\b(?:not|never) (?:been )?(?:applied|saved|written|committed)\b`,
    String.raw`\b(?:unable|not able) to (?:edit|write|apply|modify|save|change)`,
    String.raw`\bcould ?n[o’']?t (?:edit|write|apply|modify|save|change)`,
    String.raw`\bcannot (?:edit|write|apply|modify|save|change)`,
    String.raw`\b(?:would you like|want me to|shall i|should i|do you want)\b`,
    String.raw`\bhere(?:'s| is) (?:the|a|my) (?:plan|proposal|proposed|suggested|draft)`,
    String.raw`\b(?:proposed|suggested|recommended) (?:change|fix|patch|diff|edit)s?\b`,
    String.raw`\bi(?:'d|’d| would) (?:suggest|recommend|propose)\b`,
    String.raw`\bdry[- ]run\b`,
  ].join("|"),
  "i",
);

interface Sentence {
  text: string;
  /** Starts with a bold label such as "**Fixed header** - ..." or "**Updated venue order**:", where the verb is not a claim. */
  label: boolean;
}

/** Sentences of a message, one per line item, with list markers and emphasis removed. Code blocks are dropped. */
function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const noCode = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  for (const raw of noCode.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:>\s*)*/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*+•]|\d+[.)])\s+/, "")
      .trim();
    if (!line) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z*_`"'(\[])/)) {
      const label = /^(?:\*\*|__)[^*_]{1,80}?[^.!?*_](?:\*\*|__)\s*[:,(\u2013\u2014-]/.test(s);
      const t = s.replace(/^(?:\*\*|__|\*|_)+/, "").trim();
      if (t) out.push({ text: t, label });
    }
  }
  return out;
}

export function sentences(text: string): string[] {
  return splitSentences(text).map((s) => s.text);
}

/**
 * The first sentence of `message` that claims a completed edit to code, or
 * undefined. A claim starts with a past-tense edit verb ("Added", "I've
 * updated", ...), names code (a file name or a `code span`), and is not a
 * plan, hedge, negation or question. Messages that say no change was made, or
 * offer to make one, have no claim.
 */
export function findEditClaim(message: string): string | undefined {
  if (!message || MESSAGE_EXCLUDE.test(message)) return undefined;
  for (const { text: s, label } of splitSentences(message)) {
    if (label || !CLAIM_START.test(s)) continue;
    if (/\?\s*$/.test(s)) continue;
    const plain = s.replace(/`[^`\n]*`/g, "`x`");
    if (SENTENCE_EXCLUDE.test(plain)) continue;
    if (!CODE_SPAN.test(s) && !FILE_REF.test(s)) continue;
    return s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/** What a claim names: file names (without directories) and the text of `code spans` (a call's name only). */
export function claimNames(claim: string): string[] {
  const names = new Set<string>();
  for (const m of claim.matchAll(/`([^`\n]+)`/g)) {
    let c = m[1].trim();
    const call = /^([\w.$:-]+)\s*\(/.exec(c);
    if (call) c = call[1];
    if (c) names.add(c);
  }
  for (const m of claim.matchAll(new RegExp(FILE_REF_SRC, "gi"))) names.add(base(m[1]));
  return [...names];
}

/**
 * Could the claim be a recap of an earlier turn's work? True when an earlier
 * turn of the same session made an edit with an unknown target, or edited a
 * file or wrote text that the claim names.
 */
export function mayBeRecap(claim: string, prior: ActivityTurn["prior"]): boolean {
  if (!prior?.count) return false;
  const names = claimNames(claim);
  for (let i = 0; i < prior.count; i++) {
    const e = prior.edits[i];
    if (e.opaque) return true;
    for (const n of names) {
      const lower = n.toLowerCase();
      if (e.paths.some((p) => base(p.replace(/\\/g, "/")).toLowerCase() === lower)) return true;
      if (e.text.includes(n)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Analysis

export interface PhantomGroup {
  agent: string;
  cliVersion: string;
  model: string;
  /** Finished main-thread turns with a final message. */
  turns: number;
  /** Of those, turns whose final message claims an edit. */
  editClaims: number;
  /** Of those, turns with no file-modifying action. */
  phantom: number;
  /** phantom / editClaims, or null with no edit claims. */
  rate: number | null;
}

export interface PhantomExample {
  timestamp: number;
  date: string;
  agent: string;
  cliVersion: string;
  model: string;
  /** The claim sentence, truncated. */
  claim: string;
  /** Read-only tool calls and commands in the turn. */
  toolCalls: number;
  /** Local session file and line of the final message. */
  file: string;
  line: number;
}

export interface PhantomReport {
  files: Record<string, number>;
  from: number | null;
  to: number | null;
  turns: number;
  editClaims: number;
  phantom: number;
  rate: number | null;
  /** Turns not scanned: interrupted, errored or ended on a tool call. */
  skippedIncomplete: number;
  /** Edit-claim turns with no edit that were not flagged because they ran git diff, log, show or blame. */
  skippedHistory: number;
  /** Edit-claim turns with no edit that were not flagged because an earlier turn of the session edited what they name. */
  skippedRecap: number;
  byAgent: PhantomGroup[];
  groups: PhantomGroup[];
  examples: PhantomExample[];
}

export const CLAIM_MAX = 160;

export function truncate(s: string, max = CLAIM_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 3).trimEnd() + "...";
}

export type TurnVerdict =
  | { kind: "skipped" }
  | { kind: "scanned"; claim?: string; phantom: boolean; unflagged?: "history" | "recap" };

/** Decide one turn. */
export function judgeTurn(t: ActivityTurn): TurnVerdict {
  if (t.sidechain || t.incomplete || !t.finalMessage.trim()) return { kind: "skipped" };
  const claim = findEditClaim(t.finalMessage);
  if (!claim || t.editAction) return { kind: "scanned", claim, phantom: false };
  // A turn that looked at existing changes may be describing them, not claiming them.
  if (t.viewedHistory) return { kind: "scanned", claim, phantom: false, unflagged: "history" };
  if (mayBeRecap(claim, t.prior)) return { kind: "scanned", claim, phantom: false, unflagged: "recap" };
  return { kind: "scanned", claim, phantom: true };
}

export function analyzePhantoms(turns: ActivityTurn[], files: Record<string, number>, opts: { limit?: number } = {}): PhantomReport {
  const limit = opts.limit ?? 10;
  const groups = new Map<string, PhantomGroup>();
  const agents = new Map<string, PhantomGroup>();
  const examples: PhantomExample[] = [];
  let scanned = 0;
  let claims = 0;
  let phantom = 0;
  let incomplete = 0;
  let history = 0;
  let recap = 0;
  let from: number | null = null;
  let to: number | null = null;
  const bump = (m: Map<string, PhantomGroup>, key: string, g: Omit<PhantomGroup, "turns" | "editClaims" | "phantom" | "rate">) => {
    let r = m.get(key);
    if (!r) m.set(key, (r = { ...g, turns: 0, editClaims: 0, phantom: 0, rate: null }));
    return r;
  };
  for (const t of turns) {
    if (t.sidechain) continue;
    const v = judgeTurn(t);
    if (v.kind === "skipped") {
      incomplete++;
      continue;
    }
    scanned++;
    if (from === null || t.timestamp < from) from = t.timestamp;
    if (to === null || t.timestamp > to) to = t.timestamp;
    const cliVersion = t.cliVersion ?? "unknown";
    const model = t.model ?? "unknown";
    const rows = [
      bump(groups, `${t.agent}\u0000${cliVersion}\u0000${model}`, { agent: t.agent, cliVersion, model }),
      bump(agents, t.agent, { agent: t.agent, cliVersion: "all", model: "all" }),
    ];
    for (const r of rows) r.turns++;
    if (!v.claim) continue;
    claims++;
    for (const r of rows) r.editClaims++;
    if (v.unflagged === "history") history++;
    if (v.unflagged === "recap") recap++;
    if (!v.phantom) continue;
    phantom++;
    for (const r of rows) r.phantom++;
    examples.push({
      timestamp: t.timestamp,
      date: isoDate(t.timestamp),
      agent: t.agent,
      cliVersion,
      model,
      claim: truncate(v.claim),
      toolCalls: t.toolCalls,
      file: t.file,
      line: t.line,
    });
  }
  const finish = (g: PhantomGroup) => ({ ...g, rate: g.editClaims ? g.phantom / g.editClaims : null });
  examples.sort((a, b) => b.timestamp - a.timestamp);
  return {
    files,
    from,
    to,
    turns: scanned,
    editClaims: claims,
    phantom,
    rate: claims ? phantom / claims : null,
    skippedIncomplete: incomplete,
    skippedHistory: history,
    skippedRecap: recap,
    byAgent: [...agents.values()].map(finish).sort((a, b) => a.agent.localeCompare(b.agent)),
    groups: [...groups.values()]
      .map(finish)
      .sort((a, b) => a.agent.localeCompare(b.agent) || compareVersions(a.cliVersion, b.cliVersion) || a.model.localeCompare(b.model)),
    examples: examples.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// Output

const HEADERS = ["agent", "cli", "model", "turns", "edit claims", "phantom", "rate"];
const ALIGN: ("l" | "r")[] = ["l", "l", "l", "r", "r", "r", "r"];

function rows(gs: PhantomGroup[]): string[][] {
  return gs.map((g) => [g.agent, g.cliVersion, g.model, fmtInt(g.turns), fmtInt(g.editClaims), fmtInt(g.phantom), fmtPct(g.rate)]);
}

function tilde(p: string): string {
  const h = homedir();
  return h && p.startsWith(h + sep) ? "~" + p.slice(h.length) : p;
}

export const PHANTOM_NOTE =
  "Detection is heuristic and conservative. A turn is flagged only when its final message starts a sentence with a past-tense edit " +
  "(\"Added ...\", \"I've updated ...\") that names a file or `code`, and every action in the turn was read-only: no edit tool, no patch, " +
  "no subagent, no unknown tool, and no shell command that could write. It misses phantom edits worded any other way, and a flagged " +
  "turn can still be a recap of work from an earlier turn. To check one, open the session file at the line shown and look above it, " +
  "back to the user's message, for an edit.";

export function formatPhantomReport(r: PhantomReport, totalTurns: number): string {
  const out: string[] = [];
  const files = Object.entries(r.files);
  const fileTotal = files.reduce((a, [, n]) => a + n, 0);
  const range = r.from !== null && r.to !== null ? `, ${isoDate(r.from)} to ${isoDate(r.to)}` : "";
  out.push(
    `Read ${fmtInt(totalTurns)} turns from ${fmtInt(fileTotal)} session files (${files.map(([a, n]) => `${a} ${fmtInt(n)}`).join(", ")})${range}.`,
  );
  const verdict =
    r.editClaims === 0
      ? `No turn's final message claimed an edit in a form nerf-watch recognizes, so there is nothing to check.`
      : r.phantom === 0
      ? `No phantom edits: all ${fmtInt(r.editClaims)} turns that claimed an edit had a file-modifying action, or may be describing earlier work.`
      : `${fmtInt(r.phantom)} of ${fmtInt(r.editClaims)} turns that claimed an edit (${fmtPct(r.rate)}) had no file-modifying action.`;
  out.push(bold(verdict));
  out.push("");
  out.push(table(HEADERS, rows(r.byAgent), ALIGN));
  out.push("");
  out.push(table(HEADERS, rows(r.groups), ALIGN));
  out.push("");
  out.push(
    dim(
      "turns = finished turns (one user prompt through the agent's final message), not counting subagents. " +
        "edit claims = turns whose final message says it changed code. phantom = edit claims with no file-modifying action. " +
        `rate = phantom / edit claims.` +
        (r.skippedIncomplete ? ` Skipped ${fmtInt(r.skippedIncomplete)} interrupted, errored or unfinished turns.` : "") +
        (r.skippedHistory ? ` Not flagged: ${fmtInt(r.skippedHistory)} claim(s) in turns that ran git diff, log, show or blame, which may describe existing changes.` : "") +
        (r.skippedRecap ? ` Not flagged: ${fmtInt(r.skippedRecap)} claim(s) naming something an earlier turn of the session edited, which may be a recap.` : ""),
    ),
  );
  if (r.examples.length) {
    out.push("");
    out.push(bold(`Examples (newest first, ${r.examples.length} of ${fmtInt(r.phantom)}):`));
    r.examples.forEach((e, i) => {
      out.push(`${i + 1}. ${e.date}  ${e.agent} ${e.cliVersion}  ${e.model}  (${e.toolCalls} read-only tool call${e.toolCalls === 1 ? "" : "s"})`);
      out.push(`   "${e.claim}"`);
      out.push(dim(`   ${tilde(e.file)}:${e.line}`));
    });
  }
  out.push("");
  out.push(dim(PHANTOM_NOTE));
  out.push(dim(`Background: ${FINDINGS_URL}`));
  return out.join("\n");
}
