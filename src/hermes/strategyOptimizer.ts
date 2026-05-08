import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { db } from "../db/client.js";
import type { BacktestSummary, MetricCorrelation } from "../backtester/types.js";
import type { FilterRule } from "../filter/types.js";
import type { Pipeline } from "../capture/snapshotter.js";
import { review } from "../backtester/reviewer.js";
import { PerformanceTracker } from "./performanceTracker.js";
import { readTemplateRaw, writeVariant } from "./templateMutator.js";

export type RecommendationAction = "raise" | "lower" | "remove" | "keep";

export interface OptimizationRecommendation {
  metric: string;
  currentPoints: number;
  recommendation: RecommendationAction;
  suggestedPoints?: number;
  reason: string;
}

export interface StrategyReport {
  recommendations: OptimizationRecommendation[];
  summary: string;
  geminiNotes?: string;
  source: "rule_based" | "gemini";
}

export interface VariantResult {
  type: "AGGRESSIVE" | "MODERATE" | "SAFE";
  variantPath: string;
  winRate: number;
  avgPnlPct: number;
  totalRealizedSol: number;
  triggeredCount: number;
  score: number;
}

export interface OptimizationLoopResult {
  declined: boolean;
  declineReason: string;
  variants: VariantResult[];
  bestVariant: VariantResult | null;
  recommendation: string;
  autoApplied: boolean;
}

const LIFT_RAISE_THRESHOLD = 0.15;  // +15pp lift AND low points → raise
const LIFT_LOWER_THRESHOLD = 0.0;   // ≤ 0pp lift → lower/remove

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export class StrategyOptimizer {
  async analyze(summary: BacktestSummary, rules: FilterRule[]): Promise<StrategyReport> {
    const rulePoints = new Map<string, number>(rules.map((r) => [r.metric, r.points ?? 0]));
    const recs = buildRecommendations(summary.metricCorrelation, rulePoints);
    const summaryText = buildSummaryText(recs, summary.triggeredCount);

    if (!genAI) {
      return { recommendations: recs, summary: summaryText, source: "rule_based" };
    }

    try {
      const geminiNotes = await Promise.race([
        geminiAnalyze(summary, rules, recs),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("optimizer timeout")), env.HERMES_MAX_RESEARCH_MS),
        ),
      ]);
      return { recommendations: recs, summary: summaryText, geminiNotes, source: "gemini" };
    } catch (err) {
      logger.warn({ pipeline: summary.pipeline, err: String(err) }, "strategy optimizer gemini failed");
      return { recommendations: recs, summary: summaryText, source: "rule_based" };
    }
  }

  async runOptimizationLoop(
    pipeline: Pipeline,
    fromMs: number,
    toMs: number,
  ): Promise<OptimizationLoopResult> {
    const tracker = new PerformanceTracker();
    const baseSummary = review({ pipeline, fromMs, toMs });

    tracker.record(pipeline, baseSummary);

    const compareResult = tracker.compare(pipeline);
    if (!compareResult.decline) {
      return {
        declined: false,
        declineReason: compareResult.reason,
        variants: [],
        bestVariant: null,
        recommendation: compareResult.reason,
        autoApplied: false,
      };
    }

    logger.info({ pipeline, reason: compareResult.reason }, "decline detected, generating variants");

    const currentYaml = readTemplateRaw(pipeline);
    const rules = [...baseSummary.metricCorrelation];

    let variantYamls: Record<"AGGRESSIVE" | "MODERATE" | "SAFE", string>;
    if (genAI) {
      try {
        variantYamls = await Promise.race([
          generateVariantsViaGemini(pipeline, currentYaml, baseSummary),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("variant generation timeout")), env.HERMES_MAX_RESEARCH_MS * 2),
          ),
        ]);
      } catch (err) {
        logger.warn({ pipeline, err: String(err) }, "gemini variant generation failed, using rule-based");
        variantYamls = generateVariantsRuleBased(currentYaml, rules);
      }
    } else {
      variantYamls = generateVariantsRuleBased(currentYaml, rules);
    }

    const variantResults: VariantResult[] = [];
    for (const [vType, yaml] of Object.entries(variantYamls) as [keyof typeof variantYamls, string][]) {
      try {
        const path = writeVariant(pipeline, vType, yaml);
        const vSummary = review({ pipeline, fromMs, toMs, templatePath: path });
        const maxTriggered = Math.max(baseSummary.triggeredCount, vSummary.triggeredCount, 1);
        const score =
          vSummary.triggered.winRate * 0.5 +
          Math.max(0, vSummary.triggered.avgPnlPct) * 0.3 +
          (vSummary.triggeredCount / maxTriggered) * 0.2;

        const result: VariantResult = {
          type: vType,
          variantPath: path,
          winRate: vSummary.triggered.winRate,
          avgPnlPct: vSummary.triggered.avgPnlPct,
          totalRealizedSol: vSummary.triggered.totalRealizedSol,
          triggeredCount: vSummary.triggeredCount,
          score,
        };
        variantResults.push(result);

        db.prepare(`
          INSERT INTO optimizer_variants
            (pipeline, variant_type, variant_path, win_rate, avg_pnl_pct, triggered_count, score, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(pipeline, vType, path, result.winRate, result.avgPnlPct, result.triggeredCount, result.score, Date.now());
      } catch (err) {
        logger.warn({ pipeline, vType, err: String(err) }, "variant backtest failed");
      }
    }

    variantResults.sort((a, b) => b.score - a.score);
    const best = variantResults[0] ?? null;

    let autoApplied = false;
    if (env.OPTIMIZER_AUTO_APPLY && best) {
      const { applyVariant } = await import("./templateMutator.js");
      applyVariant(pipeline, best.variantPath);
      autoApplied = true;
      logger.info({ pipeline, variant: best.type }, "auto-applied best variant");
    } else if (best) {
      db.prepare(
        `INSERT INTO bot_state(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      ).run(`optimizer_pending_variant_${pipeline}`, best.variantPath, Date.now());
    }

    const recommendation = best
      ? `Variant ${best.type} terbaik: WR=${(best.winRate * 100).toFixed(1)}%, ROI=${(best.avgPnlPct * 100).toFixed(1)}%, n=${best.triggeredCount}. Gunakan /approve ${pipeline} untuk apply.`
      : "Semua variant gagal di-backtest.";

    return {
      declined: true,
      declineReason: compareResult.reason,
      variants: variantResults,
      bestVariant: best,
      recommendation,
      autoApplied,
    };
  }
}

