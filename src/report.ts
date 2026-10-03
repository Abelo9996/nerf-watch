import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSegments, compareVersions } from "./metrics.js";
import { countBySeverity, fmtInt, isoDate, SEGMENT_ALIGN, SEGMENT_HEADERS, segmentRows, table } from "./format.js";
import type { Dataset, Finding, Segment } from "./types.js";

export function toolVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "0.0.0";
  }
}

/**
 * Model ids are normally public names, but custom deployments can carry
 * account ids or endpoints (for example Bedrock ARNs or proxy URLs). Those are
 * replaced with a stable hash so the report stays shareable.
 */
export function scrubModel(m: string): string {
  if (/^[\w.\-\[\]]+$/.test(m) && !/\d{10,}/.test(m)) return m;
  return "custom-model-" + createHash("sha256").update(m).digest("hex").slice(0, 8);
}

export interface Report {
  tool: "nerf-watch";
  toolVersion: string;
  generatedAt: string;
  platform: string;
  window: { from: string | null; to: string | null };
  agents: { id: string; sessionFiles: number; turns: number; toolCalls: number; cliVersions: string[]; models: string[] }[];
  segments: Segment[];
  findings: Finding[];
  summary: { alert: number; warn: number; info: number };
  privacy: string;
}

export function buildReport(ds: Dataset, findings: Finding[]): Report {
  const segs = buildSegments(ds).map((s) => ({ ...s, model: scrubModel(s.model) }));
  const agents = Object.keys(ds.files)
    .filter((a) => ds.files[a] > 0)
    .map((a) => {
      const turns = ds.turns.filter((t) => t.agent === a);
      return {
        id: a,
        sessionFiles: ds.files[a],
        turns: turns.length,
        toolCalls: ds.toolResults.filter((t) => t.agent === a).length,
        cliVersions: [...new Set(turns.map((t) => t.cliVersion).filter((v): v is string => !!v))].sort(compareVersions),
        models: [...new Set(turns.map((t) => scrubModel(t.servedModel ?? t.requestedModel ?? "unknown")))].sort(),
      };
    });
  const scrubbedFindings = findings.map((f) => {
    if (!f.model) return f;
    const clean = scrubModel(f.model);
    if (clean === f.model) return f;
    const swap = (s: string) => s.split(f.model!).join(clean);
    return {
      ...f,
      model: clean,
      title: swap(f.title),
      explanation: swap(f.explanation),
      evidence: f.evidence.map((e) => ({ ...e, display: swap(e.display) })),
    };
  });
  return {
    tool: "nerf-watch",
    toolVersion: toolVersion(),
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    window: {
      from: ds.turns.length ? isoDate(ds.turns[0].timestamp) : null,
      to: ds.turns.length ? isoDate(ds.turns[ds.turns.length - 1].timestamp) : null,
    },
    agents,
    segments: segs,
    findings: scrubbedFindings,
    summary: countBySeverity(findings),
    privacy:
      "Generated locally by nerf-watch. Contains only aggregate token counts, rates, CLI versions, model ids and dates. No prompts, responses, tool output, file paths, project names or session ids.",
  };
}

export function reportToMarkdown(r: Report): string {
  const out: string[] = [];
  out.push(`# nerf-watch report`);
  out.push("");
  out.push(`Generated ${r.generatedAt.slice(0, 10)} by nerf-watch ${r.toolVersion} on ${r.platform}. Data window: ${r.window.from ?? "n/a"} to ${r.window.to ?? "n/a"}.`);
  out.push("");
  out.push(`> ${r.privacy}`);
  out.push("");
  out.push(`## Summary`);
  out.push("");
  out.push(`${r.summary.alert} alert(s), ${r.summary.warn} warning(s), ${r.summary.info} info.`);
  out.push("");
  out.push(`| agent | session files | turns | tool calls | CLI versions | models |`);
  out.push(`|---|---:|---:|---:|---|---|`);
  for (const a of r.agents) {
    const vs = a.cliVersions.length > 4 ? `${a.cliVersions[0]} ... ${a.cliVersions[a.cliVersions.length - 1]} (${a.cliVersions.length})` : a.cliVersions.join(", ");
    out.push(`| ${a.id} | ${fmtInt(a.sessionFiles)} | ${fmtInt(a.turns)} | ${fmtInt(a.toolCalls)} | ${vs} | ${a.models.join(", ")} |`);
  }
  out.push("");
  out.push(`## Findings`);
  out.push("");
  if (!r.findings.length) out.push("No changes crossed a threshold.");
  for (const f of r.findings) {
    out.push(`### [${f.severity.toUpperCase()}] ${f.agent} / ${f.model ?? "-"}: ${f.title}`);
    out.push("");
    out.push(f.explanation);
    out.push("");
    out.push(`| | value | CLI versions | dates | samples |`);
    out.push(`|---|---|---|---|---:|`);
    for (const e of f.evidence) {
      out.push(`| ${e.label} | ${e.display} | ${(e.versions ?? []).join(", ")} | ${e.from ?? ""} to ${e.to ?? ""} | ${fmtInt(e.samples)} |`);
    }
    out.push("");
  }
  out.push(`## Baselines per (agent, CLI version, model)`);
  out.push("");
  out.push("```");
  out.push(table(SEGMENT_HEADERS, segmentRows(r.segments), SEGMENT_ALIGN));
  out.push("```");
  out.push("");
  return out.join("\n");
}
