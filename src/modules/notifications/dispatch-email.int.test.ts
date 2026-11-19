import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";

const sent: { url?: string }[] = [];
vi.mock("../../lib/email.js", () => ({ sendNotificationEmail: vi.fn(async (o: { url?: string }) => void sent.push(o)) }));
vi.mock("../../lib/web-push.js", () => ({ sendWebPush: vi.fn(async () => ({ ok: true })), isWebPushConfigured: () => false }));
vi.mock("../../lib/expo-push.js", () => ({ sendExpoPush: vi.fn(async () => ({ ok: [], invalid: [] })), isValidExpoToken: () => true }));

import { dispatch } from "./dispatch.js";
import { env } from "../../config/env.js";

/** „Deschide în Operio” din e-mail: link complet, pe adresa firmei dacă o are (acolo e sesiunea). */
let f: TwoTenants;
beforeEach(async () => {
  f = await seedTwoTenants();
  sent.length = 0;
  await prisma.user.update({ where: { id: f.a.admin.id }, data: { emailVerifiedAt: new Date() } });
});
afterAll(async () => prisma.$disconnect());

const ev = (url: string) => ({ userId: f.a.admin.id, category: "tasks" as const, subject: "Termen depășit", body: "x", url });

describe("linkul din e-mailurile de notificare", () => {
  it("fără adresă proprie: link complet spre aplicație; „/dashboard” duce la panou", async () => {
    await dispatch(prisma, f.a.id, ev("/projects/p1"));
    await dispatch(prisma, f.a.id, ev("/dashboard"));
    const base = env.FRONTEND_URL.replace(/\/$/, "");
    expect(sent.map((s) => s.url)).toEqual([`${base}/projects/p1`, `${base}/`]);
  });

  it("firma cu adresă proprie: linkul duce acolo", async () => {
    await prisma.tenant.update({ where: { id: f.a.id }, data: { subdomain: "firmaa" } });
    await dispatch(prisma, f.a.id, ev("/calendar"));
    expect(sent[0].url).toBe(env.TENANT_BASE_DOMAIN ? `https://firmaa.${env.TENANT_BASE_DOMAIN}/calendar` : `${env.FRONTEND_URL.replace(/\/$/, "")}/calendar`);
  });
});
