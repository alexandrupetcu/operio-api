import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as appointments from "./appointments.service.js";
import {
  createAppointmentSchema,
  finalizeAppointmentSchema,
  followupAppointmentSchema,
  updateAppointmentSchema,
} from "./appointments.schema.js";

let app: FastifyInstance;
let f: TwoTenants;

const createInput = (over: Record<string, unknown> = {}) =>
  createAppointmentSchema.parse({
    title: "Programare test",
    date: "2026-11-02T08:00:00.000Z",
    duration: 60,
    ...over,
  });

const revenire = (title = "Revenire pentru piesă") =>
  finalizeAppointmentSchema.parse({ outcome: "revenire", followup: { title } });

const revenireFollowup = (title = "Revenire ulterioară") =>
  followupAppointmentSchema.parse({ outcome: "revenire", followup: { title } });

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────
// Izolarea între firme la creare
// ───────────────────────────────────────────────────────────────────────────

describe("o singură programare (GET /:id)", () => {
  it("a firmei → cu client, angajat și instalație; a firmei B → 404; tehnicianul vede doar ce e al lui", async () => {
    const own = await appointments.getById(app, f.a.id, f.a.appointmentId);
    expect(own.client?.id).toBe(f.a.clientId);
    expect(own.employee?.id).toBe(f.a.employeeId);
    expect((await expectReject(() => appointments.getById(app, f.a.id, f.b.appointmentId))).status).toBe(404);
    const colleague = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Coleg", lastName: "A" } });
    expect((await expectReject(() => appointments.getById(app, f.a.id, f.a.appointmentId, { kind: "own", employeeId: colleague.id }))).status).toBe(404);
  });
});

