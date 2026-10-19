import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedDocument, seedRegistrySeries, seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as registry from "./registry.service.js";
import { createEntrySchema } from "./registry.schema.js";

let app: FastifyInstance;
let f: TwoTenants;
let seriesA: { id: string };
let seriesB: { id: string };
let docA: { id: string };
let docB: { id: string };

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  seriesA = await seedRegistrySeries(f.a.id);
  seriesB = await seedRegistrySeries(f.b.id);
  docA = await seedDocument(f.a.id, "Document A");
  docB = await seedDocument(f.b.id, "Document B");
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const entry = (over: Record<string, unknown>) =>
  createEntrySchema.parse({ seriesId: seriesA.id, subject: "Adresă către OS", ...over });

describe("izolarea între firme — registratură", () => {
  it("documentId-ul firmei B → 400 „Documentul nu aparține firmei”, fără număr alocat", async () => {
    const err = await expectReject(() =>
      registry.createEntry(app, f.a.id, f.a.admin.id, entry({ documentId: docB.id }), true),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Documentul nu aparține firmei/);
    expect(await prisma.registryEntry.count({ where: { tenantId: f.a.id } })).toBe(0);
  });

  it("clientId-ul firmei B → 400", async () => {
    const err = await expectReject(() =>
      registry.createEntry(app, f.a.id, f.a.admin.id, entry({ clientId: f.b.clientId }), true),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Clientul nu aparține firmei/);
  });

  it("seria firmei B → 404 (nu există pentru firma A)", async () => {
    const err = await expectReject(() =>
      registry.createEntry(app, f.a.id, f.a.admin.id, entry({ seriesId: seriesB.id }), true),
    );
    expect(err.status).toBe(404);
    expect(await prisma.registryEntry.count({ where: { tenantId: f.b.id } })).toBe(0);
  });

  it("documentul propriu → intrarea se creează, cu număr și displayNumber", async () => {
    const created = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({ documentId: docA.id }), true);
    expect(created.tenantId).toBe(f.a.id);
    expect(created.number).toBe(1);
    expect(created.status).toBe("active");
    expect(created.displayNumber).toBe(`OUT-1/${new Date().getFullYear()}`);
  });

  it("numerele cresc per firmă, independent (A și B pornesc amândouă de la 1)", async () => {
    await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    const a2 = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    const b1 = await registry.createEntry(
      app,
      f.b.id,
      f.b.admin.id,
      createEntrySchema.parse({ seriesId: seriesB.id, subject: "Adresă B" }),
      true,
    );
    expect(a2.number).toBe(2);
    expect(b1.number).toBe(1);
  });

  it("numărul manual duplicat → 409", async () => {
    await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    const err = await expectReject(() =>
      registry.createEntry(
        app,
        f.a.id,
        f.a.admin.id,
        entry({ manualNumber: 1, overrideReason: "corectie numar alocat greșit" }),
        true,
      ),
    );
    expect(err.status).toBe(409);
  });

  it("numărul manual fără rol de ADMIN → 403", async () => {
    const err = await expectReject(() =>
      registry.createEntry(
        app,
        f.a.id,
        f.a.operator.id,
        entry({ manualNumber: 5, overrideReason: "vreau numarul 5 pentru test" }),
        false,
      ),
    );
    expect(err.status).toBe(403);
  });

  it("intrarea firmei B nu e vizibilă din A", async () => {
    const b = await registry.createEntry(
      app,
      f.b.id,
      f.b.admin.id,
      createEntrySchema.parse({ seriesId: seriesB.id, subject: "Adresă B" }),
      true,
    );
    const err = await expectReject(() => registry.getEntryById(app, f.a.id, b.id));
    expect(err.status).toBe(404);
  });

  it("anularea din A a intrării lui B → 404, rândul lui B rămâne activ", async () => {
    const b = await registry.createEntry(
      app,
      f.b.id,
      f.b.admin.id,
      createEntrySchema.parse({ seriesId: seriesB.id, subject: "Adresă B" }),
      true,
    );
    const err = await expectReject(() =>
      registry.voidEntry(app, f.a.id, f.a.admin.id, b.id, { voidReason: "anulare neautorizată de test" }),
    );
    expect(err.status).toBe(404);
    const row = await prisma.registryEntry.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.status).toBe("active");
  });
});

describe("anularea unei intrări", () => {
  it("anularea păstrează rândul și numărul (nu se șterge)", async () => {
    const created = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    const voided = await registry.voidEntry(app, f.a.id, f.a.admin.id, created.id, {
      voidReason: "document emis greșit, se reemite",
    });
    expect(voided.status).toBe("voided");
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidedById).toBe(f.a.admin.id);
    expect(voided.number).toBe(created.number);
    expect(await prisma.registryEntry.count({ where: { id: created.id } })).toBe(1);
  });

  it("a doua anulare → 400", async () => {
    const created = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    await registry.voidEntry(app, f.a.id, f.a.admin.id, created.id, { voidReason: "prima anulare, motiv lung" });
    const err = await expectReject(() =>
      registry.voidEntry(app, f.a.id, f.a.admin.id, created.id, { voidReason: "a doua anulare, motiv lung" }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/already voided/i);
  });

  it("numărul anulat NU se reciclează", async () => {
    const first = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    await registry.voidEntry(app, f.a.id, f.a.admin.id, first.id, { voidReason: "anulare pentru test de numerotare" });
    const second = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    expect(second.number).toBe(first.number + 1);
  });

  it("o intrare anulată nu mai poate fi editată", async () => {
    const created = await registry.createEntry(app, f.a.id, f.a.admin.id, entry({}), true);
    await registry.voidEntry(app, f.a.id, f.a.admin.id, created.id, { voidReason: "anulare înainte de editare" });
    const err = await expectReject(() => registry.updateEntry(app, f.a.id, created.id, { subject: "Alt subiect" }));
    expect(err.status).toBe(400);
  });
});
