import { request } from "undici";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { limiter } from "./rateLimiter.js";
import type {
  CandleSnapshot,
  CohortStats,
  HolderSnapshot,
  RugSignals,
  TokenSecurity,
  TokenSnapshot,
  TokenSummary,
  VolumeSignals,
  WalletComposition,
} from "./types.js";

/**
 * Thin GMGN Agent API wrapper.
 *
 * NOTE: The exact GMGN endpoint paths are documented at
 *   https://docs.gmgn.ai/index/gmgn-agent-api
 * Field shapes change occasionally; the `map*` helpers below normalise into
 * the local TokenSnapshot type so call sites stay stable. If GMGN renames a
 * field, fix it in one place.
 */

interface RawJson {
  [key: string]: unknown;
}

const DEFAULT_HEADERS = {
  "User-Agent": "smart-filter-gmgn/0.1.0",
  Accept: "application/json",
};

async function gmgnGet(path: string, params: Record<string, string | number | undefined> = {}): Promise<RawJson> {
  const url = new URL(path, env.GMGN_BASE_URL.endsWith("/") ? env.GMGN_BASE_URL : env.GMGN_BASE_URL + "/");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return limiter.schedule(async () => {
    const res = await request(url.toString(), {
      method: "GET",
      headers: {
        ...DEFAULT_HEADERS,
        Authorization: `Bearer ${env.GMGN_API_KEY}`,
      },
    });
    if (res.statusCode === 429 || res.statusCode >= 500) {
      const ra = Number(res.headers["retry-after"]);
      limiter.noteHttpError(res.statusCode, Number.isFinite(ra) ? ra : undefined);
      throw new Error(`GMGN ${res.statusCode} on ${path}`);
    }
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new Error(`GMGN ${res.statusCode} on ${path}: ${text.slice(0, 200)}`);
    }
    return (await res.body.json()) as RawJson;
  });
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean => v === true || v === "true" || v === 1;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function pickArray(raw: RawJson): RawJson[] {
  if (Array.isArray(raw)) return raw as RawJson[];
  for (const key of ["data", "tokens", "items", "list", "result"]) {
    const v = (raw as RawJson)[key];
    if (Array.isArray(v)) return v as RawJson[];
    if (v && typeof v === "object") {
      const inner = pickArray(v as RawJson);
      if (inner.length > 0) return inner;
    }
  }
  return [];
}

function mapSummary(raw: RawJson): TokenSummary {
  const ca = str((raw as RawJson)["address"] ?? (raw as RawJson)["ca"] ?? (raw as RawJson)["mint"]);
  const socials = ((raw as RawJson)["socials"] ?? {}) as RawJson;
  const twitter = str((raw as RawJson)["twitter"] ?? socials["twitter"]);
  const telegram = str((raw as RawJson)["telegram"] ?? socials["telegram"]);
  const website = str((raw as RawJson)["website"] ?? socials["website"]);
  const socialsCount = [twitter, telegram, website].filter(Boolean).length;
  const createdAt = num((raw as RawJson)["created_at"] ?? (raw as RawJson)["open_timestamp"]);
  const ageHours = createdAt ? (Date.now() / 1000 - createdAt) / 3600 : null;
  return {
    ca,
    symbol: str((raw as RawJson)["symbol"]),
    name: str((raw as RawJson)["name"]),
    description: str((raw as RawJson)["description"]) || undefined,
    imageUrl: str((raw as RawJson)["logo"] ?? (raw as RawJson)["image"]) || undefined,
    socials: {
      twitter: twitter || undefined,
      telegram: telegram || undefined,
      website: website || undefined,
    },
    socialsCount,
    launchpad: str((raw as RawJson)["launchpad"] ?? (raw as RawJson)["pool_type"] ?? (raw as RawJson)["dex"]).toLowerCase(),
    marketCapUsd: num((raw as RawJson)["market_cap"] ?? (raw as RawJson)["mcap"]),
    priceUsd: num((raw as RawJson)["price"] ?? (raw as RawJson)["price_usd"]),
    ageHours,
    liquidityUsd: num((raw as RawJson)["liquidity"]),
    volume5mUsd: num((raw as RawJson)["volume_5m"]),
    volume1hUsd: num((raw as RawJson)["volume_1h"]),
    volume24hUsd: num((raw as RawJson)["volume_24h"]),
  };
}