describe("izolarea între firme — crearea unei programări", () => {
  it("clientId-ul firmei B → 400 „Clientul nu aparține firmei”", async () => {
    const err = await expectReject(() => appointments.create(app, f.a.id, createInput({ clientId: f.b.clientId })));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Clientul nu aparține firmei/);
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id } })).toBe(1); // doar cea din fixtură
  });

  it("employeeId-ul firmei B → 400 „Angajatul nu aparține firmei”", async () => {
    const err = await expectReject(() => appointments.create(app, f.a.id, createInput({ employeeId: f.b.employeeId })));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Angajatul nu aparține firmei/);
  });

  it("equipmentId-ul firmei B → 400", async () => {
    const err = await expectReject(() =>
      appointments.create(app, f.a.id, createInput({ equipmentId: f.b.equipmentId })),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Echipamentul nu aparține/);
  });

  it("echipamentul propriu, dar al ALTUI client → 400 „nu aparține clientului”", async () => {
    const other = await prisma.client.create({
      data: { tenantId: f.a.id, type: "PERSON", firstName: "Alt", lastName: "Client", phone: "0721000009" },
    });
    const err = await expectReject(() =>
      appointments.create(app, f.a.id, createInput({ clientId: other.id, equipmentId: f.a.equipmentId })),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/nu aparține clientului/);
  });

  it("installationId-ul firmei B → 400", async () => {
    const err = await expectReject(() =>
      appointments.create(app, f.a.id, createInput({ installationId: f.b.installationId })),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Instalația nu aparține/);
  });

  it("clientAddressId-ul firmei B pe clientul lui A → 400", async () => {
    const err = await expectReject(() =>
      appointments.create(app, f.a.id, createInput({ clientId: f.a.clientId, clientAddressId: f.b.addressId })),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Adresa nu aparține clientului/);
  });

  it("o adresă fără client sau proiect → 400 (nu se poate verifica proprietarul)", async () => {
    const err = await expectReject(() => appointments.create(app, f.a.id, createInput({ clientAddressId: f.a.addressId })));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Adresa necesită un client sau un proiect/);
  });

  it("toate id-urile proprii → programarea se creează", async () => {
    const created = await appointments.create(
      app,
      f.a.id,
      createInput({
        clientId: f.a.clientId,
        clientAddressId: f.a.addressId,
        employeeId: f.a.employeeId,
        equipmentId: f.a.equipmentId,
        type: "revizie",
      }),
    );
    expect(created.tenantId).toBe(f.a.id);
    expect(created.status).toBe("scheduled");
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id } })).toBe(2);
  });

  it("programarea firmei B nu e vizibilă / modificabilă din A", async () => {
    const err = await expectReject(() =>
      appointments.update(app, f.a.id, f.b.appointmentId, { title: "HACKED" }),
    );
    expect(err.status).toBe(404);
    const b = await prisma.appointment.findUniqueOrThrow({ where: { id: f.b.appointmentId } });
    expect(b.title).toBe("Revizie fixture b");
  });

  it("ștergerea din A a programării lui B → 404, rândul lui B intact", async () => {
    const err = await expectReject(() => appointments.remove(app, f.a.id, f.b.appointmentId));
    expect(err.status).toBe(404);
    const b = await prisma.appointment.findUniqueOrThrow({ where: { id: f.b.appointmentId } });
    expect(b.deletedAt).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Idempotența finalizării
// ───────────────────────────────────────────────────────────────────────────

describe("finalize — idempotență pe Idempotency-Key", () => {
  const KEY = "idem-key-0001";

  it("aceeași cheie de două ori → un singur task, al doilea apel întoarce aceeași programare", async () => {
    const first = await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, KEY);
    expect(first.status).toBe("completed");
    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(1);

    const second = await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, KEY);
    expect(second.id).toBe(first.id);
    expect(second.completedAt?.getTime()).toBe(first.completedAt?.getTime());
    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(1);
  });

  it("cheia se păstrează în completionDataJson", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, KEY);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } });
    expect((row.completionDataJson as Record<string, unknown>)._idempotencyKey).toBe(KEY);
  });

  it("o CHEIE DIFERITĂ pe o programare deja finalizată → 409", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, KEY);
    const err = await expectReject(() =>
      appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, "alta-cheie"),
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/deja finalizată/);
    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(1);
  });

  it("fără nicio cheie, a doua finalizare → 409", async () => {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, null);
    const err = await expectReject(() =>
      appointments.finalize(app, f.a.id, f.a.appointmentId, revenire(), { kind: "all" }, null),
    );
    expect(err.status).toBe(409);
  });

  it("„programare nouă”: cheia repetată nu creează a doua programare", async () => {
    const input = finalizeAppointmentSchema.parse({
      outcome: "programare_noua",
      newAppointment: { title: "Revenire în 2 săptămâni", date: "2026-11-20T08:00:00.000Z", type: "revizie" },
    });
    await appointments.finalize(app, f.a.id, f.a.appointmentId, input, { kind: "all" }, KEY);
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id } })).toBe(2);

    await appointments.finalize(app, f.a.id, f.a.appointmentId, input, { kind: "all" }, KEY);
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id } })).toBe(2);
  });

  it("finalizarea din A pe programarea lui B → 404", async () => {
    const err = await expectReject(() =>
      appointments.finalize(app, f.a.id, f.b.appointmentId, revenire(), { kind: "all" }, KEY),
    );
    expect(err.status).toBe(404);
    const b = await prisma.appointment.findUniqueOrThrow({ where: { id: f.b.appointmentId } });
    expect(b.status).toBe("scheduled");
  });

  it("assignedUserId din firma B → 404 „Utilizatorul nu aparține firmei”", async () => {
    const input = finalizeAppointmentSchema.parse({
      outcome: "revenire",
      followup: { title: "x", assignedUserId: f.b.operator.id },
    });
    const err = await expectReject(() =>
      appointments.finalize(app, f.a.id, f.a.appointmentId, input, { kind: "all" }, KEY),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Utilizatorul nu aparține firmei/);
    expect(await prisma.task.count({ where: { tenantId: f.a.id } })).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Followup după finalizare
// ───────────────────────────────────────────────────────────────────────────

describe("followup — pe o programare finalizată", () => {
  const FKEY = "followup-key-0001";

  /** Finalizează fără cheie, ca urmările să plece de la o programare „completed”. */
  async function completeA() {
    await appointments.finalize(app, f.a.id, f.a.appointmentId, revenire("Revenire la finalizare"), { kind: "all" }, null);
    await prisma.task.deleteMany({ where: { tenantId: f.a.id } }); // pornim de la 0 taskuri
  }

  it("pe o programare NEfinalizată → 409", async () => {
    const err = await expectReject(() =>
      appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup(), { kind: "all" }, FKEY),
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/nu este finalizată/);
  });

  it("creează taskul și NU atinge starea programării", async () => {
    await completeA();
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } });

    await appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup(), { kind: "all" }, FKEY);

    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(1);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } });
    expect(after.status).toBe("completed");
    expect(after.completedAt?.getTime()).toBe(before.completedAt?.getTime());
  });

  it("aceeași cheie reluată → niciun al doilea task", async () => {
    await completeA();
    await appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup(), { kind: "all" }, FKEY);
    const replay = await appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup(), { kind: "all" }, FKEY);
    expect(replay.id).toBe(f.a.appointmentId);
    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(1);
  });

  it("3 apeluri CONCURENTE cu aceeași cheie → exact un task", async () => {
    await completeA();
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup(), { kind: "all" }, FKEY),
      ),
    );
    // Niciun apel nu trebuie să eșueze — idempotența nu e „primul câștigă, restul 409”.
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(1);

    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } });
    expect((row.completionDataJson as { _followupKeys?: string[] })._followupKeys).toEqual([FKEY]);
  });

  it("chei DIFERITE creează urmări diferite (nu e un plafon global)", async () => {
    await completeA();
    await appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup("A"), { kind: "all" }, "k1");
    await appointments.followup(app, f.a.id, f.a.appointmentId, revenireFollowup("B"), { kind: "all" }, "k2");
    expect(await prisma.task.count({ where: { tenantId: f.a.id, taskType: "followup" } })).toBe(2);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } });
    expect((row.completionDataJson as { _followupKeys?: string[] })._followupKeys).toEqual(["k1", "k2"]);
  });

  it("followup din A pe programarea lui B → 404", async () => {
    const err = await expectReject(() =>
      appointments.followup(app, f.a.id, f.b.appointmentId, revenireFollowup(), { kind: "all" }, FKEY),
    );
    expect(err.status).toBe(404);
  });

  it("„programare nouă” ca urmare: cheia reluată nu creează a doua programare", async () => {
    await completeA();
    const input = followupAppointmentSchema.parse({
      outcome: "programare_noua",
      newAppointment: { title: "Vizită suplimentară", date: "2026-12-01T08:00:00.000Z" },
    });
    await appointments.followup(app, f.a.id, f.a.appointmentId, input, { kind: "all" }, FKEY);
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id } })).toBe(2);
    await appointments.followup(app, f.a.id, f.a.appointmentId, input, { kind: "all" }, FKEY);
    expect(await prisma.appointment.count({ where: { tenantId: f.a.id } })).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tehnicianul implicit: o vizită creată din teren fără `employeeId` e a celui care o creează
