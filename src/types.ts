/**
 * Canonical data model. Every adapter turns its agent's native log format into
 * these records. Detectors and reports only ever see these types, never raw
 * log lines, so adding an agent never touches detection logic.
 *
 * Privacy rule: none of these records may carry prompt text, tool output,
 * file paths, project names or working directories.
 */

export type AgentId = string; // "claude" | "codex" | future adapters

/** Token counts for one model API response, normalized across vendors. */
export interface Usage {
  /** Prompt tokens that were neither read from nor written to the cache. */
  input: number;
  /** Prompt tokens served from the prompt cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache (Anthropic reports this, OpenAI does not). */
  cacheCreation: number;
  /** Completion tokens, including reasoning tokens where the vendor folds them in. */
  output: number;
  /** Reasoning / thinking tokens when reported separately. */
  reasoning?: number;
}

/** One model API response ("turn" in nerf-watch terminology). */
export interface Turn {
  agent: AgentId;
  /** Opaque per-session key. Adapters must not use anything that reveals a path. */
  sessionKey: string;
  /** Used to drop duplicate copies of the same API response across files. */
  dedupeKey?: string;
  timestamp: number; // epoch ms
  cliVersion?: string;
  /** Model the user asked for (from config / session state), if the log records it. */
  requestedModel?: string;
  /** Model the API says actually answered, if the log records it. */
  servedModel?: string;
  /** Reasoning effort in force for this turn ("low" | "medium" | "high" | "xhigh" | "max" ...). */
  effort?: string;
  /** Context window size reported by the agent, in tokens. */
  contextWindow?: number;
  usage: Usage;
  /** True for the first API response of a session (startup overhead signal). */
  firstInSession?: boolean;
  /**
   * Subagent / sidechain traffic. Excluded from requested-vs-served comparisons
   * and from token metrics, because its size depends on which subagent ran.
   */
  sidechain?: boolean;
  /**
   * Opaque key for the workload the turn belongs to (a hash of the project
   * directory plus the client, such as CLI or desktop app). Token metrics are
   * compared within a workload so that a change in what you worked on is not
   * mistaken for a change in the agent. Never printed.
   */
  workloadKey?: string;
  /** The user picked the effort level in this session (for example with /effort). */
  effortSetByUser?: boolean;
  /** The log never recorded the final line of this response, so `usage.output` is a partial count. */
  partial?: boolean;
}

/** Outcome of one tool call. */
export interface ToolResult {
  agent: AgentId;
  sessionKey: string;
  timestamp: number;
  cliVersion?: string;
  model?: string;
  isError: boolean;
  /** See Turn.workloadKey. */
  workloadKey?: string;
  sidechain?: boolean;
}

/** Discrete events worth surfacing on their own. */
export type AgentEvent =
  | {
      kind: "fallback";
      agent: AgentId;
      timestamp: number;
      cliVersion?: string;
      fromModel: string;
      toModel: string;
    }
  | {
      kind: "compaction";
      agent: AgentId;
      timestamp: number;
      cliVersion?: string;
      model?: string;
      /** Prompt size when automatic compaction fired. A proxy for the usable context window. */
      preTokens: number;
      auto: boolean;
    }
  | {
      kind: "api_error";
      agent: AgentId;
      timestamp: number;
      cliVersion?: string;
      model?: string;
    };

export interface ParsedFile {
  turns: Turn[];
  toolResults: ToolResult[];
  events: AgentEvent[];
}

export interface Dataset extends ParsedFile {
  /** Number of session files read per agent. */
  files: Record<AgentId, number>;
  /** Lines that could not be parsed, per agent. Non-zero is normal for partially written files. */
  badLines: Record<AgentId, number>;
  /** Directories searched per agent. Shown to the user when nothing is found; never written to reports. */
  roots?: Record<AgentId, string[]>;
  /** Number of session files found before the `since` filter, per agent. */
  filesFound?: Record<AgentId, number>;
}

export interface DiscoverOptions {
  env: NodeJS.ProcessEnv;
  homedir: string;
  platform: NodeJS.Platform;
}

/**
 * An adapter knows where one agent keeps its session logs and how to parse
 * one file. It must be pure with respect to the file contents: no network,
 * no writes.
 */
