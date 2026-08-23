import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Adaptive token-bucket rate limiter.
 *
 * - Starts at GMGN_INITIAL_RPS.
 * - On HTTP 429 / 5xx, shrinks RPS by GMGN_BACKOFF_FACTOR (down to GMGN_MIN_RPS)
 *   and respects Retry-After when present.
 * - On a sustained streak of successes, grows RPS by GMGN_RECOVER_FACTOR
 *   (up to GMGN_MAX_RPS).
 *
 * Single-process, single-queue: every GMGN call goes through `schedule()`.
 */
export class AdaptiveRateLimiter {
  private rps: number;
  private readonly min: number;
  private readonly max: number;
  private readonly backoff: number;
  private readonly recover: number;

  private tokens: number;
  private lastRefill = Date.now();
  private successStreak = 0;
  private readonly successThresholdToGrow = 25;
  private cooldownUntil = 0;

  private queue: Array<() => void> = [];
  private pumping = false;

  constructor() {
    this.rps = env.GMGN_INITIAL_RPS;
    this.min = env.GMGN_MIN_RPS;
    this.max = env.GMGN_MAX_RPS;
    this.backoff = env.GMGN_BACKOFF_FACTOR;
    this.recover = env.GMGN_RECOVER_FACTOR;
    this.tokens = this.rps;
  }

  currentRps(): number {
    return this.rps;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.rps, this.tokens + elapsed * this.rps);
    this.lastRefill = now;
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onError(err);
      throw err;
    }
  }

  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const tick = () => {
      const now = Date.now();
      if (now < this.cooldownUntil) {
        setTimeout(tick, this.cooldownUntil - now);
        return;
      }
      this.refill();
      while (this.queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        const next = this.queue.shift()!;
        next();
      }
      if (this.queue.length === 0) {
        this.pumping = false;
        return;
      }
      const waitMs = Math.max(20, Math.ceil(1000 / Math.max(this.rps, 0.1)));
      setTimeout(tick, waitMs);
    };
    tick();
  }

  private onSuccess(): void {
    this.successStreak += 1;
    if (this.successStreak >= this.successThresholdToGrow) {
      const next = Math.min(this.max, this.rps * this.recover);
      if (next > this.rps + 0.05) {
        logger.debug({ from: this.rps, to: next }, "rate-limiter: grow");
        this.rps = next;
      }
      this.successStreak = 0;
    }
  }

  /** Call from the GMGN client when an HTTP error is returned. */
  noteHttpError(status: number, retryAfterSec?: number): void {
    if (status === 429 || status >= 500) {
      const next = Math.max(this.min, this.rps * this.backoff);
      logger.warn({ status, from: this.rps, to: next, retryAfterSec }, "rate-limiter: backoff");
      this.rps = next;
      this.successStreak = 0;
      const cooldownMs = retryAfterSec
        ? Math.max(retryAfterSec * 1000, 1000)
        : Math.ceil(1500 + Math.random() * 1500);
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
    }
  }

  private onError(err: unknown): void {
    // Network errors also trigger mild backoff, but never below floor.
    if (err && typeof err === "object" && "name" in err) {
      const name = (err as { name?: string }).name;
      if (name === "TypeError" || name === "AbortError" || name === "FetchError") {
        const next = Math.max(this.min, this.rps * this.backoff);
        if (next < this.rps) {
          logger.warn({ name, from: this.rps, to: next }, "rate-limiter: network backoff");
          this.rps = next;
        }
        this.successStreak = 0;
      }
    }
  }
}

export const limiter = new AdaptiveRateLimiter();
