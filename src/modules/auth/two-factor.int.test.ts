import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { hashPassword } from "../../lib/hash.js";
import { totpCode } from "../../lib/totp.js";
import { env } from "../../config/env.js";
import { login, resetPassword } from "./auth.service.js";
import * as tf from "./two-factor.service.js";

// Codurile trimise pe e-mail sunt prinse aici în loc să plece prin SMTP.
const mail = vi.hoisted(() => ({
  codes: [] as { to: string; code: string }[],
  changes: [] as { to: string; event: string }[],
}));
vi.mock("../../lib/email.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/email.js")>()),
  sendTwoFactorCodeEmail: vi.fn(async (o: { to: string; code: string }) => {
    mail.codes.push({ to: o.to, code: o.code });
  }),
  sendTwoFactorChangedEmail: vi.fn(async (o: { to: string; event: string }) => {
    mail.changes.push({ to: o.to, event: o.event });
  }),
}));

const PASSWORD = "Parola-Test-1";
let app: FastifyInstance;
let f: TwoTenants;
let email: string;

beforeEach(async () => {
  app = await serviceStub();
  (app as unknown as { jwt: { sign: (p: object) => string } }).jwt = { sign: (p: object) => `jwt:${JSON.stringify(p)}` };
  f = await seedTwoTenants();
  email = f.a.admin.email;
  await prisma.user.update({ where: { id: f.a.admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  mail.codes.length = 0;
  mail.changes.length = 0;
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

const webLogin = (extra: { trustedDevice?: string } = {}) =>
  login(app, { email, password: PASSWORD, client: "web", ...extra }) as Promise<Record<string, unknown>>;
const lastCode = () => mail.codes[mail.codes.length - 1]!.code;

/** Activează TOTP prin fluxul real (setup → cod din „aplicație” → enable); întoarce secretul și codurile de rezervă. */
async function enableTotp(userId = f.a.admin.id) {
  const s = await tf.setup(app, userId, "totp");
  if (s.method !== "totp") throw new Error("expected totp");
  const { backupCodes } = await tf.enable(app, userId, { password: PASSWORD, code: await totpCode(s.secret) });
  // Codul de mai sus a consumat pasul curent — testele următoare pot folosi din nou codul curent.
  await prisma.user.update({ where: { id: userId }, data: { twoFactorLastStep: null } });
  return { secret: s.secret, backupCodes };
}

async function enableEmail(userId = f.a.admin.id) {
  await tf.setup(app, userId, "email");
  return tf.enable(app, userId, { password: PASSWORD, code: lastCode() });
}

async function ticketFor() {
  const res = await webLogin();
  expect(res.twoFactorRequired).toBe(true);
  return res as { twoFactorRequired: true; ticket: string; method: string; emailHint: string };
}

describe("login fără 2FA", () => {
  it("rămâne neschimbat: tokenuri direct", async () => {
    const res = await webLogin();
    expect(res.accessToken).toBeTruthy();
    expect(res.twoFactorRequired).toBeUndefined();
  });
});

describe("activarea", () => {
  it("TOTP: QR + secret, confirmarea cere parola și un cod valid, apoi 10 coduri de rezervă", async () => {
    const s = await tf.setup(app, f.a.admin.id, "totp");
    if (s.method !== "totp") throw new Error("expected totp");
    expect(s.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(s.otpauthUrl).toContain("issuer=Operio");
    const code = await totpCode(s.secret);
    expect((await expectReject(() => tf.enable(app, f.a.admin.id, { password: "gresit", code }))).status).toBe(400);
    expect((await expectReject(() => tf.enable(app, f.a.admin.id, { password: PASSWORD, code: "000000" }))).status).toBe(400);
    const { backupCodes } = await tf.enable(app, f.a.admin.id, { password: PASSWORD, code });
    expect(backupCodes).toHaveLength(10);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } });
    expect(user.twoFactorMethod).toBe("totp");
    expect(user.twoFactorSecret).toMatch(/^v1:/);
    expect(user.twoFactorSecret).not.toContain(s.secret);
    expect(mail.changes).toEqual([{ to: email, event: "enabled" }]);
    expect(await prisma.auditLog.count({ where: { tenantId: f.a.id, action: "2fa.enable" } })).toBe(1);
  });

  it("închide celelalte sesiuni web, dar o păstrează pe cea curentă și pe cele mobile", async () => {
    const mk = (raw: string, client = "web") =>
      prisma.refreshToken.create({
        data: { userId: f.a.admin.id, token: createHash("sha256").update(raw).digest("hex"), client, expiresAt: new Date(Date.now() + 3600_000) },
      });
    await mk("current");
    await mk("other");
    await mk("phone", "mobile");
    const s = await tf.setup(app, f.a.admin.id, "totp");
    if (s.method !== "totp") throw new Error("expected totp");
    await tf.enable(app, f.a.admin.id, { password: PASSWORD, code: await totpCode(s.secret), refreshToken: "current" });
    const left = await prisma.refreshToken.findMany({ where: { userId: f.a.admin.id }, select: { client: true, token: true } });
    expect(left.map((t) => t.client).sort()).toEqual(["mobile", "web"]);
    expect(left.some((t) => t.token === createHash("sha256").update("current").digest("hex"))).toBe(true);
  });

  it("fără TWO_FACTOR_KEY, TOTP întoarce 503; e-mailul merge în continuare", async () => {
    const saved = env.TWO_FACTOR_KEY;
    env.TWO_FACTOR_KEY = undefined;
    try {
      const err = await expectReject(() => tf.setup(app, f.a.admin.id, "totp"));
      expect(err.status).toBe(503);
      expect(err.message).toMatch(/aplicația de autentificare/i);
      await enableEmail();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } })).twoFactorMethod).toBe("email");
    } finally {
      env.TWO_FACTOR_KEY = saved;
    }
  });

  it("e-mail: codul ajunge pe adresa contului; un cont deja protejat nu poate porni alt setup", async () => {
    await tf.setup(app, f.a.admin.id, "email");
    expect(mail.codes).toHaveLength(1);
    expect(mail.codes[0]!.to).toBe(email);
    await tf.enable(app, f.a.admin.id, { password: PASSWORD, code: lastCode() });
    expect((await expectReject(() => tf.setup(app, f.a.admin.id, "totp"))).status).toBe(409);
  });
});

