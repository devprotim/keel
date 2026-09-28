/**
 * A token bucket: `perSecond` tokens refill continuously up to `burst`.
 *
 * Used per socket. A burst allowance matters here because real editing is
 * bursty (an import, a multi-select drag), while a flood is sustained.
 */
export class TokenBucket {
  readonly #perSecond: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #last: number;

  constructor(perSecond: number, burst = perSecond * 2, now: () => number = () => performance.now()) {
    this.#perSecond = perSecond;
    this.#burst = burst;
    this.#now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  /** Spend one token. False means the caller is over budget. */
  take(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#last) / 1000) * this.#perSecond);
    this.#last = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
