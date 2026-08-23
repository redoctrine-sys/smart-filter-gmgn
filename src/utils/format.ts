export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function formatSol(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)} SOL`;
}

export function formatSolPair(
  a: number | null | undefined,
  b: number | null | undefined,
  digits = 2,
): string {
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);
  return `${fmt(a)}/${fmt(b)} SOL`;
}

export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}
