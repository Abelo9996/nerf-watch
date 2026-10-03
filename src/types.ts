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
}

export type Severity = "info" | "warn" | "alert";

export interface Evidence {
  label: string; // "before" / "after"
  versions?: string[];
  from?: string; // ISO date
  to?: string;
  samples: number;
  value: number;
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
