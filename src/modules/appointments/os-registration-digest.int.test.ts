import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";

// Fără SMTP / push în suită: canalele externe nu trebuie să plece nicăieri.
vi.mock("../../lib/email.js", () => ({ sendNotificationEmail: vi.fn(async () => {}) }));
vi.mock("../../lib/web-push.js", () => ({ sendWebPush: vi.fn(async () => ({ ok: true })), isWebPushConfigured: () => false }));
vi.mock("../../lib/expo-push.js", () => ({ sendExpoPush: vi.fn(async () => ({ ok: [], invalid: [] })), isValidExpoToken: () => true }));

import { sendOsRegistrationDigest } from "./os-registration.js";

let f: TwoTenants;
let managerA: { id: string };

/** Luni 19.10.2026, 07:00 — rularea de dimineață a scanerului. */
const NOW = new Date(2026, 9, 19, 7, 0);

async function finishedVisit(tenantId: string, clientId: string, addressId: string, completedAt: Date, over: Record<string, unknown> = {}) {
  return prisma.appointment.create({
    data: {
      tenantId,
      clientId,
      clientAddressId: addressId,
      type: "revizie_instalatie",
      title: "Revizie instalație",
      date: completedAt,
      duration: 60,
      status: "completed",
      completedAt,
      ...over,
    },
  });
}

beforeEach(async () => {
  f = await seedTwoTenants();
  managerA = await prisma.user.create({
    data: {
      tenantId: f.a.id,
      email: "manager.a@fixture.test",
      passwordHash: "x",
      firstName: "Manager",
      lastName: "A",
      role: "MANAGER",
    },
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});

const notifsFor = (userId: string) => prisma.notification.findMany({ where: { userId, dedupeKey: { startsWith: "due:os:" } } });

describe("notificarea zilnică pentru fișele de înregistrat la OS", () => {
  it("o fișă cu termenul depășit → un rezumat către admin și manager, nu și către tehnician", async () => {
    // Finalizată luni 12.10 → termen (5 zile lucrătoare) luni 19.10; cu una și mai veche, depășită.
    await finishedVisit(f.a.id, f.a.clientId, f.a.addressId, new Date(2026, 9, 5, 10));

    const sent = await sendOsRegistrationDigest(prisma, f.a.id, NOW);
    expect(sent).toBe(2);

    const [adminNotif] = await notifsFor(f.a.admin.id);
    expect(adminNotif.subject).toMatch(/1 fișă de înregistrat la OS/);
    expect(adminNotif.body).toMatch(/depășit/);
    expect(await notifsFor(managerA.id)).not.toHaveLength(0);
    expect(await notifsFor(f.a.operator.id)).toHaveLength(0);
  });

  it("a doua rulare din aceeași zi (13:00) nu mai trimite nimic", async () => {
    await finishedVisit(f.a.id, f.a.clientId, f.a.addressId, new Date(2026, 9, 5, 10));
    await sendOsRegistrationDigest(prisma, f.a.id, NOW);
    // `dispatch` scrie câte un rând pe canal (in-app, e-mail, push) — numărul nu trebuie să crească.
    const before = (await notifsFor(f.a.admin.id)).length;
    expect(before).toBeGreaterThan(0);
    expect(await sendOsRegistrationDigest(prisma, f.a.id, new Date(2026, 9, 19, 13, 0))).toBe(0);
    expect(await notifsFor(f.a.admin.id)).toHaveLength(before);
  });

  it("o fișă departe de termen (peste pragul urgent) nu intră în notificare", async () => {
    // Finalizată azi → termen peste 5 zile lucrătoare; pragul implicit e 2 zile.
    await finishedVisit(f.a.id, f.a.clientId, f.a.addressId, new Date(2026, 9, 19, 6));
    expect(await sendOsRegistrationDigest(prisma, f.a.id, NOW)).toBe(0);
  });

  it("fișele deja înregistrate sau ale altei firme nu contează", async () => {
    await finishedVisit(f.a.id, f.a.clientId, f.a.addressId, new Date(2026, 9, 5, 10), { osRegistrationNumber: "123" });
    await finishedVisit(f.b.id, f.b.clientId, f.b.addressId, new Date(2026, 9, 5, 10));
    expect(await sendOsRegistrationDigest(prisma, f.a.id, NOW)).toBe(0);
  });

  it("comutatorul firmei oprit (Setări → Notificări) → nimic", async () => {
    await finishedVisit(f.a.id, f.a.clientId, f.a.addressId, new Date(2026, 9, 5, 10));
    await prisma.tenant.update({ where: { id: f.a.id }, data: { settingsJson: { notifications: { os_registration_due: false } } } });
    expect(await sendOsRegistrationDigest(prisma, f.a.id, NOW)).toBe(0);
  });

  it("termenul firmei (zile lucrătoare) mutat la 10 → aceeași fișă nu mai e urgentă", async () => {
    // Finalizată luni 12.10: cu 5 zile termenul e azi (urgent), cu 10 e 26.10.
    await finishedVisit(f.a.id, f.a.clientId, f.a.addressId, new Date(2026, 9, 12, 10));
    await prisma.tenant.update({
      where: { id: f.a.id },
      data: { settingsJson: { alertWindows: { osRegistrationWorkingDays: 10 } } },
    });
    expect(await sendOsRegistrationDigest(prisma, f.a.id, NOW)).toBe(0);

    await prisma.tenant.update({ where: { id: f.a.id }, data: { settingsJson: {} } });
    expect(await sendOsRegistrationDigest(prisma, f.a.id, NOW)).toBe(2);
  });
});
