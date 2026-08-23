import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { formatUsd } from "../utils/format.js";
import type { TokenSnapshot } from "../gmgn/types.js";
import type { FilterDecision, FilterRule } from "../filter/types.js";
import type { CategoryBreakdown } from "../backtester/types.js";
import { categorizeScoringMetrics, generateCategoryInsight } from "./categories.js";

export type Conviction = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
export type StrategyType = "AGGRESSIVE" | "MODERATE" | "SAFE";

export interface HermesAnalysis {
  categoryBreakdown: CategoryBreakdown;
  categoryInsight: string;
  riskAssessment: number;
  conviction: Conviction;
  strategyType: StrategyType;
  entryPlan: {
    zoneLow: number | null;
    zoneHigh: number | null;
    dcaLevels: number[];
    maxEntries: number;
    entrySizeSol: number;
    dcaTriggerPct: number;
    reasoning: string;
  };
  riskPlan: {
    stopLoss: number | null;
    tp2x: number | null;
    tp5x: number | null;
    tp10x: number | null;
    maxPositionSol: number;
    reasoning: string;
  };
  researchNotes: string;
  source: "gemini" | "fallback";
}

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export class HermesAgent {
  async analyze(
    snap: TokenSnapshot,
    decision: FilterDecision,
    rules: FilterRule[],
  ): Promise<HermesAnalysis> {
    const allEvals = [...decision.scoreEvals, ...decision.boosterEvals];
    const breakdown = categorizeScoringMetrics(allEvals, rules);
    const insight = generateCategoryInsight(breakdown);

    if (!genAI) {
      return this.fallback(snap, decision, breakdown, insight);
    }

    try {
      return await Promise.race([
        this.geminiAnalyze(snap, decision, breakdown, insight),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("hermes timeout")), env.HERMES_MAX_RESEARCH_MS),
        ),
      ]);
    } catch (err) {
      logger.warn({ ca: snap.summary.ca, err: String(err) }, "hermes gemini failed, using fallback");
      return this.fallback(snap, decision, breakdown, insight);
    }
  }

  private async geminiAnalyze(
    snap: TokenSnapshot,
    decision: FilterDecision,
    breakdown: CategoryBreakdown,
    insight: string,
  ): Promise<HermesAnalysis> {
    const prompt = buildGeminiPrompt(snap, decision, breakdown, insight);
    const modelName = env.HERMES_MODEL || env.GEMINI_MODEL;
    const model = genAI!.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
    });

    const text = result.response.text().trim();
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < 0) throw new Error(`Bad JSON: ${text.slice(0, 80)}`);
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;

    const price = snap.summary.priceUsd;
    const ep = (parsed.entryPlan ?? {}) as Record<string, unknown>;
    const rp = (parsed.riskPlan ?? {}) as Record<string, unknown>;

    const strategyType = toStrategyType(String(parsed.strategyType ?? "MODERATE"));
    const maxEntries = strategyType === "AGGRESSIVE" ? 5 : strategyType === "MODERATE" ? 4 : 2;
    const dcaTriggerPct = strategyType === "AGGRESSIVE" ? -0.10 : strategyType === "MODERATE" ? -0.15 : -0.25;

    return {
      categoryBreakdown: breakdown,
      categoryInsight: insight,
      riskAssessment: Math.max(1, Math.min(10, Number(parsed.riskAssessment ?? 5))),
      conviction: toConviction(String(parsed.conviction ?? "MEDIUM")),
      strategyType,
      entryPlan: {
        zoneLow: ep.zoneLow != null ? Number(ep.zoneLow) : price,
        zoneHigh: ep.zoneHigh != null ? Number(ep.zoneHigh) : price ? price * 1.25 : null,
        dcaLevels: Array.isArray(ep.dcaLevels) ? (ep.dcaLevels as unknown[]).map(Number).slice(0, maxEntries - 1) : [],
        maxEntries: ep.maxEntries != null ? Math.min(5, Number(ep.maxEntries)) : maxEntries,
        entrySizeSol: 0.1,
        dcaTriggerPct: ep.dcaTriggerPct != null ? Number(ep.dcaTriggerPct) : dcaTriggerPct,
        reasoning: String(ep.reasoning ?? "").slice(0, 200),
      },
      riskPlan: {
        stopLoss: rp.stopLoss != null ? Number(rp.stopLoss) : price ? price * 0.7 : null,
        tp2x: rp.tp2x != null ? Number(rp.tp2x) : price ? price * 2 : null,
        tp5x: rp.tp5x != null ? Number(rp.tp5x) : price ? price * 5 : null,
        tp10x: rp.tp10x != null ? Number(rp.tp10x) : price ? price * 10 : null,
        maxPositionSol: 0.5,
        reasoning: String(rp.reasoning ?? "").slice(0, 200),
      },
      researchNotes: String(parsed.researchNotes ?? "").slice(0, 200),
      source: "gemini",
    };
  }

  private fallback(
    snap: TokenSnapshot,
    decision: FilterDecision,
    breakdown: CategoryBreakdown,
    insight: string,
  ): HermesAnalysis {
    const price = snap.summary.priceUsd;
    const pipeline = decision.pipeline;
    const slPct = pipeline === "after_migrated" ? 0.75 : 0.70;
    const riskScore = pipeline === "before_migrated" ? 7 : pipeline === "sleeper" ? 4 : 5;

    const vol5m = snap.summary.volume5mUsd ?? 0;
    const stoch = pipeline === "sleeper" ? snap.candles.stochRsi5m : snap.candles.stochRsi1m;
    const strategyType: StrategyType =
      vol5m > 5000 && stoch.safe ? "MODERATE" : vol5m > 2000 ? "AGGRESSIVE" : "SAFE";
    const maxEntries = strategyType === "AGGRESSIVE" ? 5 : strategyType === "MODERATE" ? 4 : 2;
    const dcaTriggerPct = strategyType === "AGGRESSIVE" ? -0.10 : strategyType === "MODERATE" ? -0.15 : -0.25;
    const dcaLevels = price
      ? Array.from({ length: maxEntries - 1 }, (_, i) => price * (1 + dcaTriggerPct * (i + 1)))
      : [];

    return {
      categoryBreakdown: breakdown,
      categoryInsight: insight,
      riskAssessment: riskScore,
      conviction: "MEDIUM",
      strategyType,
      entryPlan: {
        zoneLow: price ?? null,
        zoneHigh: price ? price * 1.2 : null,
        dcaLevels,
        maxEntries,
        entrySizeSol: 0.1,
        dcaTriggerPct,
        reasoning: "Static fallback — Gemini disabled or unavailable",
      },
      riskPlan: {
        stopLoss: price ? price * slPct : null,
        tp2x: price ? price * 2 : null,
        tp5x: price ? price * 5 : null,
        tp10x: price ? price * 10 : null,
        maxPositionSol: 0.5,
        reasoning: "Static fallback",
      },
      researchNotes: "Hermes fallback — Gemini unavailable.",
      source: "fallback",
    };
  }
}

