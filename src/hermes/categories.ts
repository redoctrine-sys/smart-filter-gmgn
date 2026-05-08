import type { FilterRule, RuleEval } from "../filter/types.js";
import type {
  CategoryBreakdown,
  CategoryScore,
  MetricCategory,
  ReviewedCall,
} from "../backtester/types.js";

export const METRIC_CATEGORY_MAP: Record<string, MetricCategory> = {
  // TA
  drop_from_ath_pct: "TA",
  candle_confirm_3_green: "TA",
  near_fib_786: "TA",
  stoch_rsi_k_1m: "TA",
  stoch_rsi_safe_1m: "TA",
  stoch_rsi_signal_1m: "TA",
  stoch_rsi_k_5m: "TA",
  stoch_rsi_safe_5m: "TA",
  stoch_rsi_signal_5m: "TA",
  stoch_rsi_overbought_1m: "TA",
  stoch_rsi_oversold_1m: "TA",
  stoch_rsi_overbought_5m: "TA",
  stoch_rsi_oversold_5m: "TA",
  ath_price_usd: "TA",

  // Volume
  volume_spike_ratio: "Volume",
  volume_5m_usd: "Volume",
  volume_1h_usd: "Volume",
  volume_24h_usd: "Volume",
  market_cap_usd: "Volume",
  global_fee_sol: "Volume",
  global_fee_status: "Volume",
  top10_avg_buy_sol: "Volume",
  top10_avg_sell_sol: "Volume",
  top10_buy_sell_ratio: "Volume",
  top100_avg_buy_sol: "Volume",
  top100_avg_sell_sol: "Volume",
  top100_buy_sell_ratio: "Volume",

  // Age / On-Chain Integrity
  age_hours: "Age",
  age_minutes: "Age",
  migration_status: "Age",
  mint_authority: "Age",
  freeze_authority: "Age",
  honeypot: "Age",
  top_10_holder_pct: "Age",
  top_1_holder_pct: "Age",
  dev_holding_pct: "Age",
  insider_holder_pct: "Age",
  bundler_pct: "Age",
  holder_stacked: "Age",
  smart_money_buys: "Age",
  dex_paid_status: "Age",
  socials_count: "Age",
  top1_holder_balance_sol: "Age",

  // Narrative
  narrative_score: "Narrative",
  is_oldest_in_cluster: "Narrative",
  cluster_size: "Narrative",
  earlier_similar_count: "Narrative",
  is_copycat_of_runner: "Narrative",
  copycat_similarity: "Narrative",
  copycat_runner_symbol: "Narrative",
};

const ALL_CATEGORIES: MetricCategory[] = ["TA", "Volume", "Age", "Narrative"];

function emptyScore(): CategoryScore {
  return { totalPoints: 0, maxPoints: 0, dominanceRatio: 0, topMetrics: [] };
}

/**
 * Categorize scoring metrics from a single FilterDecision evaluation.
 * Requires original rules to determine maxPoints for failing rules.
 */
export function categorizeScoringMetrics(
  evals: RuleEval[],
  rules: FilterRule[],
): CategoryBreakdown {
  const rulePoints = new Map<string, number>(rules.map((r) => [r.metric, r.points ?? 0]));

  type Bucket = { totalPoints: number; maxPoints: number; earned: Array<{ metric: string; pts: number }> };
  const buckets: Record<MetricCategory, Bucket> = {
    TA: { totalPoints: 0, maxPoints: 0, earned: [] },
    Volume: { totalPoints: 0, maxPoints: 0, earned: [] },
    Age: { totalPoints: 0, maxPoints: 0, earned: [] },
    Narrative: { totalPoints: 0, maxPoints: 0, earned: [] },
  };

  for (const ev of evals) {
    const cat = METRIC_CATEGORY_MAP[ev.metric];
    if (!cat) continue;
    const maxPts = rulePoints.get(ev.metric) ?? ev.pointsAwarded;
    buckets[cat].totalPoints += ev.pointsAwarded;
    buckets[cat].maxPoints += maxPts;
    if (ev.pointsAwarded > 0) {
      buckets[cat].earned.push({ metric: ev.metric, pts: ev.pointsAwarded });
    }
  }

  const result: CategoryBreakdown = {
    TA: emptyScore(),
    Volume: emptyScore(),
    Age: emptyScore(),
    Narrative: emptyScore(),
  };
  for (const cat of ALL_CATEGORIES) {
    const b = buckets[cat];
    result[cat] = {
      totalPoints: b.totalPoints,
      maxPoints: b.maxPoints,
      dominanceRatio: b.maxPoints > 0 ? b.totalPoints / b.maxPoints : 0,
      topMetrics: b.earned
        .sort((a, z) => z.pts - a.pts)
        .slice(0, 3)
        .map((e) => e.metric),
    };
  }
  return result;
}

