import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as clientsService from "./clients.service.js";
import { equipmentInputSchema, updateClientSchema } from "./clients.schema.js";

let app: FastifyInstance;
let f: TwoTenants;

/** Trecem prin schema reală, ca testul să nu poată construi un input imposibil. */
const upd = (input: unknown) => updateClientSchema.parse(input);

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("izolarea între firme — clienți", () => {
  it("un client al firmei B nu e vizibil din firma A", async () => {
    const err = await expectReject(() => clientsService.getById(app, f.a.id, f.b.clientId));
    expect(err.status).toBe(404);
  });

  it("update în A cu id-ul de adresă al lui B → 400, iar rândul lui B rămâne intact", async () => {
    const before = await prisma.clientAddress.findUniqueOrThrow({ where: { id: f.b.addressId } });

    const err = await expectReject(() =>
      clientsService.update(
        app,
        f.a.id,
        f.a.clientId,
        upd({ type: "PERSON", addresses: [{ id: f.b.addressId, address: "ADRESĂ FURATĂ", isPrimary: true }] }),
      ),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Adresa nu aparține clientului/);

    const after = await prisma.clientAddress.findUniqueOrThrow({ where: { id: f.b.addressId } });
    expect(after.address).toBe(before.address);
    expect(after.clientId).toBe(f.b.clientId);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("tranzacția se derulează înapoi: adresa proprie a lui A NU a fost ștearsă", async () => {
    // `update` șterge adresele care nu apar în listă ÎNAINTE de a valida id-urile,
    // deci regresia pe care o păzim e ca throw-ul să anuleze și ștergerea.
    await expectReject(() =>
      clientsService.update(
        app,
        f.a.id,
        f.a.clientId,
        upd({ type: "PERSON", addresses: [{ id: f.b.addressId, address: "x", isPrimary: true }] }),
      ),
    );
    const own = await prisma.clientAddress.findUnique({ where: { id: f.a.addressId } });
    expect(own).not.toBeNull();
    expect(own!.address).toBe("Str. Fixture a nr. 1");
  });

  it("update cu adresa proprie reușește", async () => {
    await clientsService.update(
      app,
      f.a.id,
      f.a.clientId,
      upd({ type: "PERSON", addresses: [{ id: f.a.addressId, address: "Str. Nouă nr. 2", isPrimary: true }] }),
    );
    const own = await prisma.clientAddress.findUniqueOrThrow({ where: { id: f.a.addressId } });
    expect(own.address).toBe("Str. Nouă nr. 2");
  });

  it("update în A pe clientul lui B → 404, fără efect", async () => {
    const err = await expectReject(() =>
      clientsService.update(app, f.a.id, f.b.clientId, upd({ type: "PERSON", lastName: "HACKED" })),
    );
    expect(err.status).toBe(404);
    const b = await prisma.client.findUniqueOrThrow({ where: { id: f.b.clientId } });
    expect(b.lastName).toBe("ClientB");
  });

  it("listarea din A nu conține clienții lui B", async () => {
    const res = await clientsService.list(app, f.a.id, {
      page: 1,
      limit: 50,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    const ids = res.data.map((c) => c.id);
    expect(ids).toContain(f.a.clientId);
    expect(ids).not.toContain(f.b.clientId);
    expect(res.data.length).toBe(1);
  });

  it("echipamentul lui B nu poate fi atașat unui client din A", async () => {
    const err = await expectReject(() =>
      clientsService.update(
        app,
        f.a.id,
        f.a.clientId,
        upd({ type: "PERSON", equipment: [{ id: f.b.equipmentId, internalName: "Furat" }] }),
      ),
    );
    expect(err.status).toBe(400);
    const b = await prisma.equipment.findUniqueOrThrow({ where: { id: f.b.equipmentId } });
    expect(b.internalName).toBe("Centrală fixture");
  });

  it("adresa lui B nu poate fi atribuită unui echipament din A", async () => {
    const err = await expectReject(() =>
      clientsService.update(
        app,
        f.a.id,
        f.a.clientId,
        upd({
          type: "PERSON",
          addresses: [{ id: f.a.addressId, address: "Str. Fixture a nr. 1", isPrimary: true }],
          equipment: [{ id: f.a.equipmentId, internalName: "Centrală fixture", clientAddressId: f.b.addressId }],
        }),
      ),
    );
    expect(err.status).toBe(400);
    const own = await prisma.equipment.findUniqueOrThrow({ where: { id: f.a.equipmentId } });
    expect(own.clientAddressId).toBe(f.a.addressId);
  });

  it("removeAddress din A pe adresa lui B → 404", async () => {
    const err = await expectReject(() => clientsService.removeAddress(app, f.a.id, f.a.clientId, f.b.addressId));
    expect(err.status).toBe(404);
    expect(await prisma.clientAddress.count({ where: { id: f.b.addressId } })).toBe(1);
  });
});

describe("acordul GDPR existent al clientului", () => {
  it("fără document GDPR → null; cu un acord finalizat → data lui; clientul firmei A din firma B → 404", async () => {
    expect(await clientsService.gdprConsent(app, f.a.id, f.a.clientId)).toEqual({ consentedAt: null });

    await prisma.templateCategory.upsert({ where: { code: "GDPR" }, update: {}, create: { code: "GDPR", name: "GDPR" } });
    const template = await prisma.documentTemplate.create({ data: { tenantId: f.a.id, categoryCode: "GDPR", name: "Acord GDPR", content: "<p>x</p>" } });
    const when = new Date(2026, 2, 3, 9);
    await prisma.document.create({
      data: { tenantId: f.a.id, templateId: template.id, name: "Acord GDPR - auto", status: "COMPLETED", createdAt: when, clients: { create: { clientId: f.a.clientId } } },
    });
    expect(await clientsService.gdprConsent(app, f.a.id, f.a.clientId)).toEqual({ consentedAt: when });
    expect((await expectReject(() => clientsService.gdprConsent(app, f.b.id, f.a.clientId))).status).toBe(404);
  });
});

describe("echipamente — câmpurile tehnice de pe fișa din teren", () => {
  it("tip aparat, putere, aer, alimentare, loc, vârstă se salvează la creare și la modificare", async () => {
    const eq = await clientsService.addEquipment(
      app,
      f.a.id,
      f.a.clientId,
      equipmentInputSchema.parse({
        internalName: "Centrală bucătărie",
        serial: "VL-1",
        deviceType: "MURALA",
        power: "24",
        airSupply: "insuflat",
        feeding: "automata",
        location: "BUCĂTĂRIE",
        deviceAge: "nou",
      }),
    );
    expect(eq.deviceType).toBe("MURALA");
    expect(eq.power).toBe("24");
    expect(eq.airSupply).toBe("insuflat");
    expect(eq.location).toBe("BUCĂTĂRIE");
    expect(eq.deviceAge).toBe("nou");

    const upd2 = await clientsService.updateEquipment(app, f.a.id, f.a.clientId, eq.id, equipmentInputSchema.partial().parse({ power: "28", feeding: "manuala" }));
    expect(upd2.power).toBe("28");
    expect(upd2.feeding).toBe("manuala");
    expect(upd2.deviceType).toBe("MURALA");
  });
});
