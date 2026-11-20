import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import * as appointmentsService from "../appointments/appointments.service.js";
import { apptVisibilityWhere, type ApptScope } from "../appointments/scope.js";
import { REVISION_TYPES, type CreateDirectRevisionInput, type ListRevisionsQuery, type RevisionType } from "./revisions.schema.js";
import { daysUntil, osRegistrationDeadline } from "../../lib/working-days.js";
import { getAlertWindows } from "../tenant/alert-settings.js";
import { isNoReportOutcome } from "../appointments/appointments.service.js";
import { OS_REGISTRATION_TYPES } from "../appointments/os-registration.js";

/**
 * Secțiunea „Revizii”: toate reviziile firmei la un loc — de centrală (ISCIR) și de
 * instalație (revizie / verificare) — indiferent de client, plus crearea unei revizii
 * fără programare prealabilă.
 */

export interface RevisionRow {
  /** Id-ul programării, sau `rev:<id>` pentru o revizie de centrală venită doar din PDF. */
  id: string;
  kind: "centrala" | "instalatie";
  type: RevisionType;
  date: Date;
  status: string;
  completedAt: Date | null;
  client: { id: string; name: string } | null;
  address: string | null;
  /** Centrala sau instalația la care s-a făcut. */
  subject: string | null;
  distributorName: string | null;
  employee: { id: string; name: string } | null;
  decision: "admis" | "respins" | null;
  /** Vizita, în forma cerută de `OsStatus` pe web (null pentru revizia doar din PDF). */
  appointment: {
    id: string;
    type: string;
    date: Date;
    status: string;
    completedAt: Date | null;
    completionOutcome: string | null;
    osSubmittedAt: Date | null;
    osRegistrationNumber: string | null;
    osRegisteredAt: Date | null;
    osClientNotifiedAt: Date | null;
  } | null;
  revision: { id: string; equipmentId: string; status: string; hasPdf: boolean; iscirDocumentId: string | null } | null;
  /** Unde e la OS: termen depășit / de depus / depus, așteaptă număr / înregistrat / nu e cazul. */
  osState?: OsState;
  /** Termenul de depunere (zile lucrătoare de la finalizare), când e de depus. */
  osDeadline?: Date | null;
}

export type OsState = "overdue" | "to_submit" | "submitted" | "registered" | "none";

function osStateOf(r: RevisionRow, workingDays: number): { osState: OsState; osDeadline: Date | null } {
  const a = r.appointment;
  if (!a || a.status !== "completed" || !(OS_REGISTRATION_TYPES as readonly string[]).includes(a.type) || isNoReportOutcome(a.completionOutcome)) {
    return { osState: "none", osDeadline: null };
  }
  if (a.osRegistrationNumber) return { osState: "registered", osDeadline: null };
  if (a.osSubmittedAt) return { osState: "submitted", osDeadline: null };
  const deadline = osRegistrationDeadline(a.completedAt ?? a.date, workingDays);
  return { osState: daysUntil(deadline) < 0 ? "overdue" : "to_submit", osDeadline: deadline };
}

const missingPdf = (r: RevisionRow) => r.kind === "centrala" && r.status === "completed" && !!r.appointment && !!r.revision && !r.revision.hasPdf;
const OS_RANK: Record<OsState, number> = { overdue: 0, to_submit: 1, submitted: 2, registered: 3, none: 3 };

/**
 * Ce e urgent, sus: termen OS depășit (cel mai vechi termen întâi) → de depus (cel mai
 * apropiat termen) → depuse, așteaptă număr (cele mai vechi depuneri) → restul, după dată.
 * „De făcut”: după dată, crescător — cele rămase în urmă primele, apoi cele mai apropiate.
 */
