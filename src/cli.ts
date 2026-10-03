#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { extname } from "node:path";
import { cac } from "cac";
import { adapters } from "./adapters/index.js";
import { runDetectors } from "./detectors.js";
import { bold, countBySeverity, datasetSummary, dim, formatFinding, SEGMENT_ALIGN, SEGMENT_HEADERS, segmentRows, table } from "./format.js";
import { loadDataset } from "./load.js";
import { buildSegments } from "./metrics.js";
import { buildReport, reportToMarkdown, toolVersion } from "./report.js";
import { buildSharePayload, localIdentifiers, openInBrowser, scanPayload, shareLink, type SharePayload } from "./share.js";
import type { Severity } from "./types.js";
import { parseAgents, parseRoots, parseSince, UsageError } from "./options.js";

interface Common {
  since?: string;
  agent?: string | string[];
  root?: string | string[];
  json?: boolean;
}

async function load(o: Common) {
  return loadDataset({ since: parseSince(o.since), agents: parseAgents(o.agent), roots: parseRoots(o.root) });
}

function noData(json: boolean | undefined): void {
  const msg =
    "No Claude Code or Codex session logs found. Looked in ~/.claude/projects, ~/.config/claude/projects and ~/.codex/sessions " +
    "(override with CLAUDE_CONFIG_DIR, CODEX_HOME or --root agent=dir).";
  if (json) console.log(JSON.stringify({ error: "no-data", message: msg }));
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
  if (!ds.turns.length) return noData(o.json);
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
  }
  if (o.open) {
    if (openInBrowser(link.url)) console.error(dim("Opened the form in your browser."));
    else console.error("nerf-watch: could not open a browser. Copy the link above instead.");
  } else if (!o.json) {
    console.log(dim("Run with --open to open it in your browser."));
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
    if (!ds.turns.length) return noData(false);
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
      const ds = await load(o);
      if (!ds.turns.length) return noData(o.json);
      const findings = runDetectors(ds, { recentDays: Number(o.recentDays), baselineDays: Number(o.baselineDays) });
      const counts = countBySeverity(findings);
      if (o.json) {
        console.log(JSON.stringify({ summary: counts, findings }, null, 2));
      } else {
        console.log(dim(datasetSummary(ds)));
        console.log("");
        if (!findings.length) console.log("No changes crossed a threshold.");
        for (const f of findings) {
          console.log(formatFinding(f));
          console.log("");
        }
        console.log(bold(`${counts.alert} alert(s), ${counts.warn} warning(s), ${counts.info} info`));
        if (findings.some((f) => f.severity !== "info")) console.log(dim("Share an anonymized summary with the open-agent-lab regression watch: nerf-watch share"));
      }
      const failAt: Severity[] = o.failOn === "warn" ? ["alert", "warn"] : o.failOn === "alert" ? ["alert"] : [];
      if (findings.some((f) => failAt.includes(f.severity))) process.exitCode = 1;
    });

  common(cli.command("share", "Show the anonymized findings to share and print a prefilled regression-report issue link"))
    .option("--open", "Open the link in your browser")
    .action(share);

  common(cli.command("report", "Write an anonymized, shareable report (no prompts, paths or project names)"))
    .option("--out <file>", "Output file; .md or .json picks the format", { default: "nerf-watch-report.md" })
    .option("--share", "Same as `nerf-watch share`: print a prefilled regression-report issue link instead of writing a file")
    .option("--open", "With --share, open the link in your browser")
    .action(async (o: Common & { out: string; share?: boolean; open?: boolean }) => {
      if (o.share) return share(o);
      const ds = await load(o);
      if (!ds.turns.length) return noData(o.json);
      const r = buildReport(ds, runDetectors(ds));
      if (o.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      const ext = extname(o.out).toLowerCase();
      if (ext !== ".md" && ext !== ".json") throw new UsageError(`--out must end in .md or .json`);
      writeFileSync(o.out, ext === ".json" ? JSON.stringify(r, null, 2) + "\n" : reportToMarkdown(r));
      console.log(`Wrote ${o.out} (${r.findings.length} finding(s)). Review it before sharing; it contains only aggregate numbers, versions, model ids and dates.`);
    });

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
