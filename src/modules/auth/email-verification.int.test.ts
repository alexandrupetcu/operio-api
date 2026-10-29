import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { hashPassword } from "../../lib/hash.js";

// E-mailurile sunt prinse aici în loc să plece prin SMTP.
const mail = vi.hoisted(() => ({
  verify: [] as { to: string; url: string }[],
  invites: [] as { to: string; url: string }[],
  resets: [] as { to: string; url: string }[],
  notifications: [] as { to: string; subject: string }[],
  codes: [] as { to: string; code: string }[],
}));
vi.mock("../../lib/email.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/email.js")>()),
  sendEmailVerificationEmail: vi.fn(async (o: { to: string; verifyUrl: string }) => {
    mail.verify.push({ to: o.to, url: o.verifyUrl });
  }),
  sendUserInviteEmail: vi.fn(async (o: { to: string; setPasswordUrl: string }) => {
    mail.invites.push({ to: o.to, url: o.setPasswordUrl });
    return true;
  }),
  sendPasswordResetEmail: vi.fn(async (o: { to: string; resetUrl: string }) => {
    mail.resets.push({ to: o.to, url: o.resetUrl });
  }),
  sendNotificationEmail: vi.fn(async (o: { to: string; subject: string }) => {
    mail.notifications.push({ to: o.to, subject: o.subject });
  }),
  sendTwoFactorCodeEmail: vi.fn(async (o: { to: string; code: string }) => {
    mail.codes.push({ to: o.to, code: o.code });
  }),
  sendTwoFactorChangedEmail: vi.fn(async () => {}),
}));
vi.mock("../../lib/web-push.js", () => ({ sendWebPush: vi.fn(async () => ({ ok: true })), isWebPushConfigured: () => false }));
vi.mock("../../lib/expo-push.js", () => ({ sendExpoPush: vi.fn(async () => ({ ok: [], invalid: [] })), isValidExpoToken: () => true }));

import { forgotPassword, login, me, register, resetPassword } from "./auth.service.js";
import { resendEmailVerification, verifyEmail } from "./email-verification.service.js";
import * as users from "../users/users.service.js";
import * as tf from "./two-factor.service.js";
import { dispatch } from "../notifications/dispatch.js";

const PASSWORD = "Parola-Test-1";
let app: FastifyInstance;
let f: TwoTenants;

