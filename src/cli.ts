#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, sep } from "node:path";
import { cac } from "cac";
import { adapters } from "./adapters/index.js";
import { runDetectors } from "./detectors.js";
import { CARD_WIDTH, cardModel, proofCardModel, renderCardSvg, renderProofCardSvg } from "./card.js";
import { bold, checkHeadline, countBySeverity, datasetSummary, dim, formatFinding, SEGMENT_ALIGN, SEGMENT_HEADERS, segmentRows, table, tooLittleHistory } from "./format.js";
import { loadActivity, loadDataset } from "./load.js";
import { analyzePhantoms, formatPhantomReport, PHANTOM_NOTE } from "./phantom.js";
import { buildSegments } from "./metrics.js";
import { buildReport, reportToMarkdown, toolVersion } from "./report.js";
import { buildSharePayload, localIdentifiers, openInBrowser, scanPayload, shareLink, type SharePayload } from "./share.js";
import type { Severity } from "./types.js";
import { parseAgents, parsePositiveInt, parseRoots, parseSince, UsageError } from "./options.js";
import type { Dataset } from "./types.js";
import { configEnv, scanConfig } from "./config-scan.js";
import { buildAttribution, formatAttribution, formatConfigSources, formatLogOverhead, logOverhead } from "./overhead.js";
import { DEFAULT_MEASURE_MODEL, DEFAULT_REPEATS, measure, planClaudeAblation } from "./measure.js";
import { applyItems as applyFixItems, backupsDir, buildFixItems, formatFixDryRun, listBackups, undo as undoFix } from "./fix.js";
import { buildProof, formatProof } from "./proof.js";

interface Common {
  since?: string;
  agent?: string | string[];
  root?: string | string[];
  json?: boolean;
}

async function load(o: Common) {
  const roots = parseRoots(o.root);
  // --root claude=DIR means "read these Claude Code logs", not "these plus every other agent's defaults".
  const agents = parseAgents(o.agent) ?? (roots ? Object.keys(roots) : undefined);
  return loadDataset({ since: parseSince(o.since), agents, roots, onProgress: logProgress() });
}

/** A stderr progress line for slow log reads. Only on a TTY, throttled, cleared when done. */
function logProgress(): ((done: number, total: number) => void) | undefined {
  if (!process.stderr.isTTY || process.env.NO_COLOR === "1") return undefined;
  let last = 0;
  return (done, total) => {
    if (total < 200) return; // fast enough that a progress line only flickers
    const now = Date.now();
    if (done < total && now - last < 100) return;
    last = now;
    if (done >= total) process.stderr.write(`\r\u001b[K`);
    else process.stderr.write(`\rReading ${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")} session files...\u001b[K`);
  };
}

/** Home directory shown as ~ so the message stays short. */
function tilde(p: string): string {
  const h = homedir();
  return h && (p === h || p.startsWith(h + sep)) ? "~" + p.slice(h.length) : p;
}

/** Why there is nothing to analyze, and what to do about it. */
export function noDataMessage(ds: Dataset, since?: string): string {
  const found = Object.values(ds.filesFound ?? {}).reduce((a, b) => a + b, 0);
  const kept = Object.values(ds.files).reduce((a, b) => a + b, 0);
  if (found > 0 && since !== undefined) {
    return (
      `Found ${found.toLocaleString("en-US")} session file(s), but none have model responses since ${since}. ` +
      "Try a longer --since (for example --since 30d) or leave it out."
    );
  }
  if (found > 0 || kept > 0) {
    return (
      `Found ${found.toLocaleString("en-US")} session file(s), but none of them contain model responses with token counts. ` +
      "If these are Claude Code or Codex logs, the log format may have changed: please open an issue at https://github.com/Abelo9996/nerf-watch/issues."
    );
  }
  const dirs = Object.values(ds.roots ?? {}).flat().map(tilde);
  return (
    `No Claude Code or Codex session logs found. Looked in: ${dirs.join(", ") || "(no folders)"}. ` +
    "Use Claude Code or Codex for a few sessions first, or point nerf-watch at your logs with --root claude=DIR or --root codex=DIR " +
    "(or set CLAUDE_CONFIG_DIR or CODEX_HOME)."
  );
}

