/**
 * Sanitizer for user-controlled JSON that gets spread into document template
 * data (project metadata, workflow step outputs, …).
 *
 * Strips the keys the worker computes itself (tenant_*, signatures, stamps,
 * registry numbers, OS registration) so a user can't override them, and drops
 * any value shaped like an image reference (`{ s3Key }`) so a user can't make
 * the renderer download an arbitrary S3 object into the document.
 */

const RESERVED_KEY_PATTERNS: RegExp[] = [
  /^tenant[._]/, // tenant_* (name, stamp, signature, logo…) + dot-notation tenant.*
  /_signature$/, // rte_signature, sudor_signature, tenant_signature…
  /^client_signature/, // client_signature + any suffix
  /^project_drawing(_mic)?$/,
  /^nr_inregistrare/, // nr_inregistrare, nr_inregistrare_data
  /^data_inregistrare/, // DOCX alias of the registry date
  /^os_/, // os_nr_inregistrare, os_data_inregistrare
];

const MAX_DEPTH = 8;

export function isReservedTemplateKey(key: string): boolean {
  return RESERVED_KEY_PATTERNS.some((re) => re.test(key));
}

function isImageRef(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "s3Key" in (value as Record<string, unknown>)
  );
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (isImageRef(value)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((v) => sanitizeValue(v, depth + 1))
      .filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    return sanitizeTemplateInput(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

/**
 * Returns a copy of `obj` without reserved keys and without image references
 * (recursively — nested objects/arrays are walked too). Non-objects yield {}.
 */
export function sanitizeTemplateInput(
  obj: unknown,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isReservedTemplateKey(key)) continue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const clean = sanitizeValue(value, depth);
    if (clean === undefined) continue;
    out[key] = clean;
  }
  return out;
}
