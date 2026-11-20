import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { bulkOsSubmission } from "./os-registration.js";

/** Revizii → bifezi mai multe fișe „de depus” și le marchezi depuse cu aceeași dată. */
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

const visit = (t: TwoTenants["a"], over: Record<string, unknown> = {}) =>
  prisma.appointment.create({
    data: {
      tenantId: t.id, clientId: t.clientId, type: "verificare_instalatie", title: "Verificare",
      date: new Date(2026, 10, 10), duration: 60, status: "completed", completedAt: new Date(2026, 10, 10),
      completionOutcome: "raport_complet", ...over,
    },
  });

describe("depunerea la OS în bloc", () => {
  it("marchează ce se poate, sare (cu motiv) fără raport și pe ale altei firme", async () => {
    const a1 = await visit(f.a);
    const a2 = await visit(f.a);
    const noReport = await visit(f.a, { completionOutcome: "revenire" });
    const other = await visit(f.b);
    const res = await bulkOsSubmission(app, f.a.id, [a1.id, a2.id, noReport.id, other.id], "2026-11-12T08:00:00.000Z");
    expect(res.marked.sort()).toEqual([a1.id, a2.id].sort());
    expect(res.skipped.map((s) => s.id).sort()).toEqual([noReport.id, other.id].sort());
    expect(res.skipped.every((s) => s.reason)).toBe(true);
    const rows = await prisma.appointment.findMany({ where: { id: { in: [a1.id, a2.id, noReport.id, other.id] } }, select: { id: true, osSubmittedAt: true } });
    expect(rows.filter((r) => r.osSubmittedAt).map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
  });
});