describe("login cu TOTP", () => {
  it("parola corectă → tichet (fără tokenuri); codul corect → tokenuri", async () => {
    const { secret } = await enableTotp();
    const t = await ticketFor();
    expect(t.method).toBe("totp");
    expect(t.emailHint).toBe("a***@fixture.test");
    expect((t as Record<string, unknown>).accessToken).toBeUndefined();
    expect(await prisma.refreshToken.count({ where: { userId: f.a.admin.id } })).toBe(0);

    const res = await tf.verifyLogin(app, { ticket: t.ticket, code: await totpCode(secret) });
    expect(res.accessToken).toBeTruthy();
    expect(res.refreshToken).toBeTruthy();
    expect(res.user.id).toBe(f.a.admin.id);
    expect(res.trustedDeviceToken).toBeUndefined();
    // Tichetul e de unică folosință.
    expect((await expectReject(() => tf.verifyLogin(app, { ticket: t.ticket, code: "123456" }))).status).toBe(401);
  });

  it("același cod TOTP nu poate fi folosit de două ori", async () => {
    const { secret } = await enableTotp();
    const code = await totpCode(secret);
    await tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code });
    expect((await expectReject(async () => tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code }))).status).toBe(401);
  });

  it("5 coduri greșite omoară tichetul — nici codul corect nu mai trece", async () => {
    const { secret } = await enableTotp();
    const { ticket } = await ticketFor();
    for (let i = 0; i < 5; i++) {
      expect((await expectReject(() => tf.verifyLogin(app, { ticket, code: "000000" }))).status).toBe(401);
    }
    const err = await expectReject(async () => tf.verifyLogin(app, { ticket, code: await totpCode(secret) }));
    expect(err.status).toBe(401);
  });

  it("tichetul expiră după 10 minute", async () => {
    const { secret } = await enableTotp();
    const { ticket } = await ticketFor();
    await prisma.twoFactorChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expectReject(async () => tf.verifyLogin(app, { ticket, code: await totpCode(secret) }))).status).toBe(401);
  });

  it("codul de rezervă merge o singură dată", async () => {
    const { backupCodes } = await enableTotp();
    const code = backupCodes[0]!.toUpperCase();
    const res = await tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code });
    expect(res.accessToken).toBeTruthy();
    expect((await expectReject(async () => tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code }))).status).toBe(401);
    expect((await tf.status(app, f.a.admin.id)).backupCodesRemaining).toBe(9);
  });

  it("login-ul mobil nu cere al doilea pas", async () => {
    await enableTotp();
    await prisma.user.update({ where: { id: f.a.admin.id }, data: { mobileAccess: true } });
    const res = (await login(app, {
      email,
      password: PASSWORD,
      client: "mobile",
      device: { deviceId: "device-12345678", platform: "android" },
    })) as Record<string, unknown>;
    expect(res.accessToken).toBeTruthy();
    expect(res.twoFactorRequired).toBeUndefined();
  });

  it("resetarea parolei nu dezactivează 2FA", async () => {
    await enableTotp();
    const raw = "r".repeat(64);
    await prisma.passwordResetToken.create({
      data: { userId: f.a.admin.id, tokenHash: createHash("sha256").update(raw).digest("hex"), expiresAt: new Date(Date.now() + 3600_000) },
    });
    await resetPassword(app, { token: raw, newPassword: PASSWORD });
    expect((await webLogin()).twoFactorRequired).toBe(true);
  });
});

