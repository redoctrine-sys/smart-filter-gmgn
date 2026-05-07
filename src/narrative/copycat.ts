import { env } from "../config/env.js";
import { db } from "../db/client.js";
import { recentTokenMetaRepo } from "../db/repos.js";
import { logger } from "../utils/logger.js";
import { similarity, type NamedToken } from "./textSimilarity.js";

/**
 * Two related signals exported for the New Pair pipeline:
 *
 *   1. Cluster — among tokens seen in the last CLUSTER_LOOKBACK_HOURS, find
 *      those whose name/symbol/description resembles the candidate. The
 *      candidate is "OLDEST in cluster" if no earlier token in the cluster
 *      shares its narrative (badidoyo's "TOKEN AGE = OLDEST" rule).
 *
 *   2. Runner — query historical_snapshots over RUNNER_LOOKBACK_HOURS;
 *      a CA whose max(price)/min(price) >= RUNNER_MIN_MULTIPLIER is a
 *      "runner of the day". The candidate is a copycat if its narrative
 *      matches a runner above COPYCAT_SIMILARITY_THRESHOLD.
 *
 * Runner detection is cached for 10 minutes to avoid scanning the whole
 * snapshots table on every New Pair tick.
 */

export interface RunnerInfo {
  ca: string;
  symbol: string;
  name: string;
  description: string | null;
  multiplier: number;
}

export interface ClusterVerdict {
  clusterSize: number; // includes the candidate itself
  earlierSimilarCount: number;
  isOldestInCluster: boolean;
}

export interface CopycatVerdict {
  isCopycatOfRunner: boolean;
  matchedRunner: RunnerInfo | null;
  similarity: number;
}

const RUNNER_CACHE_TTL_MS = 10 * 60 * 1000;
let runnerCache: { computedAt: number; data: RunnerInfo[] } = {
  computedAt: 0,
  data: [],
};

interface RunnerRow {
  ca: string;
  symbol: string | null;
  name: string | null;
  description: string | null;
  min_p: number;
  max_p: number;
}

export function getRunners(): RunnerInfo[] {
  const now = Date.now();
  if (now - runnerCache.computedAt < RUNNER_CACHE_TTL_MS) return runnerCache.data;
  const since = now - env.RUNNER_LOOKBACK_HOURS * 3600 * 1000;
  try {
    const rows = db
      .prepare(
        `SELECT
           rtm.ca         AS ca,
           rtm.symbol     AS symbol,
           rtm.name       AS name,
           rtm.description AS description,
           MIN(hs.price_usd) AS min_p,
           MAX(hs.price_usd) AS max_p
         FROM historical_snapshots hs
         JOIN recent_token_meta rtm ON hs.ca = rtm.ca
         WHERE hs.captured_at > ? AND hs.price_usd IS NOT NULL AND hs.price_usd > 0
         GROUP BY rtm.ca
         HAVING (max_p * 1.0 / NULLIF(min_p, 0)) >= ?
         ORDER BY (max_p * 1.0 / NULLIF(min_p, 0)) DESC
         LIMIT 50`,
      )
      .all(since, env.RUNNER_MIN_MULTIPLIER) as RunnerRow[];

    runnerCache = {
      computedAt: now,
      data: rows.map((r) => ({
        ca: r.ca,
        symbol: r.symbol ?? "",
        name: r.name ?? "",
        description: r.description,
        multiplier: r.min_p > 0 ? r.max_p / r.min_p : 0,
      })),
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "getRunners failed");
    runnerCache = { computedAt: now, data: [] };
  }
  return runnerCache.data;
}

export function detectCluster(args: {
  ca: string;
  candidate: NamedToken;
  firstSeenAt: number;
}): ClusterVerdict {
  const since = args.firstSeenAt - env.CLUSTER_LOOKBACK_HOURS * 3600 * 1000;
  const rows = recentTokenMetaRepo.recent(since, args.ca, 500);
  let similar = 0;
  let earlier = 0;
  const threshold = env.COPYCAT_SIMILARITY_THRESHOLD;
  for (const row of rows) {
    const sim = similarity(args.candidate, {
      name: row.name,
      symbol: row.symbol,
      description: row.description,
    });
    if (sim >= threshold) {
      similar++;
      if (row.first_seen_at < args.firstSeenAt) earlier++;
    }
  }
  return {
    clusterSize: similar + 1,
    earlierSimilarCount: earlier,
    isOldestInCluster: earlier === 0,
  };
}

export function detectCopycat(candidate: NamedToken): CopycatVerdict {
  const runners = getRunners();
  let bestSim = 0;
  let bestRunner: RunnerInfo | null = null;
  for (const r of runners) {
    const sim = similarity(candidate, {
      name: r.name,
      symbol: r.symbol,
      description: r.description,
    });
    if (sim > bestSim) {
      bestSim = sim;
      bestRunner = r;
    }
  }
  const threshold = env.COPYCAT_SIMILARITY_THRESHOLD;
  const isCopycat = bestSim >= threshold && bestRunner !== null;
  return {
    isCopycatOfRunner: isCopycat,
    matchedRunner: isCopycat ? bestRunner : null,
    similarity: bestSim,
  };
}

/** Force-refresh the runner cache; useful for tests or after seed imports. */
export function invalidateRunnerCache(): void {
  runnerCache = { computedAt: 0, data: [] };
}
