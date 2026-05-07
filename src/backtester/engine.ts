import { snapshotsRepo, type HistoricalSnapshotRow } from "../db/repos.js";
import type { FilterDecision } from "../filter/types.js";
import type { CallStatus, SimulatedCall } from "./types.js";

/**
 * Identify simulated calls within the window for a single pipeline.
 *
 * Iterates snapshots chronologically and picks the FIRST snapshot per token
 * that either:
 *   - was triggered (decision.passed === true), or
 *   - was "almost" — hard rules passed but score is in
 *     [threshold - almostBand, threshold - 1].
 *
 * Once a token has produced an entry, subsequent snapshots are ignored
 * (they belong to the exit simulator, not to call generation).
 */
export function findSimulatedCalls(args: {
  pipeline: "new_pair" | "sleeper";
  fromMs: number;
  toMs: number;
  threshold: number;
  almostBand: number;
}): SimulatedCall[] {
  const rows = snapshotsRepo.inWindow(args.pipeline, args.fromMs, args.toMs);
  const seen = new Set<string>();
  const calls: SimulatedCall[] = [];

  for (const row of rows) {
    if (seen.has(row.ca)) continue;
    const status = classify(row, args.threshold, args.almostBand);
    if (!status) continue;
    seen.add(row.ca);
    const decision = JSON.parse(row.decision_json) as FilterDecision;
    const snapshot = JSON.parse(row.snapshot_json) as { summary: { symbol: string } };
    calls.push({
      ca: row.ca,
      symbol: snapshot.summary?.symbol ?? "?",
      pipeline: args.pipeline,
      templateId: row.template_id,
      status,
      score: row.score,
      threshold: args.threshold,
      decision,
      entryAt: row.captured_at,
      entryPriceUsd: row.price_usd,
      entryMcUsd: row.market_cap_usd,
      ageMinutesAtEntry: row.age_minutes_since_first_sight,
      narrativeScore: row.narrative_score,
    });
  }
  return calls;
}

function classify(
  row: HistoricalSnapshotRow,
  threshold: number,
  almostBand: number,
): CallStatus | null {
  if (row.triggered === 1) return "triggered";
  if (row.hard_pass === 1 && row.score >= threshold - almostBand && row.score < threshold) {
    return "almost";
  }
  return null;
}