describe("dispozitiv ținut minte", () => {
  it("sare pasul doi 30 de zile; expirat sau al altui cont, nu", async () => {
    const { secret } = await enableTotp();
    const res = await tf.verifyLogin(
      app,
      { ticket: (await ticketFor()).ticket, code: await totpCode(secret), rememberDevice: true },
      { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
    );
    const token = res.trustedDeviceToken!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const devices = await tf.listTrustedDevices(app, f.a.admin.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.label).toBe("Chrome pe macOS");
    const days = (devices[0]!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    expect((await webLogin({ trustedDevice: token })).accessToken).toBeTruthy();
    expect((await webLogin({ trustedDevice: "f".repeat(64) })).twoFactorRequired).toBe(true);

    await prisma.trustedDevice.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await webLogin({ trustedDevice: token })).twoFactorRequired).toBe(true);
  });

  it("„Uită” scoate dispozitivul — doar pe al tău", async () => {
    const { secret } = await enableTotp();
    const res = await tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code: await totpCode(secret), rememberDevice: true });
    const [device] = await tf.listTrustedDevices(app, f.a.admin.id);
    expect((await expectReject(() => tf.forgetTrustedDevice(app, f.b.admin.id, device!.id))).status).toBe(404);
    await tf.forgetTrustedDevice(app, f.a.admin.id, device!.id);
    expect((await webLogin({ trustedDevice: res.trustedDeviceToken })).twoFactorRequired).toBe(true);
  });
});

