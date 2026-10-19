import { describe, expect, it } from "vitest";
import { SafeFetchError, assertSafeUrl, isBlockedHostname, isPrivateAddress, truncateForLog } from "./safe-fetch.js";

/**
 * Doar predicatele pure + ramura de validare a URL-ului care NU are nevoie de
 * DNS (schemă, credențiale, denylist de nume, IP literal). `safeFetch` în sine
 * și ramura cu `dns.lookup` nu se testează aici: ar cere rețea reală (sau un
 * mock de `node:dns`, care ar testa mock-ul, nu codul) — vezi raportul.
 */

describe("isPrivateAddress — IPv4", () => {
  const privateIps = [
    "127.0.0.1", // loopback
    "127.255.255.254",
    "0.0.0.0", // „this network"
    "0.1.2.3",
    "10.0.0.1", // RFC1918 10/8
    "10.255.255.255",
    "172.16.0.1", // RFC1918 172.16/12
    "172.31.255.255",
    "192.168.0.1", // RFC1918 192.168/16
    "192.168.255.255",
    "169.254.169.254", // link-local / metadata cloud
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "224.0.0.1", // multicast
    "255.255.255.255", // broadcast
  ];
  for (const ip of privateIps) {
    it(`respinge ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  }

  const publicIps = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "192.167.255.255", "100.63.255.255", "11.0.0.1"];
  for (const ip of publicIps) {
    it(`acceptă ${ip}`, () => expect(isPrivateAddress(ip)).toBe(false));
  }
});

describe("isPrivateAddress — IPv6", () => {
  const privateIps = [
    "::1", // loopback
    "::", // unspecified
    "fc00::1", // ULA fc00::/7
    "fd12:3456:789a::1",
    "fe80::1", // link-local
    "feb0::1",
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "::ffff:7f00:1", // forma hex a IPv4-mapped loopback
    "fe80::1%eth0", // cu zone id
    "[::1]", // în paranteze (din URL)
  ];
  for (const ip of privateIps) {
    it(`respinge ${ip}`, () => expect(isPrivateAddress(ip)).toBe(true));
  }

  it("acceptă un IPv6 public", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("::ffff:<ip public> e acceptat", () => {
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("isPrivateAddress — intrări care nu sunt IP", () => {
  for (const v of ["", "localhost", "nu-e-ip", "999.999.999.999", "10.0.0", "1.2.3.4.5", "10.0.0.1/8"]) {
    it(`tratează „${v}" ca nesigur`, () => expect(isPrivateAddress(v)).toBe(true));
  }
});

describe("isBlockedHostname", () => {
  const blocked = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "localhost.localdomain",
    "api", // numele serviciilor din Docker Compose (/deploy)
    "postgres",
    "redis",
    "caddy",
    "workers",
    "internal",
    "local",
    "foo.internal", // sufixe
    "metadata.internal",
    "printer.local",
    "x.localhost",
    "", // nume gol
  ];
  for (const h of blocked) {
    it(`respinge „${h}"`, () => expect(isBlockedHostname(h)).toBe(true));
  }

  const allowed = ["operio.ro", "api.operio.ro", "example.com", "internal.example.com", "my-api.net", "localhostx.com"];
  for (const h of allowed) {
    it(`acceptă „${h}"`, () => expect(isBlockedHostname(h)).toBe(false));
  }

  it("normalizează punctul final și parantezele IPv6", () => {
    expect(isBlockedHostname("API")).toBe(true);
    expect(isBlockedHostname("redis.")).toBe(true);
    expect(isBlockedHostname("[::1]")).toBe(false); // nu e un nume blocat — îl prinde verificarea de adresă
  });
});

describe("assertSafeUrl — validări fără DNS", () => {
  const rejects = async (url: string, fragment: RegExp) => {
    await expect(assertSafeUrl(url)).rejects.toThrow(SafeFetchError);
    await expect(assertSafeUrl(url)).rejects.toThrow(fragment);
  };

  it("respinge schemele în afara http/https", async () => {
    await rejects("file:///etc/passwd", /Unsupported URL scheme/);
    await rejects("ftp://example.com/x", /Unsupported URL scheme/);
    await rejects("gopher://example.com", /Unsupported URL scheme/);
    await rejects("data:text/plain,hi", /Unsupported URL scheme/);
  });

  it("respinge credențialele în URL", async () => {
    await rejects("http://user:pass@8.8.8.8/", /Credentials in URL/);
    await rejects("https://user@8.8.8.8/", /Credentials in URL/);
  });

  it("respinge un URL invalid", async () => {
    await rejects("nu-e-un-url", /Invalid URL/);
    await rejects("http://", /Invalid URL/);
  });

  it("respinge numele din denylist, fără să ajungă la DNS", async () => {
    await rejects("http://localhost:3000/x", /Host not allowed/);
    await rejects("http://redis:6379/", /Host not allowed/);
    await rejects("http://postgres/", /Host not allowed/);
    await rejects("http://api/api/health", /Host not allowed/);
    await rejects("http://metadata.internal/latest", /Host not allowed/);
  });

  it("respinge IP-urile private scrise literal (fără DNS)", async () => {
    await rejects("http://127.0.0.1:3000/", /private address/);
    await rejects("http://169.254.169.254/latest/meta-data/", /private address/);
    await rejects("http://10.0.0.5/", /private address/);
    await rejects("http://172.16.0.1/", /private address/);
    await rejects("http://192.168.1.1/", /private address/);
    await rejects("http://[::1]:8080/", /private address/);
    await rejects("http://[fc00::1]/", /private address/);
    await rejects("http://0.0.0.0/", /private address/);
  });

  it("acceptă un IP public literal (fără DNS) și întoarce URL-ul", async () => {
    const url = await assertSafeUrl("https://8.8.8.8/health?x=1");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("8.8.8.8");
    expect(url.search).toBe("?x=1");
    await expect(assertSafeUrl("http://[2606:4700:4700::1111]/")).resolves.toBeInstanceOf(URL);
  });

  it("acceptă și un obiect URL deja construit", async () => {
    await expect(assertSafeUrl(new URL("https://1.1.1.1/"))).resolves.toBeInstanceOf(URL);
  });

  it("SafeFetchError are numele propriu (pentru log/handler)", async () => {
    const err = await assertSafeUrl("file:///x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as Error).name).toBe("SafeFetchError");
  });
});

describe("truncateForLog", () => {
  it("null / undefined → null", () => {
    expect(truncateForLog(null)).toBeNull();
    expect(truncateForLog(undefined)).toBeNull();
  });

  it("textul scurt rămâne întreg", () => {
    expect(truncateForLog("ok")).toBe("ok");
  });

  it("obiectele se serializează JSON", () => {
    expect(truncateForLog({ a: 1 })).toBe('{"a":1}');
  });

  it("textul lung se taie și spune cât s-a tăiat", () => {
    const out = truncateForLog("x".repeat(5000))!;
    expect(out.startsWith("x".repeat(4096))).toBe(true);
    expect(out).toContain("[truncated 904 chars]");
  });

  it("limita e configurabilă", () => {
    expect(truncateForLog("abcdef", 3)).toBe("abc…[truncated 3 chars]");
  });

  it("o valoare neserializabilă (funcție) → null", () => {
    expect(truncateForLog(() => 1)).toBeNull();
  });
});
