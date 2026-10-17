import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-safe `fetch` for user/tenant-configured URLs (workflow `call_api`
 * actions, frontend event proxies, ...).
 *
 * - only `http:` / `https:`
 * - the hostname is resolved up-front and every resolved address must be a
 *   public one (loopback, link-local, RFC1918, ULA, 0.0.0.0, ... are rejected),
 *   plus a denylist of literal hostnames (`localhost`, `*.internal`, `*.local`
 *   and the Docker Compose service names)
 * - hard timeout (`AbortSignal.timeout`)
 * - redirects are followed manually (max 3) and every hop is re-validated
 * - the response body is capped (1 MB by default)
 *
 * `pinnedOrigin` is for calls to our own API (`apiType: "internal"`): the
 * address check is skipped but every hop must stay on that exact origin.
 */

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  /** Whole-operation timeout (all redirect hops + body read). Default 10 s. */
  timeoutMs?: number;
  /** Max redirect hops. Default 3. */
  maxRedirects?: number;
  /** Max response body size in bytes. Default 1 MB. */
  maxBodyBytes?: number;
  /**
   * When set, the URL (and every redirect hop) must have exactly this origin
   * and the private-address check is skipped. Use ONLY for our own base URL.
   */
  pinnedOrigin?: string;
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Body text, capped at `maxBodyBytes`. */
  body: string;
  /** Final URL after redirects. */
  url: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  // Docker Compose service names (see /deploy)
  "api",
  "postgres",
  "redis",
  "caddy",
  "workers",
]);
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local"];

function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === "internal" || h === "local") return true;
  return BLOCKED_SUFFIXES.some((s) => h.endsWith(s));
}

function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function isPrivateIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return true; // unparsable → treat as unsafe
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 ("this network", incl. 0.0.0.0)
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space (CGNAT)
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  let h = ip.toLowerCase();
  const zone = h.indexOf("%");
  if (zone !== -1) h = h.slice(0, zone);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

  if (h === "::" || h === "::1") return true; // unspecified / loopback
  // IPv4-mapped / IPv4-compatible (::ffff:1.2.3.4, ::1.2.3.4)
  const v4 = h.match(/^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return isPrivateIPv4(v4[1]);
  // ::ffff:7f00:1 hex form of IPv4-mapped
  const v4hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (/^fe[89ab]/.test(h)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(h)) return true; // unique-local fc00::/7
  if (/^ff/.test(h)) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ""));
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true;
}

/**
 * Validate a URL for an outbound call: scheme, literal hostname denylist and
 * every DNS-resolved address. Throws `SafeFetchError` when unsafe.
 */
export async function assertSafeUrl(input: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new SafeFetchError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`Unsupported URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError("Credentials in URL are not allowed");
  }

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new SafeFetchError(`Host not allowed: ${hostname}`);
  }

  // Literal IP → no DNS needed.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SafeFetchError(`Host resolves to a private address: ${hostname}`);
    }
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError(`Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new SafeFetchError(`Could not resolve host: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SafeFetchError(`Host resolves to a private address: ${hostname}`);
    }
  }
  return url;
}

function assertPinnedOrigin(input: string | URL, pinnedOrigin: string): URL {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new SafeFetchError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(`Unsupported URL scheme: ${url.protocol}`);
  }
  let pinned: URL;
  try {
    pinned = new URL(pinnedOrigin);
  } catch {
    throw new SafeFetchError("Invalid pinned origin");
  }
  if (url.origin !== pinned.origin) {
    throw new SafeFetchError(`URL must stay on ${pinned.origin}`);
  }
  return url;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeFetchError(`Response body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SafeFetchError(`Response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(
  url: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<SafeFetchResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const validate = (u: string | URL) =>
    options.pinnedOrigin ? Promise.resolve(assertPinnedOrigin(u, options.pinnedOrigin)) : assertSafeUrl(u);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;

  let current = await validate(url);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers ?? {});

  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        method,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        headers,
        redirect: "manual",
        signal,
      });
    } catch (err) {
      if (timeoutSignal.aborted) throw new SafeFetchError(`Request timed out after ${timeoutMs} ms`);
      throw err;
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new SafeFetchError("Redirect without Location header");
      if (hop >= maxRedirects) throw new SafeFetchError(`Too many redirects (> ${maxRedirects})`);

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SafeFetchError("Invalid redirect Location");
      }
      current = await validate(next);

      // Per fetch spec: 303 always → GET; 301/302 switch POST → GET.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      // Do not leak credentials across origins.
      if (next.origin !== new URL(url).origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      continue;
    }

    let text: string;
    try {
      text = await readBodyCapped(response, maxBodyBytes);
    } catch (err) {
      if (timeoutSignal.aborted) throw new SafeFetchError(`Request timed out after ${timeoutMs} ms`);
      throw err;
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: text,
      url: current.toString(),
    };
  }
}

/** Truncate a value for persistence in logs (JSON-encoded, max `maxChars`). */
export function truncateForLog(value: unknown, maxChars = 4096): string | null {
  if (value === undefined || value === null) return null;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return null;
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars]` : s;
}