function mapSecurity(raw: RawJson): TokenSecurity {
  const sec = ((raw as RawJson)["security"] ?? raw) as RawJson;
  const mintRevoked = bool(sec["mint_revoked"] ?? sec["renounced_mint"]);
  const freezeRevoked = bool(sec["freeze_revoked"] ?? sec["renounced_freeze"]);
  const fee = num((raw as RawJson)["global_fee_sol"] ?? sec["global_fee"]);
  let feeStatus: TokenSecurity["globalFeeStatus"] = "unknown";
  if (fee !== null) feeStatus = fee >= 1 ? "green" : fee >= 0.3 ? "yellow" : "red";
  return {
    mintAuthority: mintRevoked ? "revoked" : sec["mint_revoked"] === false ? "active" : "unknown",
    freezeAuthority: freezeRevoked ? "revoked" : sec["freeze_revoked"] === false ? "active" : "unknown",
    honeypot: bool(sec["honeypot"]),
    lpBurnedPct: num(sec["lp_burned_pct"] ?? sec["burn_ratio"]),
    topHolderPct: num((raw as RawJson)["top_1_holder_pct"] ?? sec["top1_pct"]),
    top10HolderPct: num((raw as RawJson)["top_10_holder_pct"] ?? sec["top10_pct"]),
    devHoldingPct: num((raw as RawJson)["dev_holding_pct"] ?? sec["dev_pct"]),
    insiderHolderPct: num((raw as RawJson)["insider_pct"] ?? sec["insider"]),
    bundlerPct: num((raw as RawJson)["bundler_pct"] ?? sec["bundle_pct"]),
    top1HolderBalanceSol: num((raw as RawJson)["top1_balance_sol"] ?? sec["top1_sol"]),
    globalFeeSol: fee,
    globalFeeStatus: feeStatus,
    dexPaidStatus:
      str((raw as RawJson)["dex_paid"] ?? sec["dex_paid"]).toLowerCase() === "paid"
        ? "paid"
        : str((raw as RawJson)["dex_paid"]) === ""
          ? "unknown"
          : "unpaid",
  };
}

export const gmgnClient = {
  async fetchNewPairs(opts: { limit?: number } = {}): Promise<TokenSnapshot[]> {
    const limit = opts.limit ?? 60;
    try {
      const raw = await gmgnGet("v1/sol/tokens/new_pair", { limit });
      const arr = pickArray(raw);
      return arr.map(toSnapshotShallow).filter((s): s is TokenSnapshot => !!s);
    } catch (err) {
      logger.error({ err: String(err) }, "fetchNewPairs failed");
      return [];
    }
  },

  async fetchSleeperCandidates(opts: {
    minMcUsd: number;
    maxMcUsd: number;
    minAgeHours: number;
    limit?: number;
  }): Promise<TokenSnapshot[]> {
    const limit = opts.limit ?? 60;
    try {
      const raw = await gmgnGet("v1/sol/tokens/scanner", {
        min_market_cap: opts.minMcUsd,
        max_market_cap: opts.maxMcUsd,
        min_age_hours: opts.minAgeHours,
        limit,
      });
      const arr = pickArray(raw);
      return arr.map(toSnapshotShallow).filter((s): s is TokenSnapshot => !!s);
    } catch (err) {
      logger.error({ err: String(err) }, "fetchSleeperCandidates failed");
      return [];
    }
  },

  async enrich(ca: string): Promise<TokenSnapshot | null> {
    try {
      const [info, candles, holders, security] = await Promise.all([
        gmgnGet(`v1/sol/tokens/info`, { address: ca }),
        gmgnGet(`v1/sol/tokens/kline`, { address: ca, interval: "1m", limit: 30 }),
        gmgnGet(`v1/sol/tokens/holders`, { address: ca, limit: 100 }),
        gmgnGet(`v1/sol/tokens/security`, { address: ca }),
      ]);
      return {
        summary: mapSummary({ ...info, ...security }),
        security: mapSecurity({ ...info, ...security }),
        candles: mapCandles(candles),
        holders: mapHolders(holders, info),
        volume: mapVolume(info, candles),
        walletComposition: mapWalletComposition(holders),
      };
    } catch (err) {
      logger.warn({ ca, err: String(err) }, "enrich failed");
      return null;
    }
  },

  async smartMoneyBuysLastHour(ca: string): Promise<number> {
    try {
      const raw = await gmgnGet(`v1/sol/tokens/smart_money_buys`, { address: ca, window: "1h" });
      const n = num((raw as RawJson)["count"] ?? (raw as RawJson)["total"]);
      return n ?? 0;
    } catch {
      return 0;
    }
  },

  async rugSignals(ca: string): Promise<RugSignals> {
    try {
      const raw = await gmgnGet(`v1/sol/tokens/rug_signals`, { address: ca });
      return {
        devSoldPct: num((raw as RawJson)["dev_sold_pct"]) ?? 0,
        bundlerSoldCombinedPct: num((raw as RawJson)["bundler_sold_combined_pct"]) ?? 0,
        lpUnlocked: bool((raw as RawJson)["lp_unlocked"]),
        top10DistributionShiftPct: num((raw as RawJson)["top10_shift_pct"]) ?? 0,
      };
    } catch {
      return {
        devSoldPct: 0,
        bundlerSoldCombinedPct: 0,
        lpUnlocked: false,
        top10DistributionShiftPct: 0,
      };
    }
  },

  async priceUsd(ca: string): Promise<number | null> {
    try {
      const raw = await gmgnGet(`v1/sol/tokens/price`, { address: ca });
      return num((raw as RawJson)["price"] ?? (raw as RawJson)["price_usd"]);
    } catch {
      return null;
    }
  },
};