function buildRecommendations(
  metricCorrs: MetricCorrelation[],
  rulePoints: Map<string, number>,
): OptimizationRecommendation[] {
  const recs: OptimizationRecommendation[] = [];

  for (const m of metricCorrs) {
    const currentPoints = rulePoints.get(m.metric) ?? 0;
    if (currentPoints === 0) continue;
    if (m.passingCount === 0 && m.failingCount === 0) continue;

    if (m.lift >= LIFT_RAISE_THRESHOLD && currentPoints <= 10) {
      recs.push({
        metric: m.metric,
        currentPoints,
        recommendation: "raise",
        suggestedPoints: Math.min(currentPoints * 2, 30),
        reason: `lift +${(m.lift * 100).toFixed(0)}pp — prediktif, underweighted (hidden gem)`,
      });
    } else if (m.lift <= LIFT_LOWER_THRESHOLD) {
      if (currentPoints >= 15) {
        recs.push({
          metric: m.metric,
          currentPoints,
          recommendation: "remove",
          reason: `lift ${(m.lift * 100).toFixed(0)}pp — tidak prediktif (dead weight)`,
        });
      } else {
        recs.push({
          metric: m.metric,
          currentPoints,
          recommendation: "lower",
          suggestedPoints: Math.max(0, Math.floor(currentPoints / 2)),
          reason: `lift ${(m.lift * 100).toFixed(0)}pp — kurang prediktif`,
        });
      }
    }
  }

  return recs.slice(0, 5);
}

