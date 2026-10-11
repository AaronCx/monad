/**
 * Per-sender token bucket for peer messages and spawns (decision record
 * 0012, loop guards). Two sessions that keep answering each other are the
 * failure this bounds: the hop count stops a chain from growing forever, and
 * this stops a short chain from spinning fast. In memory on purpose: a
 * daemon restart refilling every bucket is harmless, and persisting it would
 * be one more table for no safety gain.
 */
export class RateLimiter {
  private readonly perMinute: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(options: { perMinute: number; burst: number; now?: () => number }) {
    this.perMinute = options.perMinute;
    this.burst = Math.max(1, options.burst);
    this.now = options.now ?? Date.now;
  }

  /**
   * Takes one token for `key` and returns true, or returns false (taking
   * nothing) when the bucket is empty.
   */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    const refill = ((now - bucket.at) / 60_000) * this.perMinute;
    bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}
