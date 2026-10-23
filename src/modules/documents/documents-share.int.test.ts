import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { createShareLink, resolveShareLink, revokeShareLink, shareLinkUrl } from "./documents-share.service.js";

/**
 * Linkul trimis clientului (WhatsApp / e-mail): public, cu termen de 30 de zile, doar pe
 * documente finalizate; se refolosește cât e valabil; retras sau expirat → nu mai deschide.
 */
let app: FastifyInstance;
let f: TwoTenants;

const doc = (tenantId: string, over: Record<string, unknown> = {}) =>
  prisma.document.create({ data: { tenantId, name: "Fișă verificare — Ion", status: "COMPLETED", s3Key: `${tenantId}/docs/fisa.pdf`, ...over } });

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("linkul public al documentului", () => {
  it("se creează pe un document finalizat, se refolosește cât e valabil și deschide fișierul", async () => {
    const d = await doc(f.a.id);
    const link = await createShareLink(app, f.a.id, f.a.admin.id, d.id);
    expect(link.url).toBe(shareLinkUrl(link.url.split("/").pop()!));
    expect(link.url).toMatch(/\/api\/documents\/shared\/[A-Za-z0-9_-]{40,}$/);
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const again = await createShareLink(app, f.a.id, f.a.admin.id, d.id);
    expect(again.url).toBe(link.url);
    expect(await prisma.documentShareLink.count({ where: { documentId: d.id } })).toBe(1);

    const token = link.url.split("/").pop()!;
    const opened = await resolveShareLink(app, token);
    expect(opened.url).toContain("fisa.pdf");
    expect(opened.url).toMatch(/X-Amz-Expires=300/);
    const row = await prisma.documentShareLink.findUniqueOrThrow({ where: { token } });
    expect(row.openedCount).toBe(1);
    expect(row.lastOpenedAt).toBeInstanceOf(Date);
  });

  it("nu se creează pe documente negenerate sau ale altei firme", async () => {
    const pending = await doc(f.a.id, { status: "PENDING", s3Key: null });
    expect((await expectReject(() => createShareLink(app, f.a.id, f.a.admin.id, pending.id))).status).toBe(409);
    const other = await doc(f.b.id);
    expect((await expectReject(() => createShareLink(app, f.a.id, f.a.admin.id, other.id))).status).toBe(404);
  });

  it("expirat → 410; retras → 404; token inventat → 404", async () => {
    const d = await doc(f.a.id);
    const link = await createShareLink(app, f.a.id, f.a.admin.id, d.id);
    const token = link.url.split("/").pop()!;
    await prisma.documentShareLink.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expectReject(() => resolveShareLink(app, token))).status).toBe(410);

    const fresh = await prisma.documentShareLink.create({
      data: { tenantId: f.a.id, documentId: d.id, token: "t".repeat(43), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await revokeShareLink(app, f.a.id, fresh.id);
    expect((await expectReject(() => resolveShareLink(app, fresh.token))).status).toBe(404);
    expect((await expectReject(() => revokeShareLink(app, f.b.id, fresh.id))).status).toBe(404);
    expect((await expectReject(() => resolveShareLink(app, "nu-exista"))).status).toBe(404);
  });
});
