import { randomBytes } from "crypto";
import { basename, extname } from "path";

/**
 * Build a deterministic-length, safe S3 object name from a user-supplied
 * filename.
 *
 * Why this exists:
 *   - User-supplied filenames CAN contain `../`, null bytes, control chars,
 *     forward/back slashes, etc. Embedding them directly into an S3 key like
 *     `tenantId/projects/abc/${file.filename}` lets an attacker traverse out
 *     of the tenant prefix (S3 normalizes `..` segments client-side via the
 *     SDK in some clients, but more importantly the *URLs* leak the original
 *     filename and downstream code may use the path for routing).
 *   - Collision-resistance: two uploads of `invoice.pdf` should not stomp
 *     each other.
 *   - Privacy: the original filename (often customer/document identifying)
 *     no longer leaks into presigned URLs.
 *
 * Output shape: `<16-hex-random>.<ext>` where ext is the cleaned extension
 * (≤16 chars, only `[a-zA-Z0-9]`). No extension → just the random part.
 */
export function safeS3Filename(rawFilename: string | undefined | null): string {
  const random = randomBytes(8).toString("hex");

  if (!rawFilename) return random;

  // Strip path separators + null bytes by taking basename, then drop any
  // remaining control chars / weirdness.
  const stripped = basename(rawFilename).replace(/[\x00-\x1f\x7f]/g, "");
  const ext = extname(stripped).replace(/^\./, "").toLowerCase();

  if (!ext) return random;

  // Only allow safe alphanumeric extensions to prevent things like
  // `.php`/`.html`/`.svg` chains or attacker-controlled multi-extension
  // ambiguity (`foo.php.pdf`).
  const safeExt = ext.slice(0, 16).replace(/[^a-z0-9]/g, "");
  if (!safeExt) return random;

  return `${random}.${safeExt}`;
}