// ───────────────────────────────────────────────────────────────────────────

describe("tehnicianul implicit la creare", () => {
  it("fără employeeId în body → programarea e repartizată pe angajatul celui care o creează", async () => {
    const created = await appointments.create(app, f.a.id, createInput({ clientId: f.a.clientId }), { defaultEmployeeId: f.a.employeeId });
    expect(created.employee?.id).toBe(f.a.employeeId);
  });

  it("employeeId explicit în body are prioritate; fără angajat legat rămâne nerepartizată", async () => {
    const colleague = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Coleg", lastName: "B" } });
    const explicit = await appointments.create(app, f.a.id, createInput({ clientId: f.a.clientId, employeeId: colleague.id }), { defaultEmployeeId: f.a.employeeId });
    expect(explicit.employee?.id).toBe(colleague.id);
    const unassigned = await appointments.create(app, f.a.id, createInput({ clientId: f.a.clientId }), { defaultEmployeeId: null });
    expect(unassigned.employee).toBeNull();
  });

  it("requesterEmployeeId: angajatul legat de contul cererii, în firma cererii", async () => {
    const { requesterEmployeeId } = await import("./scope.js");
    const asRequest = (sub: string, tenantId: string, client: "mobile" | "web" = "mobile") => ({ user: { sub, client }, tenantId }) as never;
    // Pe web câmpul gol înseamnă „nerepartizat”, deci nu se completează implicit.
    expect(await requesterEmployeeId(app, asRequest(f.a.operator.id, f.a.id, "web"))).toBeNull();
    expect(await requesterEmployeeId(app, asRequest(f.a.operator.id, f.a.id))).toBe(f.a.employeeId);
    expect(await requesterEmployeeId(app, asRequest(f.a.admin.id, f.a.id))).toBeNull();
    // Contul firmei A nu „devine” angajat în firma B.
    expect(await requesterEmployeeId(app, asRequest(f.a.operator.id, f.b.id))).toBeNull();
  });
});