function buildSummaryText(recs: OptimizationRecommendation[], triggeredCount: number): string {
  if (recs.length === 0) {
    return `Template sudah optimal berdasarkan data backtest (n=${triggeredCount}).`;
  }
  const raises = recs.filter((r) => r.recommendation === "raise").map((r) => r.metric);
  const lowers = recs
    .filter((r) => r.recommendation === "lower" || r.recommendation === "remove")
    .map((r) => r.metric);
  const parts: string[] = [];
  if (raises.length > 0) parts.push(`Naikkan: ${raises.join(", ")}`);
  if (lowers.length > 0) parts.push(`Turunkan/Hapus: ${lowers.join(", ")}`);
  return parts.join(". ") + ` (n=${triggeredCount} calls)`;
}

async function geminiAnalyze(
  summary: BacktestSummary,
  rules: FilterRule[],
  ruleBasedRecs: OptimizationRecommendation[],
): Promise<string> {
  const modelName = env.HERMES_MODEL || env.GEMINI_MODEL;
  const model = genAI!.getGenerativeModel({ model: modelName });
  const prompt = buildOptimizerPrompt(summary, rules, ruleBasedRecs);
  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
  });
  return result.response.text().trim().slice(0, 600);
}

async function generateVariantsViaGemini(
  pipeline: Pipeline,
  currentYaml: string,
  summary: BacktestSummary,
): Promise<Record<"AGGRESSIVE" | "MODERATE" | "SAFE", string>> {
  const modelName = env.HERMES_MODEL || env.GEMINI_MODEL;
  const model = genAI!.getGenerativeModel({ model: modelName });

  const metricLines = summary.metricCorrelation.slice(0, 10).map(
    (m) => `${m.metric}: lift=${(m.lift * 100).toFixed(0)}pp WR=${(m.passingWinRate * 100).toFixed(0)}% n=${m.passingCount}/${m.failingCount}`,
  );

  const prompt = [
    "You are a Solana meme token filter optimizer. Generate 3 YAML template variants.",
    "Output ONLY valid JSON: {\"aggressive\": \"<yaml>\", \"moderate\": \"<yaml>\", \"safe\": \"<yaml>\"}",
    "",
    `Pipeline: ${pipeline} · WinRate: ${(summary.triggered.winRate * 100).toFixed(1)}% · n=${summary.triggeredCount}`,
    `Category: TA=${(summary.categoryBreakdown.TA.dominanceRatio * 100).toFixed(0)}% Vol=${(summary.categoryBreakdown.Volume.dominanceRatio * 100).toFixed(0)}% Age=${(summary.categoryBreakdown.Age.dominanceRatio * 100).toFixed(0)}%`,
    "",
    "[Metric Lifts]",
    ...metricLines,
    "",
    "[Current Template YAML]",
    currentYaml.slice(0, 2000),
    "",
    "Rules:",
    "- AGGRESSIVE: Lower score_threshold by 10%, raise TA/Volume scoring points 20%, keep all metrics",
    "- MODERATE: Apply lift recommendations — raise hidden gems, lower dead weight",
    "- SAFE: Raise score_threshold by 10%, remove metrics with lift<=0, stricter bundler/dev thresholds",
    "Keep all hard_rules unchanged. Only modify score_threshold and scoring/boosters points/values.",
    "Output JSON only.",
  ].join("\n");

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
  });

  const text = result.response.text().trim();
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0) throw new Error("no JSON in variant response");
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, string>;

  return {
    AGGRESSIVE: parsed.aggressive || parsed.AGGRESSIVE || currentYaml,
    MODERATE:   parsed.moderate   || parsed.MODERATE   || currentYaml,
    SAFE:       parsed.safe       || parsed.SAFE        || currentYaml,
  };
}