function noData(ds: Dataset, o: Common): void {
  const msg = noDataMessage(ds, o.since);
  if (o.json) console.log(JSON.stringify({ error: "no-data", message: msg }));
  else console.log(msg);
}

interface ShareOpts extends Common {
  open?: boolean;
}

/**
 * Builds the anonymized share payload, prints exactly what would be shared and
 * a prefilled issue URL. Opens the browser only with --open. No network calls.
 */
async function share(o: ShareOpts): Promise<void> {
  const ds = await load(o);
  if (!ds.turns.length) return noData(ds, o);
  const ids = localIdentifiers();
  const payload: SharePayload = buildSharePayload(ds, runDetectors(ds), ids);
  const problems = scanPayload(payload, ids);
  if (problems.length) {
    console.error("nerf-watch: refusing to share. The anonymized payload still contains something that could identify you:");
    for (const p of problems) console.error(`  ${p}`);
    console.error("Nothing was printed or opened. Please report this as a nerf-watch bug (without the values).");
    process.exitCode = 2;
    return;
  }
  if (!payload.findings.length) {
    const msg = "No warning or alert findings, so there is nothing to share.";
    if (o.json) console.log(JSON.stringify({ payload, url: null, reportPrefilled: false, message: msg }, null, 2));
    else console.log(msg);
    return;
  }
  const link = shareLink(payload);
  if (o.json) {
    console.log(JSON.stringify({ payload, url: link.url, reportPrefilled: link.reportPrefilled }, null, 2));
  } else {
    console.log(
      dim(
        "The open-agent-lab regression watch collects anonymized findings from many users, so a change that hits many people " +
          "shows up as many matching reports instead of one anecdote.",
      ),
    );
    console.log("");
    console.log(bold(`This is exactly what would be shared (${payload.findings.length} finding(s)). Nothing has been sent:`));
    console.log("");
    console.log(link.json);
    console.log("");
    console.log(
      dim(
        "It holds only detector ids, severities, CLI versions, model ids, dates, sample counts and before/after values. " +
          "No prompts, paths, project names, session ids, user or host names.",
      ),
    );
    console.log("");
    if (link.reportPrefilled) {
      console.log(bold("To share it, open this link. It is a prefilled public GitHub issue on open-agent-lab; review it and submit:"));
    } else {
      console.log(
        bold(
          `The JSON is too long to prefill in a link. This link opens the form with the other fields filled in; ` +
            `paste the JSON above into "Anonymized nerf-watch report (JSON)":`,
        ),
      );
    }
    console.log(link.url);
    console.log("");
    console.log(
      dim(
        'On the form, fill in "What you observed" (required: what changed for you, and anything you changed yourself around then) ' +
          "and tick the two checkboxes. The issue is public.",
      ),
    );
  }
  if (o.open) {
    if (openInBrowser(link.url)) console.error(dim("Opened the form in your browser."));
    else console.error("nerf-watch: could not open a browser. Copy the link above instead.");
  } else if (!o.json) {
    console.log(dim("Run with --open to open it in your browser."));
  }
}

/** The `nerf-watch card` command for the data `check` just read: same --since and --agent. */
export function cardCommand(o: Pick<Common, "since" | "agent">): string {
  const parts = ["nerf-watch", "card"];
  if (o.since !== undefined && /^[\w:.+-]+$/.test(String(o.since))) parts.push("--since", String(o.since));
  for (const a of parseAgents(o.agent) ?? []) parts.push("--agent", a);
  return parts.join(" ");
}


interface CardOpts extends Common {
  out: string;
  recentDays: number;
  baselineDays: number;
}

/**
 * Writes a 1200x630 SVG of the result, built from the same anonymized payload
 * `share` shows, after the same privacy scan. No network calls.
 */