describe("calendar — raportul analizorului deja atașat", () => {
  it("analyzerReportAttached: true când revizia legată are fișier sau există un document „Raport analizor”; altfel false", async () => {
    const from = new Date("2026-10-19T00:00:00.000Z");
    const to = new Date("2026-10-22T00:00:00.000Z");
    const before = await appointments.calendar(app, f.a.id, from, to);
    expect(before.find((a) => a.id === f.a.appointmentId)?.analyzerReportAttached).toBe(false);

    // Centrală: revizia legată de programare are PDF-ul analizorului.
    const rev = await prisma.equipmentRevision.create({
      data: { equipmentId: f.a.equipmentId, revisionDate: new Date("2026-10-20T09:00:00.000Z"), s3Key: "reports/x.pdf" },
      select: { id: true },
    });
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { equipmentRevisionId: rev.id } });

    // Instalație: raportul stă ca document pe programare.
    const inst = await prisma.appointment.create({
      data: { tenantId: f.a.id, clientId: f.a.clientId, installationId: f.a.installationId, type: "verificare_instalatie", title: "Verificare", date: new Date("2026-10-21T09:00:00.000Z"), duration: 60 },
      select: { id: true },
    });
    await prisma.document.create({ data: { tenantId: f.a.id, name: "Raport analizor (PDF) — Seitron", status: "COMPLETED", s3Key: "reports/y.pdf", appointmentId: inst.id } });

    const after = await appointments.calendar(app, f.a.id, from, to);
    expect(after.find((a) => a.id === f.a.appointmentId)?.analyzerReportAttached).toBe(true);
    expect(after.find((a) => a.id === inst.id)?.analyzerReportAttached).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Modificare completă + audit + istoric (runda 3 din teren)
// ───────────────────────────────────────────────────────────────────────────

const upd = (input: unknown) => updateAppointmentSchema.parse(input);
const auditRows = (id: string) =>
  prisma.auditLog.findMany({ where: { entityType: "appointment", entityId: id }, orderBy: { createdAt: "asc" } });

describe("update — tip și adresă", () => {
  it("tipul și adresa clientului se pot schimba cât programarea e deschisă", async () => {
    const updated = await appointments.update(app, f.a.id, f.a.appointmentId, upd({ type: "verificare_instalatie", clientAddressId: f.a.addressId }), { kind: "all" }, f.a.admin.id);
    expect(updated.type).toBe("verificare_instalatie");
    expect(updated.clientAddressId).toBe(f.a.addressId);
  });

  it("adresa altui client → 400, programarea rămâne neatinsă", async () => {
    const err = await expectReject(() => appointments.update(app, f.a.id, f.a.appointmentId, upd({ clientAddressId: f.b.addressId }), { kind: "all" }, f.a.admin.id));
    expect(err.status).toBe(400);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: f.a.appointmentId } });
    expect(row.clientAddressId).toBe(f.a.addressId);
  });

  it("tipul NU se mai schimbă după finalizare → 400", async () => {
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { status: "completed" } });
    const err = await expectReject(() => appointments.update(app, f.a.id, f.a.appointmentId, upd({ type: "general" }), { kind: "all" }, f.a.admin.id));
    expect(err.status).toBe(400);
  });
});

describe("audit — cine, ce, când", () => {
  it("update pe titlu → acțiunea „update”, doar câmpul schimbat în before/after, cu actorul", async () => {
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ title: "Titlu nou", notes: "n" }), { kind: "all" }, f.a.admin.id);
    const [row] = await auditRows(f.a.appointmentId);
    expect(row.action).toBe("update");
    expect(row.actorUserId).toBe(f.a.admin.id);
    expect(row.beforeJson).toEqual({ title: "Revizie fixture a", notes: null });
    expect(row.afterJson).toEqual({ title: "Titlu nou", notes: "n" });
  });

  it("data/durata → „reschedule”; doar tehnicianul → „assign”; status anulat → „cancel”", async () => {
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ date: "2026-10-21T10:00:00.000Z" }), { kind: "all" }, f.a.admin.id);
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ employeeId: null }), { kind: "all" }, f.a.admin.id);
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ status: "cancelled", cancelReason: "Clientul a amânat" }), { kind: "all" }, f.a.operator.id);
    const rows = await auditRows(f.a.appointmentId);
    expect(rows.map((r) => r.action)).toEqual(["reschedule", "assign", "cancel"]);
    expect(rows[0].beforeJson).toEqual({ date: "2026-10-20T09:00:00.000Z" });
    expect(rows[0].afterJson).toEqual({ date: "2026-10-21T10:00:00.000Z" });
    expect(rows[1].beforeJson).toEqual({ employeeId: f.a.employeeId });
    expect(rows[1].afterJson).toEqual({ employeeId: null });
    expect(rows[2].actorUserId).toBe(f.a.operator.id);
  });

  it("o modificare fără nicio schimbare reală nu scrie audit", async () => {
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ title: "Revizie fixture a" }), { kind: "all" }, f.a.admin.id);
    expect(await auditRows(f.a.appointmentId)).toHaveLength(0);
  });

  it("arhivare → „delete”, restaurare → „restore”", async () => {
    await appointments.remove(app, f.a.id, f.a.appointmentId, { kind: "all" }, f.a.admin.id);
    await appointments.restore(app, f.a.id, f.a.appointmentId, f.a.admin.id);
    const rows = await auditRows(f.a.appointmentId);
    expect(rows.map((r) => r.action)).toEqual(["delete", "restore"]);
  });

  it("crearea și finalizarea scriu „create” / „finalize”", async () => {
    const created = await appointments.create(app, f.a.id, createInput({ clientId: f.a.clientId }), {}, f.a.admin.id);
    await appointments.finalize(app, f.a.id, created.id, revenire(), { kind: "all" }, null, f.a.operator.id);
    const rows = await auditRows(created.id);
    expect(rows.map((r) => r.action)).toEqual(["create", "finalize"]);
    expect(rows[1].actorUserId).toBe(f.a.operator.id);
    expect(rows[1].afterJson).toMatchObject({ status: "completed" });
  });
});