function mapCandles(raw: RawJson): CandleSnapshot {
  const arr = pickArray(raw);
  if (arr.length === 0) {
    return { last3GreenInARow: false, lastClose: null, fib786Level: null, nearFib786: false };
  }
  const last3 = arr.slice(-3);
  const allGreen = last3.length === 3 && last3.every((c) => num(c["close"])! > num(c["open"])!);
  const closes = arr.map((c) => num(c["close"])).filter((n): n is number => n !== null);
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const fib786 = high - (high - low) * 0.786;
  const lastClose = closes[closes.length - 1] ?? null;
  const nearFib786 = lastClose !== null && Math.abs(lastClose - fib786) / lastClose < 0.05;
  return { last3GreenInARow: allGreen, lastClose, fib786Level: fib786, nearFib786 };
}

function mapHolders(rawHolders: RawJson, rawInfo: RawJson): HolderSnapshot {
  const arr = pickArray(rawHolders);
  const top = arr[0] ?? {};
  const holdSec = num(top["hold_seconds"] ?? top["hold_time"]);
  const holdHours = holdSec === null ? null : holdSec / 3600;
  return {
    topHolderHoldHours: holdHours,
    holderStacked: holdHours !== null && holdHours > 24,
    smartMoneyBuysLastHour: num((rawInfo as RawJson)["smart_money_buys_1h"]) ?? 0,
  };
}

function mapVolume(rawInfo: RawJson, rawCandles: RawJson): VolumeSignals {
  const arr = pickArray(rawCandles);
  if (arr.length < 10) return { volumeSpikeRatio: null };
  const vols = arr.map((c) => num(c["volume"])).filter((n): n is number => n !== null);
  if (vols.length < 10) return { volumeSpikeRatio: null };
  const recent = vols[vols.length - 1] ?? 0;
  const avg =
    vols.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, vols.length - 1);
  return { volumeSpikeRatio: avg > 0 ? recent / avg : null };
}

function toSnapshotShallow(raw: RawJson): TokenSnapshot | null {
  const summary = mapSummary(raw);
  if (!summary.ca) return null;
  return {
    summary,
    security: mapSecurity(raw),
    candles: { last3GreenInARow: false, lastClose: summary.priceUsd, nearFib786: false },
    holders: { topHolderHoldHours: null, holderStacked: false, smartMoneyBuysLastHour: 0 },
    volume: { volumeSpikeRatio: null },
    walletComposition: { top10: emptyCohort(), top100: emptyCohort() },
  };
}

function emptyCohort(): CohortStats {
  return { n: 0, avgBuySol: null, avgSellSol: null, avgSolBalance: null, maxSolBalance: null };
}

/**
 * Compute lifetime cohort stats from the holders payload.
 *
 * Per-holder fields we try (in order, first hit wins):
 *   - SOL spent buying:  bought_sol | buy_sol | bought_amount_sol | buy_volume_sol
 *   - SOL received sell: sold_sol   | sell_sol | sold_amount_sol  | sell_volume_sol
 *   - wallet SOL balance: sol_balance | wallet_balance_sol | native_balance_sol
 *
 * If GMGN renames a field, fix the candidate list once here and the rest of
 * the codebase keeps working.
 */
function mapWalletComposition(rawHolders: RawJson): WalletComposition {
  const arr = pickArray(rawHolders);
  if (arr.length === 0) {
    return { top10: emptyCohort(), top100: emptyCohort() };
  }
  return {
    top10: cohortStats(arr.slice(0, 10)),
    top100: cohortStats(arr.slice(0, 100)),
  };
}

const BUY_FIELDS = ["bought_sol", "buy_sol", "bought_amount_sol", "buy_volume_sol"];
const SELL_FIELDS = ["sold_sol", "sell_sol", "sold_amount_sol", "sell_volume_sol"];
const BALANCE_FIELDS = ["sol_balance", "wallet_balance_sol", "native_balance_sol"];

function pickFirst(holder: RawJson, candidates: string[]): number | null {
  for (const key of candidates) {
    const v = num(holder[key]);
    if (v !== null) return v;
  }
  return null;
}

function cohortStats(holders: RawJson[]): CohortStats {
  if (holders.length === 0) return emptyCohort();
  const buys: number[] = [];
  const sells: number[] = [];
  const balances: number[] = [];
  for (const h of holders) {
    const b = pickFirst(h, BUY_FIELDS);
    const s = pickFirst(h, SELL_FIELDS);
    const bal = pickFirst(h, BALANCE_FIELDS);
    if (b !== null) buys.push(b);
    if (s !== null) sells.push(s);
    if (bal !== null) balances.push(bal);
  }
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const max = (xs: number[]): number | null => (xs.length === 0 ? null : Math.max(...xs));
  return {
    n: holders.length,
    avgBuySol: mean(buys),
    avgSellSol: mean(sells),
    avgSolBalance: mean(balances),
    maxSolBalance: max(balances),
  };
}
