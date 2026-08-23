import type { BacktestSummary, ReviewedCall } from "./types.js";

const HEADER = [
  "ca",
  "symbol",
  "pipeline",
  "template_id",
  "status",
  "score",
  "threshold",
  "entry_at_iso",
  "entry_price_usd",
  "entry_mc_usd",
  "age_min_at_entry",
  "narrative_score",
  "outcome",
  "exit_at_iso",
  "exit_price_usd",
  "pnl_pct",
  "max_gain_pct",
  "max_drawdown_pct",
  "time_to_outcome_min",
  "size_sol",
  "realized_sol",
];

export function callsToCsv(summary: BacktestSummary, calls: ReviewedCall[]): string {
  const lines: string[] = [];
  lines.push(`# pipeline=${summary.pipeline} template=${summary.templateId} threshold=${summary.threshold}`);
  lines.push(
    `# window=${new Date(summary.windowFrom).toISOString()} .. ${new Date(summary.windowTo).toISOString()}`,
  );
  lines.push(HEADER.join(","));
  for (const c of calls) {
    lines.push(
      [
        c.ca,
        csvEscape(c.symbol),
        c.pipeline,
        c.templateId,
        c.status,
        c.score.toString(),
        c.threshold.toString(),
        new Date(c.entryAt).toISOString(),
        formatNum(c.entryPriceUsd, 8),
        formatNum(c.entryMcUsd, 2),
        formatNum(c.ageMinutesAtEntry, 2),
        formatNum(c.narrativeScore, 2),
        c.exit.outcome,
        c.exit.exitAt ? new Date(c.exit.exitAt).toISOString() : "",
        formatNum(c.exit.exitPriceUsd, 8),
        formatNum(c.exit.pnlPct, 4),
        formatNum(c.exit.maxGainPct, 4),
        formatNum(c.exit.maxDrawdownPct, 4),
        formatNum(c.exit.timeToOutcomeMin, 2),
        formatNum(c.exit.sizeSol, 4),
        formatNum(c.exit.realizedSol, 4),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function csvEscape(text: string): string {
  if (text.includes(",") || text.includes('"') || text.includes("\n")) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function formatNum(n: number | null | undefined, digits: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return n.toFixed(digits);
}
