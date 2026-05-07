/**
 * Lightweight text similarity for narrative cluster + copycat detection.
 *
 * Strategy:
 *   1. Lowercase and strip non-alphanumerics from name + symbol + description.
 *   2. Tokenise on whitespace; drop stopwords + obvious meme suffixes that
 *      otherwise inflate similarity (every meme is "the X coin").
 *   3. Jaccard index on the resulting token sets.
 *   4. Bonus if symbols match exactly — symbols are short and intentionally
 *      chosen, so equality is a strong copycat signal even when the name
 *      tokens differ.
 *
 * No external dependencies, no LLM. Stable and fast enough to run inside
 * the New Pair tick (3-5s polling).
 */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "is",
  "for",
  "on",
  "in",
  "by",
  "with",
  "this",
  "that",
  "token",
  "coin",
  "memecoin",
  "official",
  "real",
  "new",
  "sol",
  "solana",
  "spl",
  "pump",
  "fun",
]);

export function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return new Set(cleaned);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface NamedToken {
  name: string | null;
  symbol: string | null;
  description?: string | null;
}

export function similarity(a: NamedToken, b: NamedToken): number {
  const aText = [a.name ?? "", a.symbol ?? "", a.description ?? ""].join(" ");
  const bText = [b.name ?? "", b.symbol ?? "", b.description ?? ""].join(" ");
  const aTok = tokenize(aText);
  const bTok = tokenize(bText);
  let score = jaccard(aTok, bTok);
  const sa = (a.symbol ?? "").trim().toLowerCase();
  const sb = (b.symbol ?? "").trim().toLowerCase();
  if (sa && sa === sb) score = Math.min(1, score + 0.3);
  return score;
}
