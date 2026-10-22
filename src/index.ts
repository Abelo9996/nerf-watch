export * from "./types.js";
export { adapters, getAdapter, claudeAdapter, codexAdapter } from "./adapters/index.js";
export { loadDataset, loadActivity, dropStaleCopies, type LoadOptions, type ActivityDataset } from "./load.js";
export {
  analyzePhantoms,
  formatPhantomReport,
  findEditClaim,
  classifyCommand,
  commandText,
  judgeTurn,
  FINDINGS_URL,
  PHANTOM_NOTE,
  type PhantomReport,
  type PhantomGroup,
  type PhantomExample,
  type CommandVerdict,
  type TurnVerdict,
} from "./phantom.js";
export { buildSegments, METRICS, MIN, MIN_STRATUM, median, normalizeModel, compareVersions } from "./metrics.js";
export {
  runDetectors,
  detectVersionShifts,
  detectTimeShifts,
  detectEffortDrops,
  detectModelMismatch,
  detectHiddenModels,
  detectFallbacks,
  compareCohorts,
  RULES,
  type CheckOptions,
} from "./detectors.js";
export { buildReport, reportToMarkdown, scrubModel, type Report } from "./report.js";
export { parseSince } from "./options.js";
export {
  buildSharePayload,
  scanPayload,
  leakReason,
  localIdentifiers,
  shareLink,
  formatPayload,
  DETECTOR_SIGNAL,
  SHARE_SCHEMA,
  type SharePayload,
  type ShareFinding,
  type ShareLink,
} from "./share.js";
export {
  buildCard,
  cardModel,
  renderCardSvg,
  proofCardModel,
  renderProofCardSvg,
  timePhrase,
  CARD_WIDTH,
  CARD_HEIGHT,
  CARD_REPO,
  CARD_COMMAND,
  type CardModel,
  type CardRow,
  type CardOptions,
  type ProofCardModel,
  type ProofCardRow,
} from "./card.js";
export { estimateTokens, fmtTokensApprox } from "./tokens.js";
export {
  configEnv,
  scanConfig,
  scanClaude,
  scanCodex,
  type ConfigEnv,
  type ConfigSource,
  type SourceKind,
} from "./config-scan.js";
export {
  logOverhead,
  fixedShare,
  buildAttribution,
  formatLogOverhead,
  formatConfigSources,
  formatAttribution,
  type LogOverhead,
  type Attribution,
  type AttributionRow,
} from "./overhead.js";
export {
  planClaudeAblation,
  measure,
  runOnce,
  DEFAULT_MEASURE_MODEL,
  DEFAULT_REPEATS,
  MEASURE_PROMPT,
  type Profile,
  type ProfileResult,
  type RunResult,
} from "./measure.js";
export {
  buildFixItems,
  applyItems,
  undo,
  listBackups,
  backupsDir,
  formatFixDryRun,
  disableMcpServer,
  setJsonKey,
  replaceSection,
  type FixItem,
  type FixChange,
  type ApplyResult,
  type UndoResult,
  type BackupSet,
} from "./fix.js";
export {
  buildProof,
  formatProof,
  sessionsStillNeeded,
  PROOF_MIN,
  type ProofReport,
  type ProofRow,
  type ProofMetric,
} from "./proof.js";
export { svgToPng } from "./png.js";
