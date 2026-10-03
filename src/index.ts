export * from "./types.js";
export { adapters, getAdapter, claudeAdapter, codexAdapter } from "./adapters/index.js";
export { loadDataset, dropStaleCopies, type LoadOptions } from "./load.js";
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