/**
 * Aggregate category breakdown across multiple triggered ReviewedCalls (backtester use).
 */
export function aggregateCategoryBreakdown(
  calls: ReviewedCall[],
  rules: FilterRule[],
): CategoryBreakdown {
  const rulePoints = new Map<string, number>(rules.map((r) => [r.metric, r.points ?? 0]));

  type Bucket = { totalPoints: number; maxPoints: number; metricTotals: Map<string, number> };
  const sums: Record<MetricCategory, Bucket> = {
    TA: { totalPoints: 0, maxPoints: 0, metricTotals: new Map() },
    Volume: { totalPoints: 0, maxPoints: 0, metricTotals: new Map() },
    Age: { totalPoints: 0, maxPoints: 0, metricTotals: new Map() },
    Narrative: { totalPoints: 0, maxPoints: 0, metricTotals: new Map() },
  };

  for (const call of calls) {
    const allEvals = [...call.decision.scoreEvals, ...call.decision.boosterEvals];
    for (const ev of allEvals) {
      const cat = METRIC_CATEGORY_MAP[ev.metric];
      if (!cat) continue;
      const maxPts = rulePoints.get(ev.metric) ?? ev.pointsAwarded;
      sums[cat].totalPoints += ev.pointsAwarded;
      sums[cat].maxPoints += maxPts;
      sums[cat].metricTotals.set(
        ev.metric,
        (sums[cat].metricTotals.get(ev.metric) ?? 0) + ev.pointsAwarded,
      );
    }
  }

  const result: CategoryBreakdown = {
    TA: emptyScore(),
    Volume: emptyScore(),
    Age: emptyScore(),
    Narrative: emptyScore(),
  };
  for (const cat of ALL_CATEGORIES) {
    const s = sums[cat];
    result[cat] = {
      totalPoints: s.totalPoints,
      maxPoints: s.maxPoints,
      dominanceRatio: s.maxPoints > 0 ? s.totalPoints / s.maxPoints : 0,
      topMetrics: [...s.metricTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([m]) => m),
    };
  }
  return result;
}

export function generateCategoryInsight(breakdown: CategoryBreakdown): string {
  const cats = ALL_CATEGORIES.map((cat) => ({ cat, ratio: breakdown[cat].dominanceRatio }))
    .filter((e) => breakdown[e.cat].maxPoints > 0)
    .sort((a, b) => b.ratio - a.ratio);

  if (cats.length === 0) return "Tidak ada data kategori";

  const strong = cats.filter((e) => e.ratio >= 0.6).map((e) => e.cat);
  const weak = cats.filter((e) => e.ratio < 0.3).map((e) => e.cat);

  if (strong.length === 0) {
    const top = cats[0];
    return `Dominan di ${top.cat} (${(top.ratio * 100).toFixed(0)}%)`;
  }

  const parts = [`Kuat di ${strong.join(" dan ")}`];
  if (weak.length > 0) parts.push(`lemah di ${weak.join(" dan ")}`);
  return parts.join(", ");
}