export interface Adapter {
  id: AgentId;
  displayName: string;
  /** Candidate root directories, in priority order. Missing directories are fine. */
  defaultRoots(opts: DiscoverOptions): string[];
  /** Return every session log file under the given roots. */
  discover(roots: string[]): Promise<string[]>;
  /** Parse one session file. Must tolerate truncated and malformed lines. */
  parseFile(file: string): Promise<ParsedFile & { badLines: number }>;
  /**
   * Split one session file into user turns for `nerf-watch phantom`. Optional:
   * agents without it are skipped by that command.
   */
  parseActivity?(file: string): Promise<{ turns: ActivityTurn[]; badLines: number }>;
}

/**
 * One user turn: a user prompt through the agent's final message for it, as
 * read by `nerf-watch phantom`.
 *
 * Unlike the records above, this one carries the agent's final message and the
 * session file path, so it is for local output only and must never reach
 * share, card or report. It never carries prompt text.
 */
export interface ActivityTurn {
  agent: AgentId;
  /** Session file the turn came from. Printed locally so the user can check an example. */
  file: string;
  /** 1-based line of the final message in `file`. */
  line: number;
  /** Used to drop copies of the same turn across files (resumed or forked sessions). */
  dedupeKey?: string;
  /** Time of the final message, epoch ms. */
  timestamp: number;
  cliVersion?: string;
  model?: string;
  /** The agent's last message in the turn, after its last tool call. Empty when the turn ended on a tool call. */
  finalMessage: string;
  /** Tool calls and commands in the turn. */
  toolCalls: number;
  /**
   * The first action in the turn that changed, or could have changed, a file:
   * an edit tool, a patch, a shell command not known to be read-only, a
   * subagent, or any tool nerf-watch does not know. Undefined when every
   * action was read-only.
   */
  editAction?: string;
  /** The turn ran a command that shows existing changes (git diff, log, show, blame). */
  viewedHistory?: boolean;
  /** The turn was interrupted, a tool call was rejected, or the API returned an error. */
  incomplete?: boolean;
  /** Subagent turn. Skipped by `phantom`, since its "user" is another agent. */
  sidechain?: boolean;
  /**
   * Edits made by earlier turns of the same session file: the first `count`
   * entries of `edits` (the array is shared by every turn of the file). A claim
   * that names something an earlier turn edited may be a recap, not a claim.
   */
  prior?: { edits: EditRecord[]; count: number };
}

/** What one turn's edits touched, for telling a recap of earlier work from a new claim. */
export interface EditRecord {
  /** At least one edit has an unknown target: a shell command, a subagent or a tool nerf-watch does not know. */
  opaque: boolean;
  /** Files the edit tools and patches named. */
  paths: string[];
  /** New text from edit tools and patches, capped at EDIT_TEXT_MAX characters. */
  text: string;
}

export type Severity = "info" | "warn" | "alert";

export interface Evidence {
  label: string; // "before" / "after"
  versions?: string[];
  from?: string; // ISO date
  to?: string;
  samples: number;
  /** What `samples` counts: "turns", "sessions", "tool calls", "compactions", "events". */
  sampleUnit?: string;
  value: number;
  /** `value` formatted with its unit, for example "3,037 tokens" or "80.2%". */
  display: string;
}

export interface Finding {
  id: string; // detector id, e.g. "cache-hit-collapse"
  severity: Severity;
  agent: AgentId;
  model?: string;
  /** For model-mismatch findings: the model that was requested (`model` is the one that answered). */
  requestedModel?: string;
  title: string;
  explanation: string;
  evidence: Evidence[];
  /** One or two sentences on what to check or do next. */
  nextStep?: string;
  /** What changed: a CLI version boundary or a time window with no version change. */
  trigger: "version" | "time" | "event";
}

/** Baseline stats for one (agent, cli_version, model) group. */
export interface Segment {
  agent: AgentId;
  cliVersion: string;
  model: string;
  turns: number;
  /** Of `turns`, how many came from subagents. Token metrics in `check` use main-thread turns only. */
  subagentTurns: number;
  sessions: number;
  firstSeen: number;
  lastSeen: number;
  medianPromptTokens: number;
  medianNewInputTokens: number;
  medianCacheCreationTokens: number;
  medianOutputTokens: number;
  medianFirstTurnPromptTokens: number | null;
  cacheHitRate: number | null;
  toolCalls: number;
  toolErrors: number;
  toolErrorRate: number | null;
  effort: string | null;
  contextWindow: number | null;
}