function byUrgency(status: ListRevisionsQuery["status"]) {
  return (a: RevisionRow, b: RevisionRow) => {
    if (status === "scheduled") return a.date.getTime() - b.date.getTime();
    const ra = OS_RANK[a.osState ?? "none"], rb = OS_RANK[b.osState ?? "none"];
    if (ra !== rb) return ra - rb;
    if (ra <= 1) return (a.osDeadline?.getTime() ?? 0) - (b.osDeadline?.getTime() ?? 0) || a.date.getTime() - b.date.getTime();
    if (ra === 2) return (a.appointment?.osSubmittedAt?.getTime() ?? 0) - (b.appointment?.osSubmittedAt?.getTime() ?? 0);
    return b.date.getTime() - a.date.getTime();
  };
}

const INSTALATIE_TYPES: RevisionType[] = ["revizie_instalatie", "verificare_instalatie"];

function typesFor(q: ListRevisionsQuery): RevisionType[] {
  if (q.type) return [q.type];
  if (q.kind === "centrala") return ["revizie"];
  if (q.kind === "instalatie") return INSTALATIE_TYPES;
  return [...REVISION_TYPES];
}

function clientName(c: { companyName: string | null; firstName: string | null; lastName: string | null }) {
  return c.companyName || [c.firstName, c.lastName].filter(Boolean).join(" ") || "—";
}

function equipmentLabel(e: { name: string | null; internalName: string | null; serial: string | null }) {
  return e.internalName || e.name || (e.serial ? `S/N ${e.serial}` : null);
}

function installationLabel(i: { label: string | null; codTehnicPOD: string | null; codClient: string | null }) {
  return i.label || i.codTehnicPOD || i.codClient || null;
}

function decisionOf(type: string, json: unknown): "admis" | "respins" | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const raw = type === "revizie" ? (j.conclusions as Record<string, unknown> | undefined)?.decision : j.decizie;
  return raw === "admis" || raw === "respins" ? raw : null;
}

function dayRange(q: ListRevisionsQuery): Prisma.DateTimeFilter | undefined {
  if (!q.from && !q.to) return undefined;
  const r: Prisma.DateTimeFilter = {};
  if (q.from) r.gte = new Date(`${q.from}T00:00:00.000Z`);
  if (q.to) r.lte = new Date(`${q.to}T23:59:59.999Z`);
  return r;
}

const ci = (s: string): Prisma.StringFilter => ({ contains: s, mode: "insensitive" });

