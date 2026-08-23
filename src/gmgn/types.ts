/**
 * Normalised shapes used across the pipeline. The actual GMGN responses are
 * mapped into these in src/gmgn/client.ts so the rest of the code is decoupled
 * from the wire format.
 */

export type MigrationStatus = "bonding" | "migrated" | "unknown";

export interface TokenSummary {
  ca: string;
  symbol: string;
  name: string;
  description?: string;
  imageUrl?: string;
  socials: { twitter?: string; telegram?: string; website?: string };
  socialsCount: number;
  launchpad: string;
  migrationStatus: MigrationStatus;
  marketCapUsd: number | null;
  priceUsd: number | null;
  ageHours: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  volume24hUsd: number | null;
}

export interface TokenSecurity {
  mintAuthority: "revoked" | "active" | "unknown";
  freezeAuthority: "revoked" | "active" | "unknown";
  honeypot: boolean;
  lpBurnedPct: number | null;
  topHolderPct: number | null; // top 1
  top10HolderPct: number | null;
  devHoldingPct: number | null;
  insiderHolderPct: number | null;
  bundlerPct: number | null;
  top1HolderBalanceSol: number | null;
  globalFeeSol: number | null;
  globalFeeStatus: "green" | "yellow" | "red" | "unknown";
  dexPaidStatus: "paid" | "unpaid" | "unknown";
}

import type { StochRsiSignal } from "./indicators.js";

export interface StochRsiSnapshot {
  k: number | null;
  signal: StochRsiSignal | null;
  /** k < 80 OR signal === "dropping_from_overbought" — Andri's "RSI atas tunggu turun". */
  safe: boolean;
}

export interface CandleSnapshot {
  last3GreenInARow: boolean;
  lastClose: number | null;
  fib786Level?: number | null;
  nearFib786: boolean;
  athPriceUsd: number | null;
  dropFromAthPct: number | null; // negative when below ATH
  /**
   * Stoch RSI on 1-minute close series. Preferred TF for the New Pair
   * phases (before_migrated + after_migrated) per the user's analysis —
   * Ponyin/Andri scalping mode.
   */
  stochRsi1m: StochRsiSnapshot;
  /**
   * Stoch RSI on 5-minute close series (~8h history). Preferred TF for
   * the sleeper pipeline (slowcook patience play).
   */
  stochRsi5m: StochRsiSnapshot;
}

export interface HolderSnapshot {
  topHolderHoldHours: number | null;
  holderStacked: boolean;
  smartMoneyBuysLastHour: number;
}

/**
 * Per-cohort wallet composition stats (lifetime since the token launched).
 *
 * - avgBuySol  — average SOL spent buying this token across the cohort.
 * - avgSellSol — average SOL received selling this token across the cohort.
 *                avgSell > avgBuy at the cohort level signals distribution.
 * - avgSolBalance — average SOL sitting in each wallet (proxy for wallet
 *                   wealth; tiny avg = bot army, big avg = whale-backed).
 * - maxSolBalance — biggest wallet in the cohort by SOL balance.
 * - n — actual number of holders found in the cohort (may be < cohort size
 *       for very fresh pairs).
 */
export interface CohortStats {
  n: number;
  avgBuySol: number | null;
  avgSellSol: number | null;
  avgSolBalance: number | null;
  maxSolBalance: number | null;
}

export interface WalletComposition {
  top10: CohortStats;
  top100: CohortStats;
}

export interface VolumeSignals {
  volumeSpikeRatio: number | null;
}

export interface RugSignals {
  devSoldPct: number; // % of supply
  bundlerSoldCombinedPct: number;
  lpUnlocked: boolean;
  top10DistributionShiftPct: number;
}

export interface TokenSnapshot {
  summary: TokenSummary;
  security: TokenSecurity;
  candles: CandleSnapshot;
  holders: HolderSnapshot;
  volume: VolumeSignals;
  walletComposition: WalletComposition;
}
