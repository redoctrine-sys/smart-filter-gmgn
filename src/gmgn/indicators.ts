/**
 * Pure-function technical indicators used by the snapshot mapper.
 *
 * - rsi(closes, period)              standard Wilder RSI
 * - stochRsi(closes, ...params)      Stochastic RSI with %K smoothing and a
 *                                    coarse "signal" classification used by
 *                                    Andri's "RSI atas tunggu turun" rule
 * - detectAth(closes)                ATH within the supplied window plus the
 *                                    current drawdown (negative number when
 *                                    price is below ATH)
 *
 * No external dependencies; all helpers tolerate short input arrays by
 * returning `null` instead of throwing.
 */

export type StochRsiSignal =
  | "overbought"
  | "oversold"
  | "dropping_from_overbought"
  | "rising_from_oversold"
  | "neutral";

export interface StochRsiResult {
  k: number; // 0..100, smoothed
  prevK: number;
  signal: StochRsiSignal;
}

export function rsi(closes: number[], period = 14): number[] {
  if (closes.length <= period) return [];
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const out: number[] = [];
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(rsiValue(avgGain, avgLoss));
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
    out.push(rsiValue(avgGain, avgLoss));
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function stochRsi(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
): StochRsiResult | null {
  if (closes.length < rsiPeriod + stochPeriod + kSmooth) return null;
  const rsiVals = rsi(closes, rsiPeriod);
  if (rsiVals.length < stochPeriod + kSmooth) return null;

  const stochs: number[] = [];
  for (let i = stochPeriod - 1; i < rsiVals.length; i++) {
    const window = rsiVals.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    const denom = max - min;
    stochs.push(denom > 0 ? ((rsiVals[i]! - min) / denom) * 100 : 50);
  }
  if (stochs.length < kSmooth) return null;

  const ks: number[] = [];
  for (let i = kSmooth - 1; i < stochs.length; i++) {
    const window = stochs.slice(i - kSmooth + 1, i + 1);
    ks.push(window.reduce((a, b) => a + b, 0) / window.length);
  }
  const k = ks[ks.length - 1]!;
  const prevK = ks.length > 1 ? ks[ks.length - 2]! : k;

  let signal: StochRsiSignal = "neutral";
  if (prevK > 80 && k <= 80) signal = "dropping_from_overbought";
  else if (prevK < 20 && k >= 20) signal = "rising_from_oversold";
  else if (k > 80) signal = "overbought";
  else if (k < 20) signal = "oversold";

  return { k, prevK, signal };
}

export interface AthResult {
  athPriceUsd: number;
  dropFromAthPct: number; // negative when below ATH (e.g., -0.8 = -80%)
  athIndex: number;
}

export function detectAth(closes: number[]): AthResult | null {
  if (closes.length === 0) return null;
  let ath = -Infinity;
  let athIndex = -1;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]!;
    if (c > ath) {
      ath = c;
      athIndex = i;
    }
  }
  if (!Number.isFinite(ath) || ath <= 0) return null;
  const last = closes[closes.length - 1]!;
  return {
    athPriceUsd: ath,
    dropFromAthPct: (last - ath) / ath,
    athIndex,
  };
}