export async function list(fastify: FastifyInstance, tenantId: string, q: ListRevisionsQuery, scope: ApptScope = { kind: "all" }) {
  const types = typesFor(q);
  const range = dayRange(q);
  const statusWhere: Prisma.AppointmentWhereInput =
    q.status === "completed"
      ? { status: "completed" }
      : q.status === "scheduled"
        ? { status: { in: ["scheduled", "in_progress", "awaiting_report", "rescheduled"] } }
        : {};
  const search: Prisma.AppointmentWhereInput = q.q
    ? {
        OR: [
          { client: { firstName: ci(q.q) } },
          { client: { lastName: ci(q.q) } },
          { client: { companyName: ci(q.q) } },
          { clientAddress: { address: ci(q.q) } },
          { installation: { codTehnicPOD: ci(q.q) } },
          { installation: { codClient: ci(q.q) } },
          { installation: { label: ci(q.q) } },
          { equipment: { name: ci(q.q) } },
          { equipment: { internalName: ci(q.q) } },
          { equipment: { serial: ci(q.q) } },
        ],
      }
    : {};

  const appts = await fastify.prisma.appointment.findMany({
    where: {
      tenantId,
      deletedAt: null,
      type: { in: types },
      ...statusWhere,
      ...(q.clientId && { clientId: q.clientId }),
      ...(range && { date: range }),
      ...search,
      ...apptVisibilityWhere(scope),
    },
    select: {
      id: true,
      type: true,
      date: true,
      status: true,
      completedAt: true,
      completionOutcome: true,
      completionDataJson: true,
      osSubmittedAt: true,
      osRegistrationNumber: true,
      osRegisteredAt: true,
      osClientNotifiedAt: true,
      client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
      clientAddress: { select: { address: true, city: { select: { name: true } } } },
      installation: { select: { label: true, codTehnicPOD: true, codClient: true, distributorName: true } },
      equipment: { select: { name: true, internalName: true, serial: true } },
      employee: { select: { id: true, firstName: true, lastName: true } },
      equipmentRevision: { select: { id: true, equipmentId: true, status: true, s3Key: true, iscirDocumentId: true } },
    },
    orderBy: { date: "desc" },
    take: 500,
  });

  const rows: RevisionRow[] = appts.map((a) => ({
    id: a.id,
    kind: a.type === "revizie" ? "centrala" : "instalatie",
    type: a.type as RevisionType,
    date: a.date,
    status: a.status,
    completedAt: a.completedAt,
    client: a.client ? { id: a.client.id, name: clientName(a.client) } : null,
    address: a.clientAddress ? [a.clientAddress.address, a.clientAddress.city?.name].filter(Boolean).join(", ") : null,
    subject: a.installation ? installationLabel(a.installation) : a.equipment ? equipmentLabel(a.equipment) : null,
    distributorName: a.installation?.distributorName ?? null,
    employee: a.employee ? { id: a.employee.id, name: `${a.employee.firstName} ${a.employee.lastName}` } : null,
    decision: decisionOf(a.type, a.completionDataJson),
    appointment: {
      id: a.id,
      type: a.type,
      date: a.date,
      status: a.status,
      completedAt: a.completedAt,
      completionOutcome: a.completionOutcome,
      osSubmittedAt: a.osSubmittedAt,
      osRegistrationNumber: a.osRegistrationNumber,
      osRegisteredAt: a.osRegisteredAt,
      osClientNotifiedAt: a.osClientNotifiedAt,
    },
    revision: a.equipmentRevision
      ? { id: a.equipmentRevision.id, equipmentId: a.equipmentRevision.equipmentId, status: a.equipmentRevision.status, hasPdf: !!a.equipmentRevision.s3Key, iscirDocumentId: a.equipmentRevision.iscirDocumentId }
      : null,
  }));

  // Reviziile de centrală venite doar din PDF-ul analizorului (e-mail / import), fără
  // vizită în calendar — tot revizii făcute sunt. Tehnicienii cu domeniu restrâns nu le văd.
  if (types.includes("revizie") && q.status !== "scheduled" && scope.kind === "all") {
    const orphans = await fastify.prisma.equipmentRevision.findMany({
      where: {
        appointment: null,
        equipment: {
          client: { tenantId, ...(q.clientId && { id: q.clientId }) },
          ...(q.q && {
            OR: [
              { name: ci(q.q) },
              { internalName: ci(q.q) },
              { serial: ci(q.q) },
              { client: { firstName: ci(q.q) } },
              { client: { lastName: ci(q.q) } },
              { client: { companyName: ci(q.q) } },
              { clientAddress: { address: ci(q.q) } },
            ],
          }),
        },
        ...(range && { revisionDate: range }),
      },
      select: {
        id: true,
        equipmentId: true,
        revisionDate: true,
        status: true,
        s3Key: true,
        iscirDocumentId: true,
        createdAt: true,
        equipment: {
          select: {
            name: true,
            internalName: true,
            serial: true,
            client: { select: { id: true, companyName: true, firstName: true, lastName: true } },
            clientAddress: { select: { address: true } },
          },
        },
      },
      orderBy: { revisionDate: "desc" },
      take: 500,
    });
    for (const r of orphans) {
      rows.push({
        id: `rev:${r.id}`,
        kind: "centrala",
        type: "revizie",
        date: r.revisionDate,
        status: "completed",
        completedAt: r.createdAt,
        client: { id: r.equipment.client.id, name: clientName(r.equipment.client) },
        address: r.equipment.clientAddress?.address ?? null,
        subject: equipmentLabel(r.equipment),
        distributorName: null,
        employee: null,
        decision: null,
        appointment: null,
        revision: { id: r.id, equipmentId: r.equipmentId, status: r.status, hasPdf: !!r.s3Key, iscirDocumentId: r.iscirDocumentId },
      });
    }
  }

  const { osRegistrationWorkingDays } = await getAlertWindows(fastify.prisma, tenantId);
  for (const r of rows) Object.assign(r, osStateOf(r, osRegistrationWorkingDays));
  // Contoarele din capul paginii: pe filtrele curente, fără filtrul OS.
  const counts = {
    overdue: rows.filter((r) => r.osState === "overdue").length,
    toSubmit: rows.filter((r) => r.osState === "to_submit").length,
    submitted: rows.filter((r) => r.osState === "submitted").length,
    missingPdf: rows.filter(missingPdf).length,
  };
  const shown = q.os
    ? rows.filter((r) => (q.os === "missing_pdf" ? missingPdf(r) : r.osState === (q.os === "to_submit" ? "to_submit" : q.os)))
    : rows;
  shown.sort(byUrgency(q.status));

  const total = shown.length;
  const start = (q.page - 1) * q.limit;
  return { data: shown.slice(start, start + q.limit), counts, meta: { total, page: q.page, limit: q.limit, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
}

const TITLE_BY_TYPE: Record<RevisionType, string> = {
  revizie: "Revizie centrală",
  revizie_instalatie: "Revizie instalație",
  verificare_instalatie: "Verificare instalație",
};

/**
 * Revizie fără programare: creează programarea pe data reviziei și o finalizează pe
 * loc cu raportul. Dacă finalizarea pică (date invalide, echipament străin), programarea
 * abia creată se șterge, ca să nu rămână o vizită „programată” în trecut. Aceeași cheie
 * de idempotență retrimisă întoarce programarea deja creată, fără una nouă.
 */
export async function createDirect(
  fastify: FastifyInstance,
  tenantId: string,
  input: CreateDirectRevisionInput,
  idempotencyKey: string | null,
  /** Vezi `appointmentsService.create`: fără `employeeId` în body, vizita e a celui care o înregistrează. */
  opts: { defaultEmployeeId?: string | null } = {},
  /** Contul care face cererea, pentru istoricul modificărilor. */
  actorUserId: string | null = null,
) {
  if (idempotencyKey) {
    const existing = await fastify.prisma.appointment.findFirst({
      where: { tenantId, deletedAt: null, completionDataJson: { path: ["_idempotencyKey"], equals: idempotencyKey } },
      select: { id: true },
    });
    if (existing) return appointmentsService.finalize(fastify, tenantId, existing.id, input.report, { kind: "all" }, idempotencyKey, actorUserId);
  }

  const client = await fastify.prisma.client.findFirst({
    where: { id: input.clientId, tenantId },
    select: { companyName: true, firstName: true, lastName: true },
  });
  if (!client) throw fastify.httpErrors.notFound("Client not found");

  const created = await appointmentsService.create(fastify, tenantId, {
    type: input.type,
    title: `${TITLE_BY_TYPE[input.type]} — ${clientName(client)}`,
    date: input.date,
    duration: 60,
    clientId: input.clientId,
    clientAddressId: input.clientAddressId ?? undefined,
    employeeId: input.employeeId ?? undefined,
    equipmentId: input.equipmentId ?? undefined,
    installationId: input.installationId ?? undefined,
  }, opts, actorUserId);

  try {
    return await appointmentsService.finalize(fastify, tenantId, created.id, input.report, { kind: "all" }, idempotencyKey, actorUserId);
  } catch (err) {
    await fastify.prisma.appointment.delete({ where: { id: created.id } }).catch(() => {});
    throw err;
  }
}
