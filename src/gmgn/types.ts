/**
 * Normalised shapes used across the pipeline. The actual GMGN responses are
 * mapped into these in src/gmgn/client.ts so the rest of the code is decoupled
 * from the wire format.
 */

export interface TokenSummary {
  ca: string;
  symbol: string;
  name: string;
  description?: string;
  imageUrl?: string;
  socials: { twitter?: string; telegram?: string; website?: string };
  socialsCount: number;
  launchpad: string;
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

export interface CandleSnapshot {
  last3GreenInARow: boolean;
  lastClose: number | null;
  fib786Level?: number | null;
  nearFib786: boolean;
}

export interface HolderSnapshot {
  topHolderHoldHours: number | null;
  holderStacked: boolean;
  smartMoneyBuysLastHour: number;
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
}