async function card(o: CardOpts): Promise<void> {
  const out = String(o.out);
  const ext = extname(out).toLowerCase();
  if (ext !== ".svg" && ext !== ".png") throw new UsageError(`--out must end in .svg or .png, got "${out}"`);
  const recentDays = parsePositiveInt("--recent-days", o.recentDays);
  const baselineDays = parsePositiveInt("--baseline-days", o.baselineDays);
  const ds = await load(o);
  if (!ds.turns.length) return noData(ds, o);
  const findings = runDetectors(ds, { recentDays, baselineDays });
  const ids = localIdentifiers();
  const payload = buildSharePayload(ds, findings, ids);
  const problems = scanPayload(payload, ids);
  if (problems.length) {
    console.error("nerf-watch: refusing to make a card. The anonymized data still contains something that could identify you:");
    for (const p of problems) console.error(`  ${p}`);
    console.error("Nothing was written. Please report this as a nerf-watch bug (without the values).");
    process.exitCode = 2;
    return;
  }
  const notable = findings.filter((f) => f.severity !== "info").length;
  const skip = (message: string) => {
    if (o.json) console.log(JSON.stringify({ out: null, message }));
    else console.log(message);
  };
  if (!payload.findings.length && notable) {
    return skip(
      `check found ${notable} warning(s) or alert(s), but none of them can be shown in anonymized form (no CLI version recorded), so no card was written. ` +
        "Run `nerf-watch check` for the details.",
    );
  }
  if (!payload.findings.length && tooLittleHistory(ds)) {
    return skip(
      "No card yet: there is not enough history to compare, so an all-clear would not mean much. " +
        "A comparison needs at least 5 sessions and 50 turns on the same model on each side. Run it again after more sessions.",
    );
  }
  const sessions = new Set(ds.turns.map((t) => t.sessionKey)).size;
  const model = cardModel(payload, { since: o.since, totalFindings: notable, sessions });
  const svg = renderCardSvg(model);
  await writeCard(out, svg);
  if (o.json) {
    console.log(JSON.stringify({ out, kind: model.kind, headline: model.headline, findings: model.rows.length, more: model.more }, null, 2));
    return;
  }
  console.log(`Wrote ${out} (1200x630 ${extname(out).toLowerCase() === ".png" ? "PNG" : "SVG"}): ${model.headline}`);
  console.log(
    dim(
      "It shows only what `nerf-watch share` would share: agent names, CLI versions, model ids, dates and numbers. " +
        "No prompts, paths, project names, session ids, user or host names. Look at it before posting.",
    ),
  );
}

/** Write an SVG card as .svg, or rasterize it to .png in-process (no system tools). */
async function writeCard(out: string, svg: string): Promise<void> {
  if (extname(out).toLowerCase() === ".png") {
    const { svgToPng } = await import("./png.js");
    writeFileSync(out, await svgToPng(svg, CARD_WIDTH));
  } else {
    writeFileSync(out, svg);
  }
}

interface PhantomOpts extends Common {
  limit: number;
}

/**
 * Turns whose final message claims an edit but that contain no file-modifying
 * action. Local output only: never part of share, card or report.
 */
async function phantom(o: PhantomOpts): Promise<void> {
  const limit = Number(o.limit);
  if (!Number.isInteger(limit) || limit < 0) throw new UsageError(`--limit must be a whole number, 0 or more, got "${o.limit}"`);
  const roots = parseRoots(o.root);
  const agents = parseAgents(o.agent) ?? (roots ? Object.keys(roots) : undefined);
  const act = await loadActivity({ since: parseSince(o.since), agents, roots });
  const r = analyzePhantoms(act.turns, act.files, { limit });
  if (!r.turns) {
    const msg = noDataMessage(
      { turns: [], toolResults: [], events: [], files: act.files, badLines: act.badLines, roots: act.roots, filesFound: act.filesFound },
      o.since,
    ).replace("contain model responses with token counts", "contain finished turns");
    if (o.json) console.log(JSON.stringify({ error: "no-data", message: msg }));
    else console.log(msg);
    return;
  }
  if (o.json) {
    console.log(JSON.stringify({ ...r, note: PHANTOM_NOTE }, null, 2));
    return;
  }
  console.log(formatPhantomReport(r, act.turns.filter((t) => !t.sidechain).length));
}

interface OverheadOpts extends Common {
  measure?: boolean;
  yes?: boolean;
  repeats: number;
  measureModel: string;
  recentDays: number;
}