function buildGeminiPrompt(
  snap: TokenSnapshot,
  decision: FilterDecision,
  breakdown: CategoryBreakdown,
  insight: string,
): string {
  const s = snap.summary;
  const sec = snap.security;
  const c = snap.candles;
  const stoch = decision.pipeline === "sleeper" ? c.stochRsi5m : c.stochRsi1m;
  const stochTf = decision.pipeline === "sleeper" ? "5m" : "1m";

  return [
    "You are a Solana meme coin trading analyst. Analyze this token and provide a structured trading plan.",
    "Output ONLY a compact JSON object — no prose, no markdown.",
    "",
    `TOKEN: ${s.symbol || "?"} (${s.name}) · Pipeline: ${decision.pipeline}`,
    "",
    "[State]",
    `MC: ${formatUsd(s.marketCapUsd)} · Price: $${s.priceUsd?.toFixed(12) ?? "—"}`,
    `Age: ${s.ageHours?.toFixed(1) ?? "—"}h · LP: ${formatUsd(s.liquidityUsd)}`,
    `Vol 5m/1h/24h: ${formatUsd(s.volume5mUsd)} / ${formatUsd(s.volume1hUsd)} / ${formatUsd(s.volume24hUsd)}`,
    "",
    "[TA]",
    `Drop from ATH: ${c.dropFromAthPct !== null ? (c.dropFromAthPct * 100).toFixed(1) + "%" : "—"}`,
    `StochRSI(${stochTf}): k=${stoch.k?.toFixed(0) ?? "—"} signal=${stoch.signal ?? "—"} safe=${stoch.safe}`,
    `3 green candles: ${c.last3GreenInARow} · Near Fib 0.786: ${c.nearFib786}`,
    "",
    "[Security]",
    `Bundler: ${sec.bundlerPct?.toFixed(1) ?? "—"}% · Dev: ${sec.devHoldingPct?.toFixed(1) ?? "—"}%`,
    `Top10: ${sec.top10HolderPct?.toFixed(1) ?? "—"}% · Fee: ${sec.globalFeeSol?.toFixed(2) ?? "—"} SOL (${sec.globalFeeStatus})`,
    `DexPaid: ${sec.dexPaidStatus}`,
    "",
    "[Score]",
    `Score: ${decision.score}/${decision.threshold} · Insight: ${insight}`,
    `TA: ${(breakdown.TA.dominanceRatio * 100).toFixed(0)}% · Volume: ${(breakdown.Volume.dominanceRatio * 100).toFixed(0)}% · Age: ${(breakdown.Age.dominanceRatio * 100).toFixed(0)}% · Narrative: ${(breakdown.Narrative.dominanceRatio * 100).toFixed(0)}%`,
    "",
    "",
    "Sizing rules: entrySizeSol=0.1 SOL per buy, maxPositionSol=0.5 SOL total.",
    "strategyType: AGGRESSIVE (DCA -10%, vol>$2K, max 5 entries) | MODERATE (DCA -15%, vol>$5K+TA, max 4) | SAFE (DCA -25%, vol spike 3x+TA, max 2)",
    "",
    `Required JSON (use current price $${s.priceUsd?.toFixed(12) ?? "0"} as base for all price fields):`,
    `{"riskAssessment":<1-10>,"conviction":"<LOW|MEDIUM|HIGH|VERY_HIGH>","strategyType":"<AGGRESSIVE|MODERATE|SAFE>","entryPlan":{"zoneLow":<price_usd>,"zoneHigh":<price_usd>,"dcaLevels":[<price_usd>,...],"maxEntries":<2-5>,"dcaTriggerPct":<-0.10|-0.15|-0.25>,"reasoning":"<1 sentence>"},"riskPlan":{"stopLoss":<price_usd>,"tp2x":<price_usd>,"tp5x":<price_usd>,"tp10x":<price_usd>,"reasoning":"<1 sentence>"},"researchNotes":"<1-2 sentences>"}`,
  ].join("\n");
}

function toConviction(raw: string): Conviction {
  const upper = raw.toUpperCase().replace(/[\s-]/g, "_");
  if (["LOW", "MEDIUM", "HIGH", "VERY_HIGH"].includes(upper)) return upper as Conviction;
  return "MEDIUM";
}

function toStrategyType(raw: string): StrategyType {
  const upper = raw.toUpperCase();
  if (["AGGRESSIVE", "MODERATE", "SAFE"].includes(upper)) return upper as StrategyType;
  return "MODERATE";
}
