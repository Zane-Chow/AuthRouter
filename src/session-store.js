export class MemorySessionStore {
  #sessions = new Map();
  #timer;

  constructor({ cleanupIntervalMs = 5 * 60 * 1000, now = Date.now } = {}) {
    this.now = now;
    this.#timer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.#timer.unref?.();
  }

  get(key) {
    const entry = this.#sessions.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#sessions.delete(key);
      return undefined;
    }
    return structuredClone(entry.value);
  }

  set(key, value, maxAge) {
    const ttl = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 10 * 60 * 1000;
    this.#sessions.set(key, {
      value: structuredClone(value),
      expiresAt: this.now() + ttl,
    });
  }

  destroy(key) {
    this.#sessions.delete(key);
  }

  cleanup() {
    const current = this.now();
    for (const [key, entry] of this.#sessions) {
      if (entry.expiresAt <= current) this.#sessions.delete(key);
    }
  }

  close() {
    clearInterval(this.#timer);
    this.#sessions.clear();
  }
}