/**
 * `overhead`: log trend, config sources, and (with --measure) a ranked
 * attribution from ablation runs. Measured runs cost money and ask first.
 */
async function overhead(o: OverheadOpts): Promise<void> {
  const recentDays = parsePositiveInt("--recent-days", o.recentDays);
  const agents = parseAgents(o.agent);
  const ds = await load(o);
  const logs = logOverhead(ds, { recentDays });
  const cfg = configEnv({ cwd: process.cwd() });
  const sources = scanConfig(cfg, agents);

  if (!o.measure) {
    if (o.json) {
      console.log(JSON.stringify({ logs, sources }, null, 2));
      return;
    }
    console.log(formatLogOverhead(logs));
    console.log("");
    console.log(formatConfigSources(sources));
    console.log("");
    console.log(dim("To attribute real tokens to each source: nerf-watch overhead --measure --yes"));
    return;
  }

  // Measured attribution. Claude only.
  if (agents && !agents.includes("claude")) {
    const msg = "Measured attribution runs through the Claude Code CLI only. For Codex, use the config and log evidence above.";
    if (o.json) console.log(JSON.stringify({ error: "unsupported", message: msg }));
    else console.log(msg);
    return;
  }
  const repeats = parsePositiveInt("--repeats", o.repeats);
  const { profiles, cleanup } = planClaudeAblation(cfg);
  const totalRuns = profiles.length * repeats;
  const estCost = totalRuns * 0.003; // rough upper bound per cheap startup run
  if (!o.yes) {
    const plan = {
      runs: totalRuns,
      profiles: profiles.length,
      repeats,
      model: o.measureModel,
      estimatedCostUsd: Number(estCost.toFixed(2)),
    };
    cleanup();
    if (o.json) {
      console.log(JSON.stringify({ needsConsent: true, plan }, null, 2));
    } else {
      console.log(
        `Measured attribution would run the Claude CLI ${totalRuns} time(s) ` +
          `(${profiles.length} profile(s) x ${repeats} repeat(s)) on ${o.measureModel}, costing about $${estCost.toFixed(2)}.`,
      );
      console.log("Re-run with --yes to allow it: nerf-watch overhead --measure --yes");
    }
    return;
  }
  try {
    if (!o.json) console.error(dim(`Running ${totalRuns} startup measurement(s) on ${o.measureModel}...`));
    let last = 0;
    const results = await measure(cfg, profiles, {
      model: o.measureModel,
      repeats,
      onProgress: (done, total) => {
        if (!o.json && done !== last) {
          last = done;
          process.stderr.write(`\r  ${done}/${total} runs done   `);
        }
      },
    });
    if (!o.json) process.stderr.write("\n");
    const attribution = buildAttribution(results, sources, o.measureModel);
    if (o.json) {
      console.log(JSON.stringify({ logs, sources, measured: results, attribution }, null, 2));
      return;
    }
    console.log(formatLogOverhead(logs));
    console.log("");
    if (attribution) {
      console.log(formatAttribution(attribution));
    } else {
      console.log("Measurement did not produce enough successful runs to attribute overhead. Check that `claude` is on PATH and you are logged in.");
    }
    console.log("");
    console.log(formatConfigSources(sources));
  } finally {
    cleanup();
  }
}

interface FixOpts extends Common {
  apply?: boolean;
  item?: string | string[];
  yes?: boolean;
}

/**
 * `fix`: list reversible changes that cut overhead. Dry run by default; --apply
 * writes only the items named with --item (or, interactively, the ones ticked).
 */