beforeEach(async () => {
  app = await serviceStub();
  (app as unknown as { jwt: { sign: (p: object) => string } }).jwt = { sign: (p: object) => `jwt:${JSON.stringify(p)}` };
  f = await seedTwoTenants();
  for (const list of Object.values(mail)) list.length = 0;
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const signUp = (email = "nou@firma-noua.test") =>
  register(app, { tenantName: "Firma Nouă SRL", email, password: PASSWORD, firstName: "Ana", lastName: "Pop" });
const tokenFrom = (url: string) => new URL(url).searchParams.get("token")!;
const lastVerifyToken = () => tokenFrom(mail.verify[mail.verify.length - 1]!.url);
const verifiedAt = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt;

describe("înregistrarea publică", () => {
  it("contul nou e neconfirmat și primește linkul de confirmare pe e-mail", async () => {
    const res = await signUp();
    expect(res.user.emailVerified).toBe(false);
    expect(await verifiedAt(res.user.id)).toBeNull();
    expect(mail.verify).toHaveLength(1);
    expect(mail.verify[0]!.to).toBe("nou@firma-noua.test");
    expect(mail.verify[0]!.url).toMatch(/\/verify-email\?token=[a-f0-9]{64}$/);
    // Tokenul e stocat doar hash-uit.
    const stored = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId: res.user.id } });
    expect(stored.tokenHash).not.toBe(lastVerifyToken());
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);

    const meRes = await me(app, res.user.id);
    expect(meRes.user.emailVerified).toBe(false);
  });

  it("utilizatorii din fixtură (conturile existente) sunt confirmați", async () => {
    expect(await verifiedAt(f.a.admin.id)).not.toBeNull();
    expect((await me(app, f.a.admin.id)).user.emailVerified).toBe(true);
    await prisma.user.update({ where: { id: f.a.admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const res = (await login(app, { email: f.a.admin.email, password: PASSWORD, client: "web" })) as { user: { emailVerified: boolean } };
    expect(res.user.emailVerified).toBe(true);
  });
});

describe("confirmarea", () => {
  it("linkul confirmă adresa o singură dată; a doua folosire e un „ok” prietenos", async () => {
    const res = await signUp();
    const token = lastVerifyToken();
    const first = await verifyEmail(app, token);
    expect(first).toEqual({ verified: true, alreadyVerified: false });
    const at = await verifiedAt(res.user.id);
    expect(at).not.toBeNull();
    expect((await me(app, res.user.id)).user.emailVerified).toBe(true);

    const again = await verifyEmail(app, token);
    expect(again).toEqual({ verified: true, alreadyVerified: true });
    // Data confirmării nu se mută.
    expect((await verifiedAt(res.user.id))?.getTime()).toBe(at!.getTime());
  });

  it("tokenul expirat sau necunoscut e respins cu 400", async () => {
    const res = await signUp();
    const token = lastVerifyToken();
    await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await expectReject(() => verifyEmail(app, token));
    expect(expired.status).toBe(400);
    expect(expired.message).toBe("Linkul de confirmare a expirat sau nu mai e valabil. Cere unul nou din aplicație.");
    expect(await verifiedAt(res.user.id)).toBeNull();
    expect((await expectReject(() => verifyEmail(app, "0".repeat(64)))).status).toBe(400);
  });

  it("retrimiterea invalidează linkul vechi; pentru un cont confirmat nu face nimic", async () => {
    const res = await signUp();
    const old = lastVerifyToken();
    expect(await resendEmailVerification(app, res.user.id)).toEqual({ sent: true, alreadyVerified: false });
    expect(mail.verify).toHaveLength(2);
    const fresh = lastVerifyToken();
    expect(fresh).not.toBe(old);
    expect((await expectReject(() => verifyEmail(app, old))).status).toBe(400);
    await verifyEmail(app, fresh);
    expect(await verifiedAt(res.user.id)).not.toBeNull();

    expect(await resendEmailVerification(app, res.user.id)).toEqual({ sent: false, alreadyVerified: true });
    expect(mail.verify).toHaveLength(2);
  });
});

describe("parola setată din e-mail dovedește adresa", () => {
  it("invitația: setarea parolei marchează adresa confirmată", async () => {
    const created = await users.create(app, f.a.id, { email: "coleg@firma-a.test", firstName: "Coleg", lastName: "Nou", role: "OPERATOR" }, f.a.admin.id);
    expect(await verifiedAt(created.id)).toBeNull();
    expect(mail.invites).toHaveLength(1);
    await resetPassword(app, { token: tokenFrom(mail.invites[0]!.url), newPassword: PASSWORD });
    expect(await verifiedAt(created.id)).not.toBeNull();
  });

  it("resetarea parolei prin link marchează adresa confirmată", async () => {
    const res = await signUp();
    await forgotPassword(app, { email: "nou@firma-noua.test" });
    expect(mail.resets).toHaveLength(1);
    await resetPassword(app, { token: tokenFrom(mail.resets[0]!.url), newPassword: "Parola-Noua-2" });
    expect(await verifiedAt(res.user.id)).not.toBeNull();
  });
});

describe("restricții până la confirmare", () => {
  const forbiddenMsg = "Confirmă-ți adresa de e-mail înainte să inviți colegi.";

  it("adminul neconfirmat nu poate crea sau invita colegi; cel confirmat poate", async () => {
    const res = await signUp();
    const tenantId = res.tenant.id;
    const err = await expectReject(() =>
      users.create(app, tenantId, { email: "coleg@firma-noua.test", firstName: "C", lastName: "N", role: "OPERATOR" }, res.user.id),
    );
    expect(err.status).toBe(403);
    expect(err.message).toBe(forbiddenMsg);
    expect(await prisma.user.count({ where: { email: "coleg@firma-noua.test" } })).toBe(0);
    // Nici cu parolă dată direct (fără invitație).
    expect(
      (await expectReject(() =>
        users.create(app, tenantId, { email: "coleg@firma-noua.test", firstName: "C", lastName: "N", role: "OPERATOR", password: PASSWORD }, res.user.id),
      )).status,
    ).toBe(403);

    // Retrimiterea invitației, la fel.
    const other = await prisma.user.create({
      data: { tenantId, email: "altul@firma-noua.test", passwordHash: "x", firstName: "A", lastName: "B", role: "OPERATOR" },
    });
    expect((await expectReject(() => users.sendInvite(app, tenantId, other.id, res.user.id))).status).toBe(403);

    await verifyEmail(app, lastVerifyToken());
    const ok = await users.create(app, tenantId, { email: "coleg@firma-noua.test", firstName: "C", lastName: "N", role: "OPERATOR" }, res.user.id);
    expect(ok.inviteSent).toBe(true);
    expect(await users.sendInvite(app, tenantId, other.id, res.user.id)).toBe(true);
  });

  it("notificările pe e-mail sar peste destinatarul neconfirmat (în aplicație rămân)", async () => {
    await prisma.user.update({ where: { id: f.a.operator.id }, data: { emailVerifiedAt: null } });
    await dispatch(prisma, f.a.id, { userId: f.a.operator.id, category: "system", subject: "Test", body: "Corp" });
    expect(mail.notifications).toHaveLength(0);
    expect(await prisma.notification.count({ where: { userId: f.a.operator.id, channel: "in_app" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: f.a.operator.id, channel: "email" } })).toBe(0);

    await dispatch(prisma, f.a.id, { userId: f.a.admin.id, category: "system", subject: "Test", body: "Corp" });
    expect(mail.notifications).toEqual([{ to: f.a.admin.email, subject: "Test" }]);
  });

  it("2FA pe e-mail cere adresa confirmată; TOTP merge", async () => {
    const res = await signUp();
    const err = await expectReject(() => tf.setup(app, res.user.id, "email"));
    expect(err.status).toBe(400);
    expect(err.message).toBe("Confirmă-ți adresa de e-mail ca să primești codurile pe e-mail.");
    expect(mail.codes).toHaveLength(0);
    const totp = await tf.setup(app, res.user.id, "totp");
    expect(totp.method).toBe("totp");

    await verifyEmail(app, lastVerifyToken());
    const email = await tf.setup(app, res.user.id, "email");
    expect(email.method).toBe("email");
    expect(mail.codes).toHaveLength(1);
  });
});
