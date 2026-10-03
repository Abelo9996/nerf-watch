import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function tmp(prefix = "nerf-watch-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeLines(file: string, lines: (object | string)[]): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return file;
}
