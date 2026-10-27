import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { invalidateEntitlements } from "../../lib/entitlements/resolve.js";
import * as users from "./users.service.js";
import { ensureEmployeeForMobileUser } from "./employee-link.js";
import { me } from "../auth/auth.service.js";
import { createUserSchema } from "./users.schema.js";

let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

/** Schimbă abonamentul firmei și invalidează cache-ul de 60 s din resolve.ts. */
async function setPlan(tenantId: string, data: { plan?: string; planUntil?: Date | null; overrides?: unknown }) {
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      ...(data.plan !== undefined && { plan: data.plan }),
      ...(data.planUntil !== undefined && { planUntil: data.planUntil }),
      ...(data.overrides !== undefined && { entitlementOverrides: data.overrides as never }),
    },
  });
  invalidateEntitlements(tenantId);
}

async function extraUser(tenantId: string, n: number) {
  return prisma.user.create({
    data: {
      tenantId,
      email: `extra${n}.${tenantId.slice(-4)}@fixture.test`,
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$fixture$fixture",
      firstName: "Extra",
      lastName: String(n),
      role: "OPERATOR",
    },
  });
}

describe("limita de locuri de tehnician (mobileAccess)", () => {
  it("cu technicianSeats: 1, al doilea utilizator cu acces mobil → 402", async () => {
    await setPlan(f.a.id, { overrides: { limits: { technicianSeats: 1 } } });
    const second = await extraUser(f.a.id, 1);

    // Primul loc: trece.
    const first = await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
    expect(first.mobileAccess).toBe(true);

    // Al doilea: locurile sunt epuizate.
    const err = await expectReject(() => users.update(app, f.a.id, second.id, { mobileAccess: true }));
    expect(err.status).toBe(402);
    expect(err.message).toMatch(/tehnicieni cu acces mobil/);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.mobileAccess).toBe(false);
  });

  it("402-ul poartă `feature` și `upgradeTo` (handler-ul global le pune în corp)", async () => {
    await setPlan(f.a.id, { overrides: { limits: { technicianSeats: 0 } } });
    try {
      await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
      throw new Error("ar fi trebuit să arunce");
    } catch (err) {
      const e = err as { statusCode?: number; feature?: string; upgradeTo?: string };
      expect(e.statusCode).toBe(402);
      expect(e.feature).toBe("field.mobile");
      expect(e.upgradeTo).toBe("execution");
    }
  });

  it("reactivarea aceluiași utilizator nu consumă un loc în plus", async () => {
    await setPlan(f.a.id, { overrides: { limits: { technicianSeats: 1 } } });
    await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
    // Același id: numărătoarea exclude utilizatorul curent (`id: { not: id }`).
    const again = await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
    expect(again.mobileAccess).toBe(true);
  });

  it("eliberarea unui loc permite activarea altui tehnician", async () => {
    await setPlan(f.a.id, { overrides: { limits: { technicianSeats: 1 } } });
    const second = await extraUser(f.a.id, 2);
    await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
    await expectReject(() => users.update(app, f.a.id, second.id, { mobileAccess: true }));

    await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: false });
    const ok = await users.update(app, f.a.id, second.id, { mobileAccess: true, createEmployee: true });
    expect(ok.mobileAccess).toBe(true);
  });

  it("utilizatorii inactivi nu ocupă locuri", async () => {
    await setPlan(f.a.id, { overrides: { limits: { technicianSeats: 1 } } });
    const second = await extraUser(f.a.id, 3);
    await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
    await prisma.user.update({ where: { id: f.a.operator.id }, data: { isActive: false } });

    const ok = await users.update(app, f.a.id, second.id, { mobileAccess: true, createEmployee: true });
    expect(ok.mobileAccess).toBe(true);
  });

  it("plan fără `field.mobile` → 402, indiferent de locuri", async () => {
    await setPlan(f.a.id, {
      plan: "field",
      overrides: { features: { remove: ["field.mobile"] }, limits: { technicianSeats: 50 } },
    });
    const err = await expectReject(() => users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true }));
    expect(err.status).toBe(402);
    expect(err.message).toMatch(/nu este inclusă în abonament/);
  });

  it("limita e per firmă: locurile lui B nu afectează A", async () => {
    await setPlan(f.a.id, { overrides: { limits: { technicianSeats: 1 } } });
    await setPlan(f.b.id, { overrides: { limits: { technicianSeats: 1 } } });
    await users.update(app, f.b.id, f.b.operator.id, { mobileAccess: true });
    const ok = await users.update(app, f.a.id, f.a.operator.id, { mobileAccess: true });
    expect(ok.mobileAccess).toBe(true);
  });
});

