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
  timePhrase,
  CARD_WIDTH,
  CARD_HEIGHT,
  CARD_REPO,
  CARD_COMMAND,
  type CardModel,
  type CardRow,
  type CardOptions,
} from "./card.js";
