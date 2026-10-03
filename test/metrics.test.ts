import { describe, expect, it } from "vitest";
import { compareVersions, median, mode, normalizeModel, sessionMedian } from "../src/metrics.js";
import { parseSince } from "../src/options.js";
import { scrubModel } from "../src/report.js";
import type { Turn } from "../src/types.js";

describe("metrics helpers", () => {
  it("median and mode", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(mode([1, 2, 2, 3])).toBe(2);
    expect(mode([5, 9])).toBe(9); // ties go to the larger value
  });

  it("sessionMedian resists one dominant session", () => {
    const t = (s: string, v: number) => ({ sessionKey: s, usage: { input: v, cacheRead: 0, cacheCreation: 0, output: 0 } }) as Turn;
    const turns = [...Array(100).fill(0).map(() => t("big", 10_000)), t("a", 100), t("b", 110), t("c", 120)];
    expect(sessionMedian(turns, (x) => x.usage.input)).toBe(115);
  });

  it("compares CLI versions numerically, prereleases first", () => {
    const vs = ["2.1.10", "2.1.9", "0.133.0-alpha.1", "0.133.0", "0.124.0-alpha.2"];
    expect([...vs].sort(compareVersions)).toEqual(["0.124.0-alpha.2", "0.133.0-alpha.1", "0.133.0", "2.1.9", "2.1.10"]);
  });

  it("normalizes model ids", () => {
    expect(normalizeModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(normalizeModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModel("GPT-5.5")).toBe("gpt-5.5");
  });

  it("parses --since", () => {
    const now = Date.UTC(2026, 9, 3);
    expect(parseSince("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseSince("2w", now)).toBe(now - 14 * 86_400_000);
    expect(parseSince("12h", now)).toBe(now - 12 * 3_600_000);
    expect(parseSince("2026-09-01", now)).toBe(Date.UTC(2026, 8, 1));
    expect(parseSince(undefined)).toBeUndefined();
    expect(() => parseSince("last tuesday")).toThrow(/cannot parse/);
  });

  it("scrubs model ids that could identify an account", () => {
    expect(scrubModel("claude-opus-5")).toBe("claude-opus-5");
    expect(scrubModel("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(scrubModel("arn:aws:bedrock:us-east-1:123456789012:inference-profile/x")).toMatch(/^custom-model-[0-9a-f]{8}$/);
    expect(scrubModel("https://proxy.example.com/v1/model")).toMatch(/^custom-model-/);
  });
});
