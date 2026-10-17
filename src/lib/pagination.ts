import { z } from "zod";

/**
 * Fields any list endpoint may sort by unless it passes its own allowlist.
 * `sortBy` is interpolated straight into Prisma's `orderBy`, so it must never
 * be an arbitrary client string (it would otherwise let callers probe any
 * column, including relations/sensitive fields).
 */
export const DEFAULT_SORTABLE_FIELDS = ["createdAt", "updatedAt", "name"] as const;

/** Build a pagination query schema restricted to the given sortable fields. */
export function paginationSchemaFor(sortable: readonly string[] = DEFAULT_SORTABLE_FIELDS) {
  const allowed = new Set(sortable);
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    sortBy: z
      .string()
      .default("createdAt")
      .refine((v) => allowed.has(v), { message: "Câmp de sortare invalid" }),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  });
}

/** Default schema — sorts only by DEFAULT_SORTABLE_FIELDS. */
export const paginationSchema = paginationSchemaFor();

export type PaginationQuery = z.infer<typeof paginationSchema>;

export function paginationMeta(total: number, query: PaginationQuery) {
  return {
    total,
    page: query.page,
    limit: query.limit,
    totalPages: Math.ceil(total / query.limit),
  };
}

/**
 * Prisma `orderBy` from an already-validated query. A second allowlist check
 * guards callers that build the query without `paginationSchema`.
 */
export function buildOrderBy(
  query: Pick<PaginationQuery, "sortBy" | "sortOrder">,
  sortable: readonly string[] = DEFAULT_SORTABLE_FIELDS
) {
  if (!sortable.includes(query.sortBy)) {
    const err = new Error("Câmp de sortare invalid") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return { [query.sortBy]: query.sortOrder };
}

export function paginationArgs(query: PaginationQuery, sortable: readonly string[] = DEFAULT_SORTABLE_FIELDS) {
  return {
    skip: (query.page - 1) * query.limit,
    take: query.limit,
    orderBy: buildOrderBy(query, sortable),
  };
}