async function fix(o: FixOpts): Promise<void> {
  const agents = parseAgents(o.agent);
  const cfg = configEnv({ cwd: process.cwd() });
  const sources = scanConfig(cfg, agents);
  const items = buildFixItems(cfg, sources);
  const picked = o.item ? (Array.isArray(o.item) ? o.item : [o.item]).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean) : [];

  if (!o.apply) {
    if (o.json) {
      console.log(JSON.stringify({ items: items.map((i) => ({ id: i.id, agent: i.agent, title: i.title, kind: i.kind, estTokensSaved: i.estTokensSaved, changes: i.changes.map((c) => ({ path: c.path.replace(cfg.home, "~"), summary: c.summary })), caveat: i.caveat })) }, null, 2));
      return;
    }
    console.log(formatFixDryRun(items, cfg.home));
    return;
  }

  // Apply.
  const editIds = items.filter((i) => i.kind === "edit").map((i) => i.id);
  const toApply = picked.length ? picked : editIds; // --item names a subset; nothing preselected without it in interactive use
  if (!picked.length && !o.yes && process.stdin.isTTY) {
    // Interactive: nothing preselected. Ask the user to pass --item since we avoid a TUI dependency.
    console.log(formatFixDryRun(items, cfg.home));
    console.log("");
    console.log("Nothing is selected by default. Apply specific items with:");
    console.log(`  nerf-watch fix --apply --item <id>[,<id>...]   (ids: ${editIds.join(", ") || "none"})`);
    return;
  }
  const unknown = toApply.filter((id) => !items.some((i) => i.id === id));
  if (unknown.length) throw new UsageError(`Unknown fix item(s): ${unknown.join(", ")}. Run \`nerf-watch fix\` to list ids.`);
  const result = applyItems(cfg, toApply);
  if (o.json) {
    console.log(JSON.stringify({ ...result, changed: result.changed.map((c) => ({ path: c.path.replace(cfg.home, "~"), summary: c.summary })) }, null, 2));
    return;
  }
  if (!result.changed.length) {
    console.log("Nothing to change (selected items were already applied or are advice only).");
    return;
  }
  console.log(bold(`Applied ${result.changed.length} change(s). Every touched file was backed up first.`));
  for (const c of result.changed) console.log(`  ${c.summary}`);
  console.log("");
  console.log(dim(`Backup id ${result.backupId}. Undo exactly with: nerf-watch undo`));
}

function applyItems(cfg: ReturnType<typeof configEnv>, ids: string[]) {
  const sources = scanConfig(cfg);
  const items = buildFixItems(cfg, sources);
  return applyFixItems(cfg, items, ids);
}

interface UndoOpts {
  json?: boolean;
  backup?: string;
}

async function undoCmd(o: UndoOpts): Promise<void> {
  const cfg = configEnv({ cwd: process.cwd() });
  const available = listBackups(cfg);
  if (!available.length) {
    const msg = "No nerf-watch backups to undo. `nerf-watch fix --apply` creates one.";
    if (o.json) console.log(JSON.stringify({ error: "no-backups", message: msg }));
    else console.log(msg);
    return;
  }
  const result = undoFix(cfg, o.backup);
  if (o.json) {
    console.log(JSON.stringify({ ...result, restored: result.restored.map((p) => p.replace(cfg.home, "~")), removed: result.removed.map((p) => p.replace(cfg.home, "~")) }, null, 2));
    return;
  }
  console.log(bold(`Restored ${result.restored.length} file(s) from backup ${result.backupId}.`));
  for (const p of result.restored) console.log(`  ${p.replace(cfg.home, "~")}`);
  for (const p of result.removed) console.log(`  removed ${p.replace(cfg.home, "~")} (created by the fix)`);
  if (result.mismatches.length) console.error(`nerf-watch: warning: ${result.mismatches.length} file(s) did not match their backup checksum.`);
}

interface ProofOpts extends Common {
  sinceFix?: string;
  card?: string;
}

/** `proof`: compare before/after the fix timestamp from real logs. */
async function proof(o: ProofOpts): Promise<void> {
  const cfg = configEnv({ cwd: process.cwd() });
  let fixTs: number | undefined;
  if (o.sinceFix) {
    fixTs = parseSince(o.sinceFix);
  } else {
    const latest = listBackups(cfg)[0];
    if (latest) {
      try {
        const set = JSON.parse(readFileSync(join(backupsDir(cfg), latest, "backup.json"), "utf8"));
        fixTs = Date.parse(set.createdAt);
      } catch {
        fixTs = undefined;
      }
    }
  }
  if (fixTs === undefined || Number.isNaN(fixTs)) {
    throw new UsageError("No fix timestamp. Run `nerf-watch fix --apply` first, or pass --since-fix <YYYY-MM-DD or span like 3d>.");
  }
  const ds = await load(o);
  if (!ds.turns.length) return noData(ds, o);
  const report = buildProof(ds, fixTs);
  if (o.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatProof(report));
  if (o.card) {
    const sessionsN = new Set(ds.turns.map((t) => t.sessionKey)).size;
    const m = proofCardModel(report, { version: toolVersion(), responses: ds.turns.length, sessions: sessionsN });
    if (!m) {
      console.log("");
      console.log("No before/after card yet: not enough sessions on both sides of the fix.");
    } else {
      await writeCard(o.card, renderProofCardSvg(m));
      console.log("");
      console.log(`Wrote ${o.card}: ${m.headline}`);
    }
  }
}

