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
    isOldestInCluster?: boolean;
    clusterSize?: number;
    earlierSimilarCount?: number;
    isCopycatOfRunner?: boolean;
    copycatSimilarity?: number;
    copycatRunnerSymbol?: string;
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
    age_minutes: snap.summary.ageHours === null ? null : snap.summary.ageHours * 60,
    socials_count: snap.summary.socialsCount,
    migration_status: snap.summary.migrationStatus,

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

    // candles + indicators
    candle_confirm_3_green: snap.candles.last3GreenInARow,
    near_fib_786: snap.candles.nearFib786,
    ath_price_usd: snap.candles.athPriceUsd,
    drop_from_ath_pct: snap.candles.dropFromAthPct,

    // Stoch RSI is exposed on BOTH timeframes. Template picks based on
    // pipeline:
    //   - before_migrated / after_migrated → use _1m suffix (new pair)
    //   - sleeper                          → use _5m suffix (slowcook)
    stoch_rsi_k_1m: snap.candles.stochRsi1m.k,
    stoch_rsi_signal_1m: snap.candles.stochRsi1m.signal,
    stoch_rsi_safe_1m: snap.candles.stochRsi1m.safe,
    stoch_rsi_overbought_1m:
      snap.candles.stochRsi1m.k !== null ? snap.candles.stochRsi1m.k > 80 : null,
    stoch_rsi_oversold_1m:
      snap.candles.stochRsi1m.k !== null ? snap.candles.stochRsi1m.k < 20 : null,

    stoch_rsi_k_5m: snap.candles.stochRsi5m.k,
    stoch_rsi_signal_5m: snap.candles.stochRsi5m.signal,
    stoch_rsi_safe_5m: snap.candles.stochRsi5m.safe,
    stoch_rsi_overbought_5m:
      snap.candles.stochRsi5m.k !== null ? snap.candles.stochRsi5m.k > 80 : null,
    stoch_rsi_oversold_5m:
      snap.candles.stochRsi5m.k !== null ? snap.candles.stochRsi5m.k < 20 : null,

    // holders
    holder_stacked: snap.holders.holderStacked,

    // volume
    volume_spike_ratio: snap.volume.volumeSpikeRatio,
    volume_5m_usd: snap.summary.volume5mUsd,
    volume_1h_usd: snap.summary.volume1hUsd,
    volume_24h_usd: snap.summary.volume24hUsd,

    // wallet composition (lifetime since launch)
    top10_n: snap.walletComposition.top10.n,
    top10_avg_buy_sol: snap.walletComposition.top10.avgBuySol,
    top10_avg_sell_sol: snap.walletComposition.top10.avgSellSol,
    top10_avg_sol_balance: snap.walletComposition.top10.avgSolBalance,
    top10_max_sol_balance: snap.walletComposition.top10.maxSolBalance,
    top10_buy_sell_ratio: ratio(
      snap.walletComposition.top10.avgBuySol,
      snap.walletComposition.top10.avgSellSol,
    ),
    top100_n: snap.walletComposition.top100.n,
    top100_avg_buy_sol: snap.walletComposition.top100.avgBuySol,
    top100_avg_sell_sol: snap.walletComposition.top100.avgSellSol,
    top100_avg_sol_balance: snap.walletComposition.top100.avgSolBalance,
    top100_max_sol_balance: snap.walletComposition.top100.maxSolBalance,
    top100_buy_sell_ratio: ratio(
      snap.walletComposition.top100.avgBuySol,
      snap.walletComposition.top100.avgSellSol,
    ),

    // narrative cluster + copycat (New Pair)
    is_oldest_in_cluster: extras.isOldestInCluster ?? null,
    cluster_size: extras.clusterSize ?? null,
    earlier_similar_count: extras.earlierSimilarCount ?? null,
    is_copycat_of_runner: extras.isCopycatOfRunner ?? null,
    copycat_similarity: extras.copycatSimilarity ?? null,
    copycat_runner_symbol: extras.copycatRunnerSymbol ?? null,

    // extras
    smart_money_buys: extras.smartMoneyBuys ?? snap.holders.smartMoneyBuysLastHour,
    narrative_score: extras.narrativeScore ?? null,
  };
}

function ratio(buy: number | null, sell: number | null): number | null {
  if (buy === null || sell === null) return null;
  if (sell <= 0) return buy > 0 ? Number.POSITIVE_INFINITY : null;
  return buy / sell;
}
