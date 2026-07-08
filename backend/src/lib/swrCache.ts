// Stale-while-revalidate on top of the Workers Cache API: callers always get
// an immediate response from `caches.default`; a background refresh via
// `ctx.waitUntil()` keeps it from drifting too far behind. Only a genuinely
// cold cache key blocks the caller on a real upstream fetch.
//
// A light backoff rides along in the same cache entry: repeated upstream
// failures push out the next allowed revalidation attempt (capped), so a
// flaky/down source gets polled less often instead of every request.

const MAX_BACKOFF_SECONDS = 600;
const EDGE_CACHE_HEADROOM_SECONDS = 300;

interface CachedPayload<T> {
  data: T;
  updatedAt: string; // last successful fetch, ISO
  nextAttemptAt: string; // don't attempt a refresh before this
  consecutiveFailures: number;
}

export interface SwrResult<T> {
  data: T;
  updatedAt: string;
  stale: boolean;
}

// Duck-typed rather than the full `ExecutionContext` so this works with
// whichever flavor a caller has on hand (raw Workers ctx, Hono's `c.executionCtx`, ...).
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export async function getWithStaleWhileRevalidate<T>(
  cacheKeyUrl: string,
  ttlSeconds: number,
  ctx: WaitUntilCtx,
  fetchFresh: () => Promise<T>,
): Promise<SwrResult<T>> {
  const cache = caches.default;
  const cacheKey = new Request(cacheKeyUrl);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const payload = (await cached.json()) as CachedPayload<T>;
    const now = Date.now();
    const stale = now - Date.parse(payload.updatedAt) >= ttlSeconds * 1000;
    const canAttempt = now >= Date.parse(payload.nextAttemptAt);
    if (stale && canAttempt) {
      ctx.waitUntil(refreshAndStore(cache, cacheKey, ttlSeconds, fetchFresh, payload));
    }
    return { data: payload.data, updatedAt: payload.updatedAt, stale };
  }

  // Cold cache key: the caller has to wait for one real fetch.
  const data = await fetchFresh();
  const updatedAt = new Date().toISOString();
  await storePayload(cache, cacheKey, ttlSeconds, {
    data,
    updatedAt,
    nextAttemptAt: updatedAt,
    consecutiveFailures: 0,
  });
  return { data, updatedAt, stale: false };
}

async function refreshAndStore<T>(
  cache: Cache,
  cacheKey: Request,
  ttlSeconds: number,
  fetchFresh: () => Promise<T>,
  previous: CachedPayload<T>,
): Promise<void> {
  try {
    const data = await fetchFresh();
    const updatedAt = new Date().toISOString();
    await storePayload(cache, cacheKey, ttlSeconds, {
      data,
      updatedAt,
      nextAttemptAt: updatedAt,
      consecutiveFailures: 0,
    });
  } catch {
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const backoffSeconds = Math.min(ttlSeconds * 2 ** consecutiveFailures, MAX_BACKOFF_SECONDS);
    await storePayload(cache, cacheKey, ttlSeconds, {
      ...previous,
      nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      consecutiveFailures,
    });
  }
}

async function storePayload<T>(
  cache: Cache,
  cacheKey: Request,
  ttlSeconds: number,
  payload: CachedPayload<T>,
): Promise<void> {
  const response = new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json",
      // Generous outer bound so the edge doesn't evict before our own
      // staleness/backoff logic (which operates on `updatedAt`) gets a say.
      "cache-control": `max-age=${ttlSeconds + EDGE_CACHE_HEADROOM_SECONDS}`,
    },
  });
  await cache.put(cacheKey, response);
}