function generateVariantsRuleBased(
  currentYaml: string,
  correlations: MetricCorrelation[],
): Record<"AGGRESSIVE" | "MODERATE" | "SAFE", string> {
  const gems = correlations.filter((m) => m.lift >= 0.15).map((m) => m.metric);
  const dead = correlations.filter((m) => m.lift <= 0).map((m) => m.metric);

  function mutateYaml(yaml: string, type: "AGGRESSIVE" | "MODERATE" | "SAFE"): string {
    let out = yaml;

    if (type === "AGGRESSIVE") {
      out = out.replace(/score_threshold:\s*(\d+)/, (_, n) => `score_threshold: ${Math.round(Number(n) * 0.9)}`);
      for (const gem of gems.slice(0, 3)) {
        out = out.replace(
          new RegExp(`(metric:\\s*${gem}[^\\n]*\\n[^\\n]*points:\\s*)(\\d+)`, "g"),
          (_, pre, pts) => `${pre}${Math.min(Number(pts) * 2, 30)}`,
        );
      }
    } else if (type === "MODERATE") {
      for (const gem of gems.slice(0, 3)) {
        out = out.replace(
          new RegExp(`(metric:\\s*${gem}[^\\n]*\\n[^\\n]*points:\\s*)(\\d+)`, "g"),
          (_, pre, pts) => `${pre}${Math.min(Math.round(Number(pts) * 1.5), 30)}`,
        );
      }
    } else {
      out = out.replace(/score_threshold:\s*(\d+)/, (_, n) => `score_threshold: ${Math.round(Number(n) * 1.1)}`);
      for (const d of dead.slice(0, 3)) {
        out = out.replace(
          new RegExp(`(metric:\\s*${d}[^\\n]*\\n[^\\n]*points:\\s*)(\\d+)`, "g"),
          (_, pre, pts) => `${pre}${Math.max(0, Math.floor(Number(pts) / 2))}`,
        );
      }
    }

    return out;
  }

  return {
    AGGRESSIVE: mutateYaml(currentYaml, "AGGRESSIVE"),
    MODERATE:   mutateYaml(currentYaml, "MODERATE"),
    SAFE:       mutateYaml(currentYaml, "SAFE"),
  };
}

function buildOptimizerPrompt(
  summary: BacktestSummary,
  rules: FilterRule[],
  ruleBasedRecs: OptimizationRecommendation[],
): string {
  const rulePoints = new Map<string, number>(rules.map((r) => [r.metric, r.points ?? 0]));

  const lines: string[] = [
    "You are a Solana meme token filter strategy analyst.",
    "Analyze this backtest data and give concise strategy recommendations.",
    "Human decides — do NOT suggest auto-applying changes.",
    "",
    `Template: ${summary.templateId} · Pipeline: ${summary.pipeline}`,
    `Threshold: ${summary.threshold} · Triggered: ${summary.triggeredCount} calls · WinRate: ${(summary.triggered.winRate * 100).toFixed(1)}%`,
    "",
    "[Metric Performance]",
  ];

  for (const m of summary.metricCorrelation.slice(0, 10)) {
    const pts = rulePoints.get(m.metric) ?? 0;
    lines.push(
      `${m.metric} (${pts}pts): passWin=${(m.passingWinRate * 100).toFixed(0)}% lift=${(m.lift * 100).toFixed(0)}pp n=${m.passingCount}/${m.failingCount}`,
    );
  }

  lines.push("", "[Category Dominance]");
  for (const cat of ["TA", "Volume", "Age", "Narrative"] as const) {
    const cs = summary.categoryBreakdown[cat];
    if (cs.maxPoints > 0) {
      lines.push(`${cat}: ${(cs.dominanceRatio * 100).toFixed(0)}% (top: ${cs.topMetrics.slice(0, 2).join(", ")})`);
    }
  }

  lines.push("", "[Rule-Based Recs]");
  if (ruleBasedRecs.length === 0) {
    lines.push("(none — template looks balanced)");
  } else {
    for (const r of ruleBasedRecs) {
      lines.push(`${r.recommendation.toUpperCase()} ${r.metric} (${r.currentPoints}pts): ${r.reason}`);
    }
  }

  lines.push(
    "",
    "Berikan 2-4 insight singkat dalam bahasa Indonesia tentang optimasi template ini.",
    "Fokus pada hal yang paling impactful. Langsung dan actionable. Maks 200 kata.",
  );

  return lines.join("\n");
}
