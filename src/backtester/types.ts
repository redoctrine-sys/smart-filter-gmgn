import type { FilterDecision } from "../filter/types.js";

export type CallStatus = "triggered" | "almost";

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
  pipeline: "new_pair" | "sleeper";
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
}

export interface SimulatedExit {
  outcome: Outcome;
  exitAt: number | null;
  exitPriceUsd: number | null;
  pnlPct: number; // realized return on the position
  maxGainPct: number; // max favourable excursion within window
  maxDrawdownPct: number; // max adverse excursion within window
  timeToOutcomeMin: number | null;
  sizeSol: number;
  realizedSol: number;
}

export interface ReviewedCall extends SimulatedCall {
  exit: SimulatedExit;
}

export interface BacktestSummary {
  windowFrom: number;
  windowTo: number;
  pipeline: "new_pair" | "sleeper";
  templateId: string;
  threshold: number;
  totalCalls: number;
  triggeredCount: number;
  almostCount: number;
  triggered: PipelineStats;
  almost: PipelineStats;
  metricCorrelation: MetricCorrelation[];
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
