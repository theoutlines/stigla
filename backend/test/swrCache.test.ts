import { describe, expect, it } from "vitest";
import { getWithStaleWhileRevalidate, type WaitUntilCtx } from "../src/lib/swrCache";

function fakeCtx(): WaitUntilCtx & { drain(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p) {
      pending.push(p);
    },
    async drain() {
      await Promise.all(pending);
      pending.length = 0;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("getWithStaleWhileRevalidate", () => {
  it("fetches fresh on a cold key and serves the same value from cache on the next call", async () => {
    const ctx = fakeCtx();
    const key = `https://cache.test/cold-${Math.random()}`;
    let calls = 0;
    const fetchFresh = async () => {
      calls++;
      return { n: calls };
    };

    const first = await getWithStaleWhileRevalidate(key, 30, ctx, fetchFresh);
    expect(first.data).toEqual({ n: 1 });
    expect(first.stale).toBe(false);

    const second = await getWithStaleWhileRevalidate(key, 30, ctx, fetchFresh);
    expect(second.data).toEqual({ n: 1 }); // still cached, no re-fetch
    expect(second.stale).toBe(false);
    expect(calls).toBe(1);
  });

  it("serves stale data immediately and refreshes in the background once past TTL", async () => {
    const ctx = fakeCtx();
    const key = `https://cache.test/stale-${Math.random()}`;
    let calls = 0;
    const fetchFresh = async () => {
      calls++;
      return { n: calls };
    };

    await getWithStaleWhileRevalidate(key, 0.05, ctx, fetchFresh); // ttl ~50ms
    await sleep(100);

    const staleRead = await getWithStaleWhileRevalidate(key, 0.05, ctx, fetchFresh);
    expect(staleRead.stale).toBe(true);
    expect(staleRead.data).toEqual({ n: 1 }); // old value returned immediately

    await ctx.drain(); // let the background refresh finish
    expect(calls).toBe(2);

    const freshRead = await getWithStaleWhileRevalidate(key, 0.05, ctx, fetchFresh);
    expect(freshRead.data).toEqual({ n: 2 });
  });

  it("backs off after a failed refresh instead of retrying every request", async () => {
    const ctx = fakeCtx();
    const key = `https://cache.test/backoff-${Math.random()}`;
    let calls = 0;
    const fetchFresh = async () => {
      calls++;
      if (calls === 1) return { ok: true };
      throw new Error("upstream down");
    };

    await getWithStaleWhileRevalidate(key, 0.05, ctx, fetchFresh);
    await sleep(100);

    // First stale read triggers a refresh attempt, which fails.
    await getWithStaleWhileRevalidate(key, 0.05, ctx, fetchFresh);
    await ctx.drain();
    expect(calls).toBe(2);

    // Immediately stale again, but backoff should suppress another attempt right away.
    const again = await getWithStaleWhileRevalidate(key, 0.05, ctx, fetchFresh);
    await ctx.drain();
    expect(again.data).toEqual({ ok: true }); // still serving last-known-good data
    expect(calls).toBe(2); // no new attempt yet
  });
});
