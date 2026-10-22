/**
 * Render an SVG card to PNG in-process with a bundled WASM rasterizer, so
 * `nerf-watch card --out card.png` works with no system tools (no librsvg, no
 * headless browser). The WASM module is loaded lazily the first time a PNG is
 * rendered, so commands that never make a PNG do not pay for it.
 *
 * The rasterizer has no fonts of its own, and WASM cannot read the OS font
 * directories. So nerf-watch reads a few font files already on the machine and
 * passes them to the rasterizer as buffers. Nothing is downloaded or bundled;
 * reading a font file is not a "system tool". If no usable font is found the
 * PNG still renders, just without text, and the SVG (with live fonts) is always
 * available as a fallback.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

let ready: Promise<void> | null = null;

/** Font role -> candidate files per platform, with the family name inside each file. */
interface FontPick {
  file: string;
  family: string;
}

const SANS: FontPick[] = [
  { file: "/System/Library/Fonts/Supplemental/Arial.ttf", family: "Arial" },
  { file: "/Library/Fonts/Arial.ttf", family: "Arial" },
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", family: "DejaVu Sans" },
  { file: "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", family: "Liberation Sans" },
  { file: "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf", family: "Noto Sans" },
  { file: "C:\\Windows\\Fonts\\arial.ttf", family: "Arial" },
  { file: "C:\\Windows\\Fonts\\segoeui.ttf", family: "Segoe UI" },
];
const SANS_BOLD: FontPick[] = [
  { file: "/System/Library/Fonts/Supplemental/Arial Bold.ttf", family: "Arial" },
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", family: "DejaVu Sans" },
  { file: "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", family: "Liberation Sans" },
  { file: "C:\\Windows\\Fonts\\arialbd.ttf", family: "Arial" },
];
const MONO: FontPick[] = [
  { file: "/System/Library/Fonts/Menlo.ttc", family: "Menlo" },
  { file: "/System/Library/Fonts/Supplemental/Courier New.ttf", family: "Courier New" },
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", family: "DejaVu Sans Mono" },
  { file: "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", family: "Liberation Mono" },
  { file: "C:\\Windows\\Fonts\\consola.ttf", family: "Consolas" },
  { file: "C:\\Windows\\Fonts\\cour.ttf", family: "Courier New" },
];
// Broad-coverage fallback for symbols such as the arrow and middot.
const UNICODE: FontPick[] = [
  { file: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", family: "Arial Unicode MS" },
  { file: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", family: "DejaVu Sans" },
];

function firstExisting(picks: FontPick[]): FontPick | null {
  for (const p of picks) if (existsSync(p.file)) return p;
  return null;
}

interface Fonts {
  buffers: Uint8Array[];
  sansFamily: string;
  monoFamily: string;
}

let cachedFonts: Fonts | null | undefined;

/** Discover and read the font buffers once. */
function discoverFonts(): Fonts | null {
  if (cachedFonts !== undefined) return cachedFonts;
  const chosen: FontPick[] = [];
  const sans = firstExisting(SANS);
  const bold = firstExisting(SANS_BOLD);
  const mono = firstExisting(MONO);
  const uni = firstExisting(UNICODE);
  for (const p of [sans, bold, mono, uni]) if (p) chosen.push(p);
  const seen = new Set<string>();
  const buffers: Uint8Array[] = [];
  for (const p of chosen) {
    if (seen.has(p.file)) continue;
    seen.add(p.file);
    try {
      buffers.push(new Uint8Array(readFileSync(p.file)));
    } catch {
      // skip unreadable
    }
  }
  cachedFonts = buffers.length ? { buffers, sansFamily: sans?.family ?? "Arial", monoFamily: mono?.family ?? sans?.family ?? "Arial" } : null;
  return cachedFonts;
}

async function ensureWasm(): Promise<typeof import("@resvg/resvg-wasm")> {
  const mod = await import("@resvg/resvg-wasm");
  if (!ready) {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
    ready = mod.initWasm(readFileSync(wasmPath));
  }
  await ready;
  return mod;
}

/** Rasterize an SVG string to PNG bytes at the given pixel width. */
export async function svgToPng(svg: string, width: number): Promise<Buffer> {
  const mod = await ensureWasm();
  const fonts = discoverFonts();
  const font = fonts
    ? { fontBuffers: fonts.buffers, loadSystemFonts: false, defaultFontFamily: fonts.sansFamily, sansSerifFamily: fonts.sansFamily, monospaceFamily: fonts.monoFamily }
    : { loadSystemFonts: true };
  const resvg = new mod.Resvg(svg, { fitTo: { mode: "width", value: width }, font });
  return Buffer.from(resvg.render().asPng());
}
