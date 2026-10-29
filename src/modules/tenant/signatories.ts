import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  SIGNATORY_ROLES,
  SIGNATORY_ROLE_KEYS,
  certForRole,
  certTypesForRole,
  stampOf,
  type SignatoryRole,
} from "../../lib/certifications.js";
import { sampleEmployeeIds } from "./sample-settings.js";

/**
 * Semnatarii impliciți ai firmei: pentru fiecare rol (instalator, RVT, RSL-IP),
 * angajatul sau colaboratorul care semnează și ștampilează documentele când
 * raportul nu alege pe altcineva — ex. un colaborator RVT care doar ștampilează.
 * Stocare: `Tenant.settingsJson.signatories` = { [rol]: employeeId | null }.
 */

type SettingsJson = { signatories?: Partial<Record<string, string | null>>; [k: string]: unknown };
type Db = PrismaClient | Prisma.TransactionClient;

export const signatoriesUpdateSchema = z
  .object(Object.fromEntries(SIGNATORY_ROLE_KEYS.map((k) => [k, z.string().min(1).nullable().optional()])) as Record<
    SignatoryRole,
    z.ZodOptional<z.ZodNullable<z.ZodString>>
  >)
  .strict();

export function readSignatories(settingsJson: unknown): Record<SignatoryRole, string | null> {
  const s = settingsJson && typeof settingsJson === "object" ? (settingsJson as SettingsJson) : {};
  const stored = s.signatories && typeof s.signatories === "object" ? s.signatories : {};
  return Object.fromEntries(
    SIGNATORY_ROLE_KEYS.map((k) => [k, typeof stored[k] === "string" && stored[k] ? stored[k]! : null]),
  ) as Record<SignatoryRole, string | null>;
}

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();

/** Rolurile, cine e ales și cine poate fi ales (angajații activi cu certificarea rolului). */
export async function getSignatories(db: Db, tenantId: string) {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
  const chosen = readSignatories(tenant.settingsJson);
  const allTypes = [...new Set(SIGNATORY_ROLES.flatMap((r) => r.certTypes))];
  const employees = await db.employee.findMany({
    where: { tenantId, isActive: true, certifications: { some: { type: { in: allTypes } } } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeType: true,
      certifications: { select: { type: true, number: true, expiresAt: true, stamp: { select: { s3Key: true } } } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return {
    roles: SIGNATORY_ROLES.map((role) => {
      const candidates = employees.flatMap((e) => {
        const cert = certForRole(role.key, e.certifications);
        if (!cert) return [];
        return [
          {
            employeeId: e.id,
            name: fullName(e),
            employeeType: e.employeeType,
            certType: cert.type,
            number: cert.number,
            expiresAt: cert.expiresAt,
            hasStamp: !!stampOf(cert),
          },
        ];
      });
      const employeeId = chosen[role.key];
      return {
        key: role.key,
        label: role.label,
        description: role.description,
        employeeId,
        // Ales, dar între timp dezactivat sau fără certificare → afișat ca problemă.
        valid: !employeeId || candidates.some((c) => c.employeeId === employeeId),
        candidates,
      };
    }),
  };
}

export async function setSignatories(
  fastify: FastifyInstance,
  tenantId: string,
  patch: Partial<Record<SignatoryRole, string | null>>,
) {
  for (const role of SIGNATORY_ROLE_KEYS) {
    const employeeId = patch[role];
    if (!employeeId) continue;
    const ok = await fastify.prisma.employee.findFirst({
      where: { id: employeeId, tenantId, isActive: true, certifications: { some: { type: { in: [...certTypesForRole(role)] } } } },
      select: { id: true },
    });
    if (!ok) {
      const label = SIGNATORY_ROLES.find((r) => r.key === role)!.label;
      throw fastify.httpErrors.badRequest(`Persoana aleasă ca ${label} nu are certificarea necesară (sau nu e activă)`);
    }
  }
  const tenant = await fastify.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
  const settings = (tenant.settingsJson && typeof tenant.settingsJson === "object" ? tenant.settingsJson : {}) as SettingsJson;
  const next = { ...readSignatories(settings) };
  for (const role of SIGNATORY_ROLE_KEYS) if (patch[role] !== undefined) next[role] = patch[role] ?? null;
  await fastify.prisma.tenant.update({
    where: { id: tenantId },
    data: { settingsJson: { ...settings, signatories: next } as Prisma.InputJsonValue },
  });
  return getSignatories(fastify.prisma, tenantId);
}

export interface ResolvedSignatory {
  employeeId: string;
  name: string;
  certType: string;
  number: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  stampS3Key: string | null;
  signatureS3Key: string | null;
  source: "override" | "default" | "technician";
}

/**
 * Cine semnează un document pentru `role`: persoana aleasă în raport, altfel
 * semnatarul implicit al firmei, altfel tehnicianul vizitei — prima care e
 * activă și are certificarea rolului. `null` dacă nimeni nu se califică.
 * Un semnatar implicit din echipa de exemplu (sample-data.ts) vine abia după
 * tehnician: pe o vizită reală semnează omul real, iar ștampila „EXEMPLU” apare
 * doar când nu se califică nimeni altcineva.
 */
export async function resolveSignatory(
  db: Db,
  tenantId: string,
  role: SignatoryRole,
  opts: { overrideEmployeeId?: string | null; technicianEmployeeId?: string | null } = {},
): Promise<ResolvedSignatory | null> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true } });
  const def = readSignatories(tenant?.settingsJson)[role];
  const sampleDefault = !!def && sampleEmployeeIds(tenant?.settingsJson).includes(def);
  const order: [string | null | undefined, ResolvedSignatory["source"]][] = [
    [opts.overrideEmployeeId, "override"],
    [sampleDefault ? null : def, "default"],
    [opts.technicianEmployeeId, "technician"],
    [sampleDefault ? def : null, "default"],
  ];
  for (const [employeeId, source] of order) {
    if (!employeeId) continue;
    const e = await db.employee.findFirst({
      where: { id: employeeId, tenantId, isActive: true },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        signatureS3Key: true,
        certifications: {
          select: { type: true, number: true, domain: true, issuedAt: true, expiresAt: true, stamp: { select: { s3Key: true } } },
        },
      },
    });
    const cert = e && certForRole(role, e.certifications);
    if (!e || !cert) continue;
    return {
      employeeId: e.id,
      name: fullName(e),
      certType: cert.type,
      number: cert.number,
      issuedAt: cert.issuedAt,
      expiresAt: cert.expiresAt,
      stampS3Key: stampOf(cert),
      signatureS3Key: e.signatureS3Key,
      source,
    };
  }
  return null;
}
