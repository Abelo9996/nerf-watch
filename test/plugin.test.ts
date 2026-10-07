import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (rel: string) => JSON.parse(readFileSync(path.join(REPO, rel), "utf8"));

describe("agent plugin files", () => {
  it("the Claude Code plugin manifest matches package.json", () => {
    const manifest = json(".claude-plugin/plugin.json");
    const pkg = json("package.json");
    expect(manifest.name).toBe("nerf-watch");
    expect(manifest.version, "bump the version in .claude-plugin/plugin.json together with package.json").toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
  });

  it("the Codex plugin manifest matches package.json and points at the skill and icon", () => {
    const manifest = json(".codex-plugin/plugin.json");
    expect(manifest.name).toBe("nerf-watch");
    expect(manifest.version, "bump the version in .codex-plugin/plugin.json together with package.json").toBe(json("package.json").version);
    expect(manifest.skills).toBe("./skills/");
    expect(existsSync(path.join(REPO, "skills", "nerf-watch", "SKILL.md"))).toBe(true);
    expect(manifest.interface.shortDescription.length).toBeLessThanOrEqual(30);
    expect(manifest.interface.composerIcon).toBe("./assets/icon.svg");
    const svg = readFileSync(path.join(REPO, "assets", "icon.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(Buffer.byteLength(svg)).toBeLessThan(50_000);
    expect(existsSync(path.join(REPO, manifest.interface.screenshots[0]))).toBe(true);
  });

  it("ships /nerf-watch:check, /nerf-watch:phantom and /nerf-watch:share, which run only when the user asks", () => {
    const files = readdirSync(path.join(REPO, "commands")).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual(["check.md", "phantom.md", "share.md"]);
    for (const f of files) {
      const text = readFileSync(path.join(REPO, "commands", f), "utf8").replace(/\r\n/g, "\n");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(front, f).toMatch(/^description: \S/m);
      expect(front, f).toMatch(/^disable-model-invocation: true$/m);
      expect(front, f).toContain("Bash(npx -y nerf-watch *)");
    }
    // share must never open the browser or submit anything unless the user asks.
    expect(readFileSync(path.join(REPO, "commands", "share.md"), "utf8")).toContain("without `--open`");
  });
});
