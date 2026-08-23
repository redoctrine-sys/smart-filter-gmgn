import type { Pipeline } from "../capture/snapshotter.js";
import { loadTemplate } from "../filter/templates.js";
import { env } from "../config/env.js";
import { findSimulatedCalls } from "./engine.js";
import { simulateExit } from "./exitSim.js";
import { aggregateCategoryBreakdown, generateCategoryInsight } from "../hermes/categories.js";
import type {
  BacktestSummary,
  MetricCorrelation,
  Outcome,
  PipelineStats,
  ReviewedCall,
} from "./types.js";

const TEMPLATE_PATH_BY_PIPELINE: Record<Pipeline, () => string> = {
  before_migrated: () => env.TEMPLATE_BEFORE_MIGRATED,
  after_migrated: () => env.TEMPLATE_AFTER_MIGRATED,
  sleeper: () => env.TEMPLATE_SLEEPER,
};

const ALL_OUTCOMES: Outcome[] = [
  "tp_2x",
  "tp_5x",
  "tp_10x",
  "sl_warning",
  "sl_hard",
  "rug_dev_dump",
  "rug_bundler_exit",
  "rug_lp_unlocked",
  "rug_distribution_shift",
  "expired",
];

const ALMOST_BAND_DEFAULT = env.BACKTEST_ALMOST_BAND;

export interface ReviewOptions {
  pipeline: Pipeline;
  fromMs: number;
  toMs: number;
  almostBand?: number;
  templatePath?: string;
}

export function review(opts: ReviewOptions): BacktestSummary {
  const tplPath = opts.templatePath ?? TEMPLATE_PATH_BY_PIPELINE[opts.pipeline]();
  const tpl = loadTemplate(tplPath);
  const almostBand = opts.almostBand ?? ALMOST_BAND_DEFAULT;

  const calls = findSimulatedCalls({
    pipeline: opts.pipeline,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    threshold: tpl.score_threshold,
    almostBand,
  });

  const reviewed: ReviewedCall[] = calls.map((c) => ({ ...c, exit: simulateExit(c) }));
  const triggered = reviewed.filter((c) => c.status === "triggered");
  const almost = reviewed.filter((c) => c.status === "almost");

  const allRules = [...tpl.scoring, ...tpl.boosters];
  const allMetrics = allRules.map((r) => r.metric);
  const metricCorrs = metricCorrelation(triggered, allMetrics);
  const categoryBreakdown = aggregateCategoryBreakdown(triggered, allRules);
  const categoryInsight = generateCategoryInsight(categoryBreakdown);

  return {
    windowFrom: opts.fromMs,
    windowTo: opts.toMs,
    pipeline: opts.pipeline,
    templateId: tpl.id,
    threshold: tpl.score_threshold,
    totalCalls: reviewed.length,
    triggeredCount: triggered.length,
    almostCount: almost.length,
    triggered: aggregate(triggered),
    almost: aggregate(almost),
    metricCorrelation: metricCorrs,
    categoryBreakdown,
    categoryInsight,
    topWinners: pickTop(reviewed, 5, "winners"),
    topLosers: pickTop(reviewed, 5, "losers"),
  };
}

function aggregate(calls: ReviewedCall[]): PipelineStats {
  if (calls.length === 0) {
    return {
      count: 0,
      winRate: 0,
      avgPnlPct: 0,
      weightedAvgPnlPct: 0,
      totalRealizedSol: 0,
      outcomeDistribution: emptyDistribution(),
      avgTimeToTpMin: null,
    };
  }
  const wins = calls.filter((c) => c.exit.realizedSol > 0);
  const totalSize = calls.reduce((a, c) => a + c.exit.sizeSol, 0);
  const totalRealized = calls.reduce((a, c) => a + c.exit.realizedSol, 0);
  const dist = emptyDistribution();
  for (const c of calls) dist[c.exit.outcome]++;
  const tpTimes = calls
    .filter((c) => c.exit.outcome.startsWith("tp_") && c.exit.timeToOutcomeMin !== null)
    .map((c) => c.exit.timeToOutcomeMin as number);
  const avgTpTime =
    tpTimes.length === 0
      ? null
      : tpTimes.reduce((a, b) => a + b, 0) / tpTimes.length;
  return {
    count: calls.length,
    winRate: wins.length / calls.length,
    avgPnlPct: calls.reduce((a, c) => a + c.exit.pnlPct, 0) / calls.length,
    weightedAvgPnlPct: totalSize > 0 ? totalRealized / totalSize : 0,
    totalRealizedSol: totalRealized,
    outcomeDistribution: dist,
    avgTimeToTpMin: avgTpTime,
  };
}

function emptyDistribution(): Record<Outcome, number> {
  return ALL_OUTCOMES.reduce(
    (acc, o) => {
      acc[o] = 0;
      return acc;
    },
    {} as Record<Outcome, number>,
  );
}

/**
 * For each scoring metric, compare the win rate of triggered calls that
 * passed the rule vs those that didn't. Helps answer "which scoring rules
 * actually predict winners?"
 */
function metricCorrelation(triggered: ReviewedCall[], metrics: string[]): MetricCorrelation[] {
  const out: MetricCorrelation[] = [];
  for (const metric of metrics) {
    let pass = 0;
    let passWin = 0;
    let fail = 0;
    let failWin = 0;
    for (const c of triggered) {
      const ev =
        c.decision.scoreEvals.find((e) => e.metric === metric) ??
        c.decision.boosterEvals.find((e) => e.metric === metric);
      if (!ev) continue;
      const isWin = c.exit.realizedSol > 0;
      if (ev.passed) {
        pass++;
        if (isWin) passWin++;
      } else {
        fail++;
        if (isWin) failWin++;
      }
    }
    const passingWinRate = pass > 0 ? passWin / pass : 0;
    const failingWinRate = fail > 0 ? failWin / fail : 0;
    out.push({
      metric,
      passingWinRate,
      failingWinRate,
      lift: passingWinRate - failingWinRate,
      passingCount: pass,
      failingCount: fail,
    });
  }
  return out.sort((a, b) => b.lift - a.lift);
}


function pickTop(calls: ReviewedCall[], n: number, kind: "winners" | "losers"): ReviewedCall[] {
  const sorted = [...calls].sort((a, b) =>
    kind === "winners" ? b.exit.realizedSol - a.exit.realizedSol : a.exit.realizedSol - b.exit.realizedSol,
  );
  return sorted.slice(0, n);
}