describe("login cu cod pe e-mail", () => {
  it("trimite codul; codul corect dă tokenuri; expiră după 10 minute", async () => {
    await enableEmail();
    mail.codes.length = 0;
    const t = await ticketFor();
    expect(t.method).toBe("email");
    expect(mail.codes).toHaveLength(1);
    const res = await tf.verifyLogin(app, { ticket: t.ticket, code: lastCode() });
    expect(res.accessToken).toBeTruthy();

    const t2 = await ticketFor();
    await prisma.twoFactorChallenge.updateMany({ where: { usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await expectReject(() => tf.verifyLogin(app, { ticket: t2.ticket, code: lastCode() }))).status).toBe(401);
  });

  it("retrimiterea: cel mult o dată la 30 s, 5 pe tichet; codul vechi nu mai merge", async () => {
    await enableEmail();
    const t = await ticketFor();
    const first = lastCode();
    expect((await expectReject(() => tf.resendLoginCode(app, t.ticket))).status).toBe(429);
    for (let i = 0; i < 4; i++) {
      await prisma.twoFactorChallenge.updateMany({ where: { usedAt: null }, data: { lastSentAt: new Date(Date.now() - 31_000) } });
      await tf.resendLoginCode(app, t.ticket);
    }
    await prisma.twoFactorChallenge.updateMany({ where: { usedAt: null }, data: { lastSentAt: new Date(Date.now() - 31_000) } });
    expect((await expectReject(() => tf.resendLoginCode(app, t.ticket))).status).toBe(429);
    const latest = lastCode();
    if (first !== latest) {
      expect((await expectReject(() => tf.verifyLogin(app, { ticket: t.ticket, code: first }))).status).toBe(401);
    }
    expect((await tf.verifyLogin(app, { ticket: t.ticket, code: latest })).accessToken).toBeTruthy();
  });
});

describe("dezactivarea", () => {
  it("cere parola și un cod valid (TOTP sau de rezervă)", async () => {
    const { secret, backupCodes } = await enableTotp();
    expect((await expectReject(() => tf.disable(app, f.a.admin.id, { password: PASSWORD, code: "000000" }))).status).toBe(400);
    expect((await expectReject(async () => tf.disable(app, f.a.admin.id, { password: "gresit", code: await totpCode(secret) }))).status).toBe(400);
    await tf.disable(app, f.a.admin.id, { password: PASSWORD, code: backupCodes[3]! });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } });
    expect(user.twoFactorMethod).toBeNull();
    expect(user.twoFactorSecret).toBeNull();
    expect(await prisma.twoFactorBackupCode.count({ where: { userId: f.a.admin.id } })).toBe(0);
    expect(mail.changes.map((c) => c.event)).toEqual(["enabled", "disabled"]);
    expect((await webLogin()).accessToken).toBeTruthy();
  });

  it("cu metoda e-mail: codul se cere separat și merge pentru dezactivare", async () => {
    await enableEmail();
    await tf.sendManageCode(app, f.a.admin.id);
    await tf.disable(app, f.a.admin.id, { password: PASSWORD, code: lastCode() });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } })).twoFactorMethod).toBeNull();
  });

  it("coduri de rezervă noi: cele vechi nu mai merg", async () => {
    const { secret, backupCodes } = await enableTotp();
    const { backupCodes: fresh } = await tf.regenerateBackupCodes(app, f.a.admin.id, { password: PASSWORD, code: await totpCode(secret) });
    expect(fresh).toHaveLength(10);
    expect((await expectReject(async () => tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code: backupCodes[0]! }))).status).toBe(401);
    expect((await tf.verifyLogin(app, { ticket: (await ticketFor()).ticket, code: fresh[0]! })).accessToken).toBeTruthy();
  });
});

describe("resetarea de către administrator", () => {
  it("adminul firmei resetează 2FA unui coleg; e-mail către utilizator", async () => {
    await prisma.user.update({ where: { id: f.a.operator.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    await enableTotp(f.a.operator.id);
    mail.changes.length = 0;
    await tf.adminReset(app, f.a.operator.id, { userId: f.a.admin.id, tenantId: f.a.id });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: f.a.operator.id } });
    expect(user.twoFactorMethod).toBeNull();
    expect(mail.changes).toEqual([{ to: f.a.operator.email, event: "reset" }]);
    expect(await prisma.auditLog.count({ where: { tenantId: f.a.id, action: "2fa.reset" } })).toBe(1);
  });

  it("adminul altei firme primește 404 și nu schimbă nimic", async () => {
    await enableTotp();
    const err = await expectReject(() => tf.adminReset(app, f.a.admin.id, { userId: f.b.admin.id, tenantId: f.b.id }));
    expect(err.status).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } })).twoFactorMethod).toBe("totp");
  });

  it("administratorul platformei (fără firmă) poate reseta orice cont", async () => {
    await enableTotp();
    const master = await prisma.user.create({
      data: { email: "master@fixture.test", passwordHash: "x", firstName: "Master", lastName: "Admin", role: "MASTER_ADMIN" },
    });
    await tf.adminReset(app, f.a.admin.id, { userId: master.id, tenantId: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.a.admin.id } })).twoFactorMethod).toBeNull();
  });
});
