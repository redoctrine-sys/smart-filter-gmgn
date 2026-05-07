import type { TokenSnapshot } from "../gmgn/types.js";

/**
 * Flatten a TokenSnapshot (+ extras) into the metric map the filter engine
 * compares against. Keep the keys in sync with template YAML.
 */
export function buildMetrics(
  snap: TokenSnapshot,
  extras: {
    smartMoneyBuys?: number;
    narrativeScore?: number;
  } = {},
): Record<string, unknown> {
  return {
    // identity
    ca: snap.summary.ca,
    symbol: snap.summary.symbol,
    name: snap.summary.name,
    launchpad: snap.summary.launchpad,

    // summary metrics
    market_cap_usd: snap.summary.marketCapUsd,
    price_usd: snap.summary.priceUsd,
    age_hours: snap.summary.ageHours,
    socials_count: snap.summary.socialsCount,

    // security
    mint_authority: snap.security.mintAuthority,
    freeze_authority: snap.security.freezeAuthority,
    honeypot: snap.security.honeypot,
    top_10_holder_pct: snap.security.top10HolderPct,
    top_1_holder_pct: snap.security.topHolderPct,
    dev_holding_pct: snap.security.devHoldingPct,
    insider_holder_pct: snap.security.insiderHolderPct,
    bundler_pct: snap.security.bundlerPct,
    top1_holder_balance_sol: snap.security.top1HolderBalanceSol,
    global_fee_sol: snap.security.globalFeeSol,
    global_fee_status: snap.security.globalFeeStatus,
    dex_paid_status: snap.security.dexPaidStatus,

    // candles
    candle_confirm_3_green: snap.candles.last3GreenInARow,
    near_fib_786: snap.candles.nearFib786,

    // holders
    holder_stacked: snap.holders.holderStacked,

    // volume
    volume_spike_ratio: snap.volume.volumeSpikeRatio,

    // extras
    smart_money_buys: extras.smartMoneyBuys ?? snap.holders.smartMoneyBuysLastHour,
    narrative_score: extras.narrativeScore ?? null,
  };
}
