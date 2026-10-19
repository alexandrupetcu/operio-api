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