export function buildCli() {
  const cli = cac("nerf-watch");

  const common = (cmd: ReturnType<typeof cli.command>) =>
    cmd
      .option("--since <when>", "Only use records since a date (YYYY-MM-DD) or span (7d, 2w, 12h)")
      .option("--agent <id>", `Only read one agent: ${adapters.map((a) => a.id).join(" | ")} (repeatable)`)
      .option("--root <agent=dir>", "Read an agent's logs from a custom directory (repeatable)")
      .option("--json", "Machine-readable JSON output");

  common(cli.command("scan", "Parse all sessions and print per-(agent, CLI version, model) baselines")).action(async (o: Common) => {
    const ds = await load(o);
    const segs = buildSegments(ds);
    if (o.json) {
      console.log(JSON.stringify({ summary: { files: ds.files, turns: ds.turns.length, toolCalls: ds.toolResults.length, badLines: ds.badLines }, segments: segs }, null, 2));
      return;
    }
    if (!ds.turns.length) return noData(ds, { ...o, json: false });
    console.log(dim(datasetSummary(ds)));
    console.log("");
    console.log(table(SEGMENT_HEADERS, segmentRows(segs), SEGMENT_ALIGN));
    console.log("");
    console.log(
      dim(
        "Medians are per API response, including subagents. Cache hit = cached prompt tokens / all prompt tokens. " +
          "`nerf-watch check` compares main-thread traffic only, within each project.",
      ),
    );
  });

  common(cli.command("check", "Detect changes you did not make. Exits 1 when alerts are found"))
    .option("--fail-on <level>", "Exit non-zero at this severity: alert | warn | never", { default: "alert" })
    .option("--recent-days <n>", "Recent window for same-version drift checks", { default: 7 })
    .option("--baseline-days <n>", "Baseline window before the recent window", { default: 28 })
    .action(async (o: Common & { failOn: string; recentDays: number; baselineDays: number }) => {
      if (!["alert", "warn", "never"].includes(o.failOn)) throw new UsageError(`--fail-on must be alert, warn or never`);
      const recentDays = parsePositiveInt("--recent-days", o.recentDays);
      const baselineDays = parsePositiveInt("--baseline-days", o.baselineDays);
      const ds = await load(o);
      if (!ds.turns.length) return noData(ds, o);
      const findings = runDetectors(ds, { recentDays, baselineDays });
      const counts = countBySeverity(findings);
      if (o.json) {
        console.log(JSON.stringify({ summary: counts, findings }, null, 2));
      } else {
        const [read, verdict] = checkHeadline(ds, findings);
        console.log(read);
        console.log(bold(verdict));
        console.log("");
        for (const f of findings) {
          console.log(formatFinding(f));
          console.log("");
        }
        console.log(bold(`${counts.alert} alert(s), ${counts.warn} warning(s), ${counts.info} info`));
        const notable = findings.some((f) => f.severity !== "info");
        if (notable) console.log(dim("Share an anonymized summary with the open-agent-lab regression watch: nerf-watch share"));
        if (notable || !tooLittleHistory(ds)) console.log(dim(`Make a shareable image of this result: ${cardCommand(o)}`));
      }
      const failAt: Severity[] = o.failOn === "warn" ? ["alert", "warn"] : o.failOn === "alert" ? ["alert"] : [];
      if (findings.some((f) => failAt.includes(f.severity))) process.exitCode = 1;
    });

  common(cli.command("share", "Show the anonymized findings to share and print a prefilled regression-report issue link"))
    .option("--open", "Open the link in your browser")
    .action(share);

  common(cli.command("card", "Write a 1200x630 SVG image of your result to post (same anonymized data as share)"))
    .option("--out <file>", "Output file (.svg)", { default: "nerf-watch-card.svg" })
    .option("--recent-days <n>", "Recent window for same-version drift checks", { default: 7 })
    .option("--baseline-days <n>", "Baseline window before the recent window", { default: 28 })
    .action(card);

  common(cli.command("phantom", "Find turns where the agent said it changed code but made no edit (local only)"))
    .option("--limit <n>", "Number of examples to show", { default: 10 })
    .action(phantom);

  common(cli.command("report", "Write an anonymized, shareable report (no prompts, paths or project names)"))
    .option("--out <file>", "Output file; .md or .json picks the format", { default: "nerf-watch-report.md" })
    .option("--share", "Same as `nerf-watch share`: print a prefilled regression-report issue link instead of writing a file")
    .option("--open", "With --share, open the link in your browser")
    .action(async (o: Common & { out: string; share?: boolean; open?: boolean }) => {
      if (o.share) return share(o);
      const ext = extname(String(o.out)).toLowerCase();
      if (!o.json && ext !== ".md" && ext !== ".json") throw new UsageError(`--out must end in .md or .json, got "${o.out}"`);
      const ds = await load(o);
      if (!ds.turns.length) return noData(ds, o);
      const r = buildReport(ds, runDetectors(ds));
      if (o.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      writeFileSync(o.out, ext === ".json" ? JSON.stringify(r, null, 2) + "\n" : reportToMarkdown(r));
      console.log(`Wrote ${o.out} (${r.findings.length} finding(s)). Review it before sharing; it contains only aggregate numbers, versions, model ids and dates.`);
    });

  common(cli.command("overhead", "Show what you pay before you type anything, and why"))
    .option("--measure", "Attribute real tokens to each source with ablation runs through the agent CLI (spends a little)")
    .option("--yes", "With --measure, allow the ablation runs to spend without prompting")
    .option("--repeats <n>", "With --measure, runs per profile (median beats noise)", { default: DEFAULT_REPEATS })
    .option("--measure-model <id>", "With --measure, the model to run", { default: DEFAULT_MEASURE_MODEL })
    .option("--recent-days <n>", "Recent window for the startup trend", { default: 7 })
    .action(overhead);

  common(cli.command("fix", "Turn the overhead into reversible changes (dry run by default)"))
    .option("--apply", "Apply the selected items (use --item to choose); backs up every touched file")
    .option("--item <id>", "Apply this fix item id (repeatable); nothing is applied without it", {})
    .option("--yes", "Allow apply without an interactive selection")
    .action(fix);

  cli
    .command("undo", "Restore every file a previous `fix --apply` changed, byte for byte")
    .option("--backup <id>", "Restore a specific backup id (default: the newest)")
    .option("--json", "Machine-readable JSON output")
    .action(undoCmd);

  common(cli.command("proof", "Compare your sessions before and after the fix from real logs"))
    .option("--since-fix <when>", "Fix timestamp (YYYY-MM-DD or span like 3d); default: the newest fix backup")
    .option("--card <file>", "Also write a before/after card (.svg or .png)")
    .action(proof);

  cli.help();
  cli.version(toolVersion());
  return cli;
}

async function main() {
  const cli = buildCli();
  try {
    cli.parse(process.argv, { run: false });
    if (!cli.matchedCommand) {
      if (cli.options.help || cli.options.version) return;
      if (cli.args.length) throw new UsageError(`Unknown command "${cli.args[0]}". Try: nerf-watch --help`);
      cli.outputHelp();
      console.log("Start here: nerf-watch check   (reads your local Claude Code and Codex logs; nothing is uploaded)");
      return;
    }
    await cli.runMatchedCommand();
  } catch (e) {
    if (e instanceof UsageError || (e instanceof Error && e.name === "CACError")) {
      console.error(`nerf-watch: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 3;
  }
}

main();
