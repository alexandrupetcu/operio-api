import { describe, expect, it } from "vitest";
import { TtlCache } from "./ttl-cache.js";

describe("TtlCache", () => {
  it("servește din memorie până la expirare, apoi reîncarcă", async () => {
    let now = 1_000;
    const cache = new TtlCache<string>(60_000, () => now);
    let loads = 0;
    const load = async () => `v${++loads}`;

    expect(await cache.getOrLoad("t1", load)).toBe("v1");
    expect(await cache.getOrLoad("t1", load)).toBe("v1");
    now += 59_999;
    expect(await cache.getOrLoad("t1", load)).toBe("v1");
    now += 1;
    expect(await cache.getOrLoad("t1", load)).toBe("v2");
    expect(loads).toBe(2);
  });

  it("delete invalidează imediat; cheile sunt independente", async () => {
    const cache = new TtlCache<number>(60_000, () => 0);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });
});
