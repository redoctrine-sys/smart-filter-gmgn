import type { Conviction, HermesAnalysis, StrategyType } from "./agent.js";

function convictionEmoji(c: Conviction): string {
  switch (c) {
    case "LOW":       return "🔴";
    case "MEDIUM":    return "🟡";
    case "HIGH":      return "🟢";
    case "VERY_HIGH": return "🔥";
  }
}

function strategyEmoji(s: StrategyType): string {
  switch (s) {
    case "AGGRESSIVE": return "🔴";
    case "MODERATE":   return "🟡";
    case "SAFE":       return "🟢";
  }
}

function dcaVolTrigger(s: StrategyType): string {
  switch (s) {
    case "AGGRESSIVE": return "vol > $2K/5m";
    case "MODERATE":   return "vol > $5K/5m + TA";
    case "SAFE":       return "vol spike >3x + TA";
  }
}

function fmtPrice(price: number | null): string {
  if (price === null) return "—";
  if (price > 0 && price < 0.00001) return `$${price.toExponential(4)}`;
  return "$" + price.toFixed(10).replace(/\.?0+$/, "");
}

function pctFromBase(price: number | null, base: number | null): string {
  if (price === null || base === null || base === 0) return "";
  const pct = ((price / base - 1) * 100).toFixed(0);
  return pct.startsWith("-") ? ` (${pct}%)` : ` (+${pct}%)`;
}

export function buildEntryRiskCard(analysis: HermesAnalysis): string {
  const { entryPlan: ep, riskPlan: rp, conviction, riskAssessment, strategyType, categoryInsight, researchNotes, source } = analysis;
  const base = ep.zoneLow;
  const dcaTrigger = (ep.dcaTriggerPct * 100).toFixed(0);
  const volTrigger = dcaVolTrigger(strategyType);

  const rows: string[] = [
    "┌─ 📋 HERMES PLAN ──────────────────────────────────────────┐",
    `│ Strategy: ${strategyEmoji(strategyType)} ${strategyType} · Conviction: ${convictionEmoji(conviction)} ${conviction.replace("_", " ")} · Risk: ${riskAssessment}/10${source === "fallback" ? " (fallback)" : ""}`,
    "│",
    "│ 💰 Position Sizing",
    `│ Entry size:  ${ep.entrySizeSol.toFixed(1)} SOL per buy`,
    `│ Max total:   ${rp.maxPositionSol.toFixed(1)} SOL (${ep.maxEntries} entries max)`,
    `│ DCA trigger: ${dcaTrigger}% dari avg entry (${volTrigger})`,
    "│",
    "│ 🎯 Entry Zone",
    `│ Buy:  ${fmtPrice(ep.zoneLow)} − ${fmtPrice(ep.zoneHigh)}`,
  ];

  ep.dcaLevels.forEach((lvl, i) => {
    const pct = pctFromBase(lvl, base);
    const volNote = i === 0 ? `  → ${ep.entrySizeSol.toFixed(1)} SOL` : `  → ${ep.entrySizeSol.toFixed(1)} SOL (${volTrigger})`;
    rows.push(`│ DCA${i + 1}: ${fmtPrice(lvl)}${pct}${volNote}`);
  });

  rows.push("│");
  rows.push("│ 🛡 Risk Plan");
  rows.push(`│ SL:  ${fmtPrice(rp.stopLoss)}${pctFromBase(rp.stopLoss, base)}`);
  rows.push(`│ TP1: ${fmtPrice(rp.tp2x)} (+100%)  sell 30%`);
  rows.push(`│ TP2: ${fmtPrice(rp.tp5x)} (+400%)  sell 30%`);
  rows.push(`│ TP3: ${fmtPrice(rp.tp10x)} (+900%)  sell 20%, rest moonbag`);

  if (categoryInsight) {
    rows.push("│");
    rows.push(`│ 💡 ${categoryInsight}`);
  }
  if (researchNotes) {
    const note = researchNotes.slice(0, 55);
    rows.push(`│ 📝 ${note}`);
  }

  rows.push("└───────────────────────────────────────────────────────────┘");

  return "```\n" + rows.join("\n") + "\n```";
}
