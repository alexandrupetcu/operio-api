/**
 * Tenant ownership guard for S3 object keys that come from DATA (JSON columns,
 * job context, template data) rather than from code. Every tenant-owned object
 * is stored under `${tenantId}/…`, so a key that doesn't carry the job's tenant
 * prefix is either corrupt or an attempt to read another tenant's file.
 */

/** True when `key` is a non-empty string stored under the tenant's prefix. */
export function isTenantKey(tenantId: string, key: unknown): key is string {
  if (typeof key !== "string" || !tenantId) return false;
  if (!key.startsWith(`${tenantId}/`)) return false;
  // No path-traversal segments inside the key either.
  return !key.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * Soft assertion: logs a warning and returns false when the key is outside the
 * tenant's prefix, so the caller can SKIP the asset (render without it) instead
 * of failing the whole document.
 */
export function assertTenantKey(tenantId: string, key: unknown, what = "asset"): key is string {
  if (isTenantKey(tenantId, key)) return true;
  console.warn(
    `[s3-guard] Refusing ${what}: key ${JSON.stringify(key)} is outside tenant ${tenantId} — skipped`,
  );
  return false;
}
