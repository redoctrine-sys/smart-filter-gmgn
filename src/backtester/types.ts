import type { Pipeline } from "../capture/snapshotter.js";
import type { FilterDecision } from "../filter/types.js";

export interface IntegritySnapshot {
  timestamp: number;
  marketCapUsd: number | null;
  top10HoldersPct: number | null;
  bundlerPct: number | null;
  devHoldingPct: number | null;
  insiderHolderPct: number | null;
}

export type MetricCategory = "TA" | "Volume" | "Age" | "Narrative";

export interface CategoryScore {
  totalPoints: number;
  maxPoints: number;
  dominanceRatio: number;
  topMetrics: string[];
}

export type CategoryBreakdown = Record<MetricCategory, CategoryScore>;

export type CallStatus = "triggered" | "almost";

export type { Pipeline };

export type Outcome =
  | "tp_2x"
  | "tp_5x"
  | "tp_10x"
  | "sl_warning"
  | "sl_hard"
  | "rug_dev_dump"
  | "rug_bundler_exit"
  | "rug_lp_unlocked"
  | "rug_distribution_shift"
  | "expired";

export interface SimulatedCall {
  ca: string;
  symbol: string;
  pipeline: Pipeline;
  templateId: string;
  status: CallStatus;
  score: number;
  threshold: number;
  decision: FilterDecision;
  entryAt: number;
  entryPriceUsd: number | null;
  entryMcUsd: number | null;
  ageMinutesAtEntry: number;
  narrativeScore: number | null;
  entrySnapshot?: IntegritySnapshot;
}

export interface SimulatedExit {
  outcome: Outcome;
  exitAt: number | null;
  exitPriceUsd: number | null;
  pnlPct: number;
  maxGainPct: number;
  maxDrawdownPct: number;
  timeToOutcomeMin: number | null;
  sizeSol: number;
  realizedSol: number;
  exitSnapshot?: IntegritySnapshot;
}

export interface ReviewedCall extends SimulatedCall {
  exit: SimulatedExit;
}

export interface BacktestSummary {
  windowFrom: number;
  windowTo: number;
  pipeline: Pipeline;
  templateId: string;
  threshold: number;
  totalCalls: number;
  triggeredCount: number;
  almostCount: number;
  triggered: PipelineStats;
  almost: PipelineStats;
  metricCorrelation: MetricCorrelation[];
  categoryBreakdown: CategoryBreakdown;
  categoryInsight: string;
  topWinners: ReviewedCall[];
  topLosers: ReviewedCall[];
}

export interface PipelineStats {
  count: number;
  winRate: number; // % of calls with realizedSol > 0
  avgPnlPct: number; // simple mean of pnlPct
  weightedAvgPnlPct: number; // sum(realizedSol)/sum(sizeSol)
  totalRealizedSol: number;
  outcomeDistribution: Record<Outcome, number>;
  avgTimeToTpMin: number | null;
}

export interface MetricCorrelation {
  metric: string;
  passingWinRate: number;
  failingWinRate: number;
  lift: number; // passingWinRate - failingWinRate
  passingCount: number;
  failingCount: number;
}
