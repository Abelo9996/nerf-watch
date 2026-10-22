/**
 * Local, offline token estimate. nerf-watch never calls a tokenizer service
 * and never uploads text, so config-source sizes (CLAUDE.md, AGENTS.md, skills)
 * are estimated here from the text itself. These are estimates: the measured
 * attribution in `overhead --measure` is the authoritative number.
 *
 * The estimate blends a character count (about four characters per token for
 * prose) with a word-and-symbol count (BPE rarely puts more than one short word
 * in a token, and splits most punctuation out). Taking the larger of the two
 * keeps code and symbol-heavy text from being undercounted.
 */

/** Rough token count for a string. Offline estimate, not exact. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  // Word-ish pieces: runs of letters/digits, or single non-space symbols.
  const pieces = text.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g);
  const byPieces = pieces ? pieces.reduce((n, p) => n + Math.max(1, Math.ceil(p.length / 5)), 0) : 0;
  return Math.max(Math.round(chars / 4), byPieces);
}

/** "1.2k tokens", "340 tokens". For display only. */
export function fmtTokensApprox(n: number): string {
  const v = n >= 10000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString("en-US");
  return `${v} tokens`;
}
