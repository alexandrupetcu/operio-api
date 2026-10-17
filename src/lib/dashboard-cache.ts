import { Redis } from "ioredis";
import { redisConnection } from "../config/redis.js";

/**
 * Cache scurt (45 s) pentru răspunsurile scumpe ale panoului principal
 * (overview + action-feed). Fiecare deschidere a panoului rulează ~15 interogări;
 * cu mai mulți operatori pe aceeași firmă, aceleași rezultate se recalculau de
 * zeci de ori pe minut.
 *
 * Chei: `dash:<tenantId>:v<versiune>:<parte>:<variantă>` — „versiunea" e un
 * contor per firmă (`dash:ver:<tenantId>`) incrementat de
 * `invalidateDashboardCache`, deci invalidarea e O(1) (nu scanăm chei), iar
 * intrările vechi expiră singure prin TTL.
 *
 * Redis căzut sau lent ⇒ se calculează fără cache (fail-open); panoul nu
 * depinde niciodată de Redis ca să răspundă.
 */
export const DASHBOARD_CACHE_TTL_SECONDS = 45;
/** Peste atât nu așteptăm Redis-ul — e mai ieftin să recalculăm. */
const REDIS_OP_TIMEOUT_MS = 250;

let redis: Redis | null = null;
function client(): Redis {
  if (!redis) {
    redis = new Redis({
      ...redisConnection,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
    });
    redis.on("error", () => {
      /* raportat per-operație; fără handler ioredis ar arunca „unhandled error" */
    });
  }
  return redis;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("redis timeout")), REDIS_OP_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const versionKey = (tenantId: string) => `dash:ver:${tenantId}`;

export type DashboardCacheResult<T> = { value: T; hit: boolean };

/**
 * Întoarce valoarea din cache sau o calculează și o pune. `variant` deosebește
 * răspunsurile care diferă de la un utilizator la altul (scopul programărilor,
 * task-urile proprii) — răspunsul trebuie să fie identic cu cel necached.
 */
export async function cachedDashboard<T>(
  tenantId: string,
  part: string,
  variant: string,
  compute: () => Promise<T>,
): Promise<DashboardCacheResult<T>> {
  let key: string | null = null;
  try {
    const ver = (await withTimeout(client().get(versionKey(tenantId)))) ?? "0";
    key = `dash:${tenantId}:v${ver}:${part}:${variant}`;
    const hit = await withTimeout(client().get(key));
    if (hit !== null) return { value: JSON.parse(hit) as T, hit: true };
  } catch (err) {
    console.warn("[dashboard-cache] read skipped:", (err as Error).message);
    key = null;
  }

  const value = await compute();

  if (key) {
    // Fire-and-forget: scrierea nu întârzie răspunsul.
    withTimeout(client().set(key, JSON.stringify(value), "EX", DASHBOARD_CACHE_TTL_SECONDS)).catch((err) =>
      console.warn("[dashboard-cache] write skipped:", (err as Error).message),
    );
  }
  return { value, hit: false };
}

/**
 * De apelat după orice scriere care schimbă panoul (programări, task-uri,
 * snooze/dismiss, înregistrare la OS). Nu aruncă niciodată.
 */
export async function invalidateDashboardCache(tenantId: string): Promise<void> {
  if (!tenantId) return;
  try {
    await withTimeout(client().incr(versionKey(tenantId)));
  } catch (err) {
    // Fără Redis, cache-ul oricum nu servește nimic — intrările expiră în 45 s.
    console.warn("[dashboard-cache] invalidate skipped:", (err as Error).message);
  }
}