describe("istoricul modificărilor (GET /:id/history)", () => {
  it("cele mai noi primele, cu actorul; scope „own” pe programarea altui tehnician → 404", async () => {
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ title: "Unu" }), { kind: "all" }, f.a.admin.id);
    await appointments.update(app, f.a.id, f.a.appointmentId, upd({ date: "2026-10-22T10:00:00.000Z" }), { kind: "all" }, f.a.operator.id);

    const { data } = await appointments.history(app, f.a.id, f.a.appointmentId, { kind: "all" });
    expect(data.map((h) => h.action)).toEqual(["reschedule", "update"]);
    expect(data[0].actor).toEqual({ id: f.a.operator.id, firstName: expect.any(String), lastName: expect.any(String) });
    expect(typeof data[0].createdAt).toBe("string");

    // Propriul tehnician o vede; un alt angajat (cont fără programări pe ea) nu.
    const own = await appointments.history(app, f.a.id, f.a.appointmentId, { kind: "own", employeeId: f.a.employeeId });
    expect(own.data).toHaveLength(2);
    const other = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Alt", lastName: "Coleg", position: "instalator" } });
    const err = await expectReject(() => appointments.history(app, f.a.id, f.a.appointmentId, { kind: "own", employeeId: other.id }));
    expect(err.status).toBe(404);
    // Din firma B nu există.
    const errB = await expectReject(() => appointments.history(app, f.b.id, f.a.appointmentId, { kind: "all" }));
    expect(errB.status).toBe(404);
  });
});

describe("calendar — anulatele rămân vizibile", () => {
  it("o programare anulată apare în calendar (estompată în UI), cele arhivate nu", async () => {
    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { status: "cancelled" } });
    const from = new Date("2026-10-19T00:00:00.000Z");
    const to = new Date("2026-10-22T00:00:00.000Z");
    const list = await appointments.calendar(app, f.a.id, from, to);
    expect(list.find((a) => a.id === f.a.appointmentId)?.status).toBe("cancelled");

    await prisma.appointment.update({ where: { id: f.a.appointmentId }, data: { deletedAt: new Date() } });
    const after = await appointments.calendar(app, f.a.id, from, to);
    expect(after.find((a) => a.id === f.a.appointmentId)).toBeUndefined();
  });
});


describe("anularea cere un motiv", () => {
  it("fără motiv → 400; cu motiv → se salvează pe programare și intră în istoric", async () => {
    const err = await expectReject(() => appointments.update(app, f.a.id, f.a.appointmentId, upd({ status: "cancelled" }), { kind: "all" }, f.a.operator.id));
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Motivul anulării/);

    const updated = await appointments.update(app, f.a.id, f.a.appointmentId, upd({ status: "cancelled", cancelReason: "Nu a fost nimeni acasă" }), { kind: "all" }, f.a.operator.id);
    expect(updated.status).toBe("cancelled");
    expect(updated.cancelReason).toBe("Nu a fost nimeni acasă");
    expect(updated.cancelledAt).toBeInstanceOf(Date);

    const { data: rows } = await appointments.history(app, f.a.id, f.a.appointmentId);
    const cancel = rows.find((r) => r.action === "cancel");
    expect(cancel?.after).toMatchObject({ status: "cancelled", cancelReason: "Nu a fost nimeni acasă" });
  });
});
