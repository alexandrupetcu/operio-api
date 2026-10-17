/**
 * Shared, hardened puppeteer browser for the worker processes.
 *
 * One Chromium per process (launched lazily, relaunched if it disconnects),
 * one `newPage()` per job. `withPage()` applies the same hardening everywhere:
 *   - JavaScript disabled (templates are static HTML; nothing needs scripting)
 *   - request interception: only data:/about:/blob: URLs plus IMAGE requests to
 *     our own S3 host are allowed (presigned logo/stamp/signature URLs); every
 *     other network request is aborted
 *   - 30 s default + navigation timeouts
 */
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";
import { env } from "../config/env.js";

const TIMEOUT_MS = 30_000;

// `--no-sandbox` is required by the Docker image: Chromium runs as the
// unprivileged `node` user (Dockerfile `USER node`) without user namespaces,
// so the setuid/namespace sandbox cannot be set up. JS is disabled on every
// page and all network access is blocked below, which is the mitigation.
const LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];

let browserPromise: Promise<Browser> | null = null;

/** Hosts (lowercase) that image requests may be fetched from. */
function allowedImageHost(host: string): boolean {
  const h = host.toLowerCase();
  if (env.S3_ENDPOINT) {
    try {
      return h === new URL(env.S3_ENDPOINT).host.toLowerCase();
    } catch {
      return false;
    }
  }
  // Real AWS: virtual-hosted (bucket.s3.region.amazonaws.com) or path-style
  // (s3.region.amazonaws.com) presigned URLs.
  return /(^|\.)amazonaws\.com$/.test(h);
}

/** Decide whether an intercepted request may proceed. Exported for tests. */
export function isAllowedRequest(url: string, resourceType: string): boolean {
  if (/^(data|about|blob):/i.test(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Only images (logo / stamp / signature) are ever loaded from S3; styles,
  // fonts, frames, scripts etc. stay inline or blocked.
  return resourceType === "image" && allowedImageHost(parsed.host);
}

function onRequest(req: HTTPRequest) {
  if (isAllowedRequest(req.url(), req.resourceType())) {
    req.continue().catch(() => {});
  } else {
    req.abort("blockedbyclient").catch(() => {});
  }
}

/** Launch (or reuse) the process-wide browser. */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({ headless: true, args: LAUNCH_ARGS })
      .then((browser) => {
        browser.on("disconnected", () => {
          // Next job relaunches.
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/**
 * Run `fn` against a fresh, hardened page of the shared browser. The page is
 * always closed afterwards; the browser stays up for the next job.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", onRequest);
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Shut the shared browser down (graceful worker exit). */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    /* already gone */
  }
}