describe("izolarea între firme — utilizatori", () => {
  it("update din A pe utilizatorul lui B → 404", async () => {
    const err = await expectReject(() => users.update(app, f.a.id, f.b.operator.id, { firstName: "HACKED" }));
    expect(err.status).toBe(404);
    const b = await prisma.user.findUniqueOrThrow({ where: { id: f.b.operator.id } });
    expect(b.firstName).toBe("Operator");
  });

  it("legarea unui angajat din firma B → 404", async () => {
    const err = await expectReject(() => users.update(app, f.a.id, f.a.admin.id, { employeeId: f.b.employeeId }));
    expect(err.status).toBe(404);
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: f.b.employeeId } });
    expect(emp.userId).toBe(f.b.operator.id);
  });
});

describe("adăugarea unui utilizator cu o adresă deja folosită", () => {
  const input = (email: string) =>
    createUserSchema.parse({ email, password: "parola-test-123", firstName: "Nou", lastName: "Utilizator", role: "OPERATOR" });

  it("adresa unui cont din ALTĂ firmă → 409 cu un mesaj care spune ce s-a întâmplat și ce e de făcut", async () => {
    const err = await expectReject(() => users.create(app, f.a.id, input(f.b.admin.email)));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/are deja un cont Operio/);
    expect(err.message).toMatch(/altă adresă/);
    // Nu spune la ce firmă e contul.
    expect(err.message).not.toMatch(/Firma B/);
  });

  it("adresa unui utilizator din aceeași firmă → mesaj că e deja în echipă", async () => {
    const err = await expectReject(() => users.create(app, f.a.id, input(f.a.operator.email)));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/deja în echipa ta/);
  });

  it("aceeași adresă cu alte majuscule → tot conflict, fără al doilea cont", async () => {
    const err = await expectReject(() => users.create(app, f.a.id, input(f.b.admin.email.toUpperCase())));
    expect(err.status).toBe(409);
    expect(await prisma.user.count({ where: { email: { equals: f.b.admin.email, mode: "insensitive" } } })).toBe(1);
  });
});

describe("accesul mobil cere un angajat legat de cont (programările din teren se repartizează pe el)", () => {
  it("cont nelegat, fără employeeId / createEmployee → 400 și accesul rămâne oprit", async () => {
    const err = await expectReject(() => users.update(app, f.a.id, f.a.admin.id, { mobileAccess: true }));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/angajat/i);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } });
    expect(row.mobileAccess).toBe(false);
  });

  it("createEmployee: true → angajat creat din numele contului și legat; al doilea apel nu dublează", async () => {
    const updated = await users.update(app, f.a.id, f.a.admin.id, { mobileAccess: true, createEmployee: true }, f.a.admin.id);
    expect(updated.mobileAccess).toBe(true);
    const linked = await prisma.employee.findMany({ where: { tenantId: f.a.id, userId: f.a.admin.id } });
    expect(linked).toHaveLength(1);
    expect(linked[0].firstName).toBe("Admin");
    expect(linked[0].email).toBe(`admin.a@fixture.test`);

    await users.update(app, f.a.id, f.a.admin.id, { mobileAccess: true, createEmployee: true }, f.a.admin.id);
    expect(await prisma.employee.count({ where: { tenantId: f.a.id, userId: f.a.admin.id } })).toBe(1);

    const audit = await prisma.auditLog.findFirst({ where: { tenantId: f.a.id, entityType: "employee", entityId: linked[0].id } });
    expect(audit?.action).toBe("auto_link");
  });

  it("employeeId în același PATCH → se leagă de angajatul ales (nelegat de alt cont)", async () => {
    const free = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Liber", lastName: "A", position: "instalator" } });
    const updated = await users.update(app, f.a.id, f.a.admin.id, { mobileAccess: true, employeeId: free.id });
    expect(updated.mobileAccess).toBe(true);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: free.id } })).userId).toBe(f.a.admin.id);
  });

  it("login din mobil pe un cont cu acces dar nelegat → angajat creat o singură dată, iar /auth/me îl întoarce", async () => {
    await prisma.user.update({ where: { id: f.a.admin.id }, data: { mobileAccess: true } });
    await ensureEmployeeForMobileUser(app, { id: f.a.admin.id, tenantId: f.a.id });
    await ensureEmployeeForMobileUser(app, { id: f.a.admin.id, tenantId: f.a.id });
    expect(await prisma.employee.count({ where: { tenantId: f.a.id, userId: f.a.admin.id } })).toBe(1);
    const profile = await me(app, f.a.admin.id);
    expect(profile.employee?.firstName).toBe("Admin");
  });
});
