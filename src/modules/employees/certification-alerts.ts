import type { PrismaClient } from "@prisma/client";
import { daysUntil } from "../../lib/working-days.js";
import { certDisplayName, certType } from "../../lib/certifications.js";
import { getAlertWindows } from "../tenant/alert-settings.js";
import { getTenantEventMap } from "../notifications/tenant-settings.js";
import { dispatch } from "../notifications/dispatch.js";
import { certificationBucket } from "./certification-bucket.js";
import { readCompanySettings } from "../tenant/company-settings.js";
import { parseRoDate } from "../../lib/ro-date.js";

/**
 * Autorizațiile firmei (ANRE, ISCIR) care expiră în fereastra firmei sau au
 * expirat — datele vin din Setări → Firmă (text „zz.ll.aaaa”; ce nu e o dată
 * validă, ex. „nelimitat”, e ignorat).
 */
export async function listExpiringAuthorizations(db: PrismaClient, tenantId: string, windowDays: number, now = new Date()) {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { iscirNumber: true, settingsJson: true } });
  if (!tenant) return [];
  const c = readCompanySettings(tenant.settingsJson);
  const all = [
    { key: "anre" as const, label: "Autorizația ANRE", number: [c.anreNr, c.anreTip].filter(Boolean).join(" · ") || null, expiresAt: parseRoDate(c.anreExp) },
    { key: "iscir" as const, label: "Autorizația ISCIR", number: tenant.iscirNumber || null, expiresAt: parseRoDate(c.iscirExp) },
  ];
  return all.flatMap((a) => {
    if (!a.expiresAt) return [];
    const daysLeft = daysUntil(a.expiresAt, now);
    return daysLeft <= windowDays ? [{ ...a, expiresAt: a.expiresAt, daysLeft }] : [];
  });
}

/**
 * Certificările angajaților activi care expiră în fereastra firmei
 * (`certificationWarningDays`) sau au expirat deja — pentru panou și notificări.
 */
export async function listExpiringCertifications(db: PrismaClient, tenantId: string, windowDays: number, now = new Date()) {
  const limit = new Date(now);
  limit.setDate(limit.getDate() + windowDays);
  const rows = await db.employeeCertification.findMany({
    where: { tenantId, expiresAt: { not: null, lte: limit }, employee: { isActive: true } },
    select: {
      id: true,
      type: true,
      label: true,
      number: true,
      expiresAt: true,
      employee: { select: { id: true, firstName: true, lastName: true, userId: true } },
    },
    orderBy: { expiresAt: "asc" },
    take: 200,
  });
  return rows.map((r) => ({
    ...r,
    expiresAt: r.expiresAt!,
    daysLeft: daysUntil(r.expiresAt!, now),
    employeeName: `${r.employee.firstName} ${r.employee.lastName}`.trim(),
    certName: certType(r.type)?.short || certDisplayName(r),
  }));
}

/**
 * Notificări de expirare: o singură dată per prag (fereastra firmei, 30, 7, ziua
 * expirării, expirat) și certificare, către admini/manageri și persoana în cauză
 * (dacă are cont). Rulează din scanerul zilnic.
 */
export async function sendCertificationExpiryNotifications(db: PrismaClient, tenantId: string, now = new Date()): Promise<number> {
  const enabled = await getTenantEventMap(db, tenantId);
  if (!enabled.certification_expiry) return 0;
  const w = await getAlertWindows(db, tenantId);
  const expiring = await listExpiringCertifications(db, tenantId, w.certificationWarningDays, now);
  const authorizations = await listExpiringAuthorizations(db, tenantId, w.certificationWarningDays, now);
  if (expiring.length === 0 && authorizations.length === 0) return 0;

  const office = await db.user.findMany({
    where: { tenantId, isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
    select: { id: true },
  });
  let sent = 0;
  for (const c of expiring) {
    const bucket = certificationBucket(c.daysLeft, w.certificationWarningDays);
    const when = c.expiresAt.toLocaleDateString("ro-RO", { timeZone: "UTC" });
    const subject =
      c.daysLeft < 0
        ? `${c.certName} expirată: ${c.employeeName}`
        : c.daysLeft === 0
          ? `${c.certName} expiră azi: ${c.employeeName}`
          : `${c.certName} expiră în ${c.daysLeft} zile: ${c.employeeName}`;
    const body = `${certDisplayName(c)}${c.number ? ` nr. ${c.number}` : ""} — ${c.employeeName}, ${
      c.daysLeft < 0 ? "a expirat pe" : "expiră pe"
    } ${when}. Documentele semnate de această persoană nu ar trebui emise cu o certificare expirată.`;
    const recipients = new Set([...office.map((u) => u.id), ...(c.employee.userId ? [c.employee.userId] : [])]);
    for (const userId of recipients) {
      const res = await dispatch(db, tenantId, {
        userId,
        category: "tasks",
        subject,
        body,
        url: `/employees?id=${c.employee.id}`,
        dedupeKey: `due:cert:${c.id}:${c.expiresAt.toISOString().slice(0, 10)}:${bucket}`,
      });
      if (!res.skipped) sent++;
    }
  }

  // Autorizațiile firmei: doar biroul (admini, manageri).
  for (const a of authorizations) {
    const bucket = certificationBucket(a.daysLeft, w.certificationWarningDays);
    const when = a.expiresAt.toLocaleDateString("ro-RO", { timeZone: "UTC" });
    const subject =
      a.daysLeft < 0 ? `${a.label} a firmei a expirat` : a.daysLeft === 0 ? `${a.label} a firmei expiră azi` : `${a.label} a firmei expiră în ${a.daysLeft} zile`;
    const body = `${a.label}${a.number ? ` (${a.number})` : ""} ${a.daysLeft < 0 ? "a expirat pe" : "expiră pe"} ${when}. Se tipărește pe fișe, PV-uri și rapoarte — actualizează datele în Setări → Informații firmă după reînnoire.`;
    for (const u of office) {
      const res = await dispatch(db, tenantId, {
        userId: u.id,
        category: "tasks",
        subject,
        body,
        url: "/settings?tab=company",
        dedupeKey: `due:auth:${a.key}:${a.expiresAt.toISOString().slice(0, 10)}:${bucket}`,
      });
      if (!res.skipped) sent++;
    }
  }
  return sent;
}
