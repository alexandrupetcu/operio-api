import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { deleteFile } from "../../lib/s3.js";
import { invalidateDashboardCache } from "../../lib/dashboard-cache.js";
import { invalidateReadiness } from "./readiness.js";
import { readSampleSettings, writeSampleSettings } from "./sample-settings.js";
import { lockTenant } from "../../lib/tenant-lock.js";
import * as appointmentsService from "../appointments/appointments.service.js";
import { finalizeAppointmentSchema, type InstalatieReportData } from "../appointments/appointments.schema.js";
import { REVIZIE_OPERATIUNI } from "../appointments/instalatie-constants.js";

/**
 * Date de exemplu pentru onboarding: un client fictiv („Exemplu — Ion Popescu”),
 * cu o instalație de gaz și o revizie finalizată prin același drum ca aplicația
 * mobilă — deci cu documentele RT/PV/contract generate de worker. Referința se
 * ține în `Tenant.settingsJson.sample` (vezi sample-settings.ts) și e citită de
 * rapoartele oficiale (Anexa 6), de alertele OS și de statisticile clienților
 * ca să excludă rândurile de exemplu.
 */
export const SAMPLE_CLIENT = {
  firstName: "Exemplu — Ion",
  lastName: "Popescu",
  phone: "0700000000",
  email: "exemplu@operio.ro",
  address: "Str. Exemplu nr. 1, Sector 1, București",
} as const;

const fmtRo = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Raport de revizie realist, fără defecte, totul admis — ca documentele să iasă complete. */
function buildSampleReport(today: Date, instalatorEmployeeId: string | undefined): InstalatieReportData {
  const nextDate = new Date(today);
  nextDate.setFullYear(nextDate.getFullYear() + 10);
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 2);

  return {
    reportKind: "revizie_instalatie",
    instalatorEmployeeId,
    situatie: "interval_10_ani",
    tipLucrare: "individuala",
    operatiuni: Object.fromEntries(REVIZIE_OPERATIUNI.map((k) => [k, "DA" as const])),
    probaRezistenta: { amplasare: "suprateran", regim: "joasa", presiune: "1", presiuneUm: "bar", timp: "60", admis: true },
    probaEtanseitate: { amplasare: "suprateran", regim: "joasa", presiune: "200", presiuneUm: "mbar", timp: "1440", admis: true },
    defecte: [],
    conditiiTehniceOk: true,
    conditiiObservatii: "",
    tabel8Ok: true,
    documenteAparate: [
      {
        aparat: "CT",
        debit: "2.50",
        curatareNr: "1234",
        curatareData: fmtRo(sixMonthsAgo),
        verificareNr: "5678",
        verificareData: fmtRo(sixMonthsAgo),
      },
    ],
    apreciere: { i1: 10, i2: 10, i3: 9, i4: 10, i5: 10 },
    pv: {
      acordAccesNr: `12/${today.getFullYear()}`,
      proiectNr: `45/${today.getFullYear()}`,
      documentatieNr: `45/${today.getFullYear()}`,
      materiale: [
        { kind: "teava", material: "OL (oțel)", cantitate: "6", furnizor: "Exemplu Materiale SRL", certificat: `CC 100/${today.getFullYear()}` },
        { kind: "armatura", material: "OL (oțel)", diametru: '3/4"', cantitate: "2", furnizor: "Exemplu Materiale SRL" },
        { kind: "detector", cantitate: "1", furnizor: "Exemplu Materiale SRL" },
      ],
    },
    seal: { present: false },
    decizie: "admis",
    observatii: "Date de exemplu generate automat de Operio — pot fi șterse din Setări.",
    nextDate: isoDate(nextDate),
    clientSignature: undefined,
  };
}

export type CreateSampleResult = { clientId: string; appointmentId: string | null; documentsQueued: boolean };

/**
 * Creează setul de exemplu (idempotent: dacă există deja și clientul mai e în
 * bază, îl întoarce). Finalizarea trece prin `appointments.service.finalize`,
 * deci RT/PV/contract se generează exact ca pentru o vizită reală.
 */
export async function createSampleData(fastify: FastifyInstance, tenantId: string): Promise<CreateSampleResult> {
  const prisma = fastify.prisma;
  const today = new Date();
  const visitDate = new Date(today);
  visitDate.setHours(10, 0, 0, 0);

  // Verificarea „există deja?” și crearea stau în aceeași tranzacție, sub
  // blocajul tenantului: două clicuri simultane pe „Creează exemplul” nu pot
  // produce doi clienți de exemplu. `settingsJson.sample` se recitește DUPĂ
  // blocaj, ca să vadă ce a scris cererea care a trecut prima.
  const created = await prisma.$transaction(
    async (tx) => {
      await lockTenant(tx, tenantId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
      const existing = readSampleSettings(tenant.settingsJson);
      if (existing) {
        const client = await tx.client.findFirst({ where: { id: existing.clientId, tenantId }, select: { id: true } });
        if (client) return { existing: true as const, clientId: existing.clientId, appointmentId: existing.appointmentId };
        // Clientul a fost șters manual — curățăm referința și recreăm.
        await writeSampleSettings(tx, tenantId, null);
      }

      // Geografie: România / București / Sector 1, când există în tabelele seed-uite.
      const ro = await tx.country.findFirst({ where: { iso2: "RO" }, select: { id: true } });
      const buc = ro
        ? await tx.state.findFirst({ where: { countryId: ro.id, name: { contains: "ucure", mode: "insensitive" } }, select: { id: true } })
        : null;
      const sector1 = buc
        ? await tx.city.findFirst({ where: { stateId: buc.id, name: { equals: "Sector 1", mode: "insensitive" } }, select: { id: true } })
        : null;

      const client = await tx.client.create({
        data: {
          tenantId,
          type: "PERSON",
          status: "ACTIVE",
          firstName: SAMPLE_CLIENT.firstName,
          lastName: SAMPLE_CLIENT.lastName,
          phone: SAMPLE_CLIENT.phone,
          email: SAMPLE_CLIENT.email,
          notes: "Client de exemplu creat automat de Operio pentru a arăta cum funcționează aplicația.",
          addresses: {
            create: {
              label: "Domiciliu",
              address: SAMPLE_CLIENT.address,
              countryId: ro?.id ?? null,
              stateId: buc?.id ?? null,
              cityId: sector1?.id ?? null,
              isPrimary: true,
            },
          },
        },
        include: { addresses: { select: { id: true } } },
      });
      const addressId = client.addresses[0]?.id ?? null;

      const installation = await tx.gasInstallation.create({
        data: {
          clientId: client.id,
          clientAddressId: addressId,
          label: "Instalație exemplu",
          distributorName: "DISTRIGAZ SUD RETELE",
          codTehnicPOD: "DGSEXEMPLU0000001",
          codClient: "100000000001",
          documentatieNr: `45/${today.getFullYear()}`,
          documentatieData: fmtRo(today),
          contorTip: "BK-G4 MT",
          contorSeria: "DGSR",
          contorNr: "00000001",
          contorAn: String(today.getFullYear() - 2),
          contorIndex: "00123,40 mc",
          appliancesJson: [{ kind: "CT", name: "Centrală termică murală", debit: "2.50", count: 1 }] as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      const employee = await tx.employee.findFirst({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      // Programarea se scrie direct (nu prin `appointments.service.create`, care
      // lucrează pe clientul global, în afara tranzacției): client/adresă/instalație
      // tocmai au fost create aici, angajatul e al firmei (filtrat pe tenant).
      const appointment = await tx.appointment.create({
        data: {
          tenantId,
          clientId: client.id,
          clientAddressId: addressId,
          installationId: installation.id,
          employeeId: employee?.id ?? null,
          type: "revizie_instalatie",
          title: "Revizie instalație — Exemplu Ion Popescu",
          notes: "Programare de exemplu generată automat.",
          date: visitDate,
          duration: 60,
        },
        select: { id: true },
      });

      // Scriem referința ÎNAINTE de finalizare: dacă generarea pică, ștergerea
      // tot știe ce să curețe.
      await writeSampleSettings(tx, tenantId, {
        clientId: client.id,
        appointmentId: appointment.id,
        createdAt: today.toISOString(),
      });

      return { existing: false as const, clientId: client.id, appointmentId: appointment.id, installationId: installation.id, employeeId: employee?.id };
    },
    { maxWait: 5_000, timeout: 20_000 },
  );

  if (created.existing) {
    return { clientId: created.clientId, appointmentId: created.appointmentId, documentsQueued: false };
  }

  // Finalizarea trece prin drumul aplicației mobile (documente RT/PV/contract în
  // coadă) — după commit, ca worker-ul să găsească rândurile.
  const input = finalizeAppointmentSchema.parse({
    outcome: "raport_complet",
    installationId: created.installationId,
    reportData: buildSampleReport(today, created.employeeId),
  });
  await appointmentsService.finalize(fastify, tenantId, created.appointmentId, input);

  invalidateReadiness(tenantId);
  await invalidateDashboardCache(tenantId);
  return { clientId: created.clientId, appointmentId: created.appointmentId, documentsQueued: true };
}

export type DeleteSampleResult = {
  deleted: boolean;
  clientId: string | null;
  appointments: number;
  documents: number;
  registryEntriesVoided: number;
};

/**
 * Șterge clientul de exemplu cu tot ce a produs. Cascada Prisma ia adresele,
 * instalația, echipamentele și legăturile ClientDocument; programările (SET NULL
 * la ștergerea clientului) și rândurile Document (fără cascadă dinspre client)
 * se șterg explicit. Intrările din registratură NU se șterg — se anulează
 * (numerele alocate rămân vizibile ca anulate), de către utilizatorul care cere ștergerea.
 */
export async function deleteSampleData(
  fastify: FastifyInstance,
  tenantId: string,
  actorUserId: string,
): Promise<DeleteSampleResult> {
  const prisma = fastify.prisma;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
  const sample = readSampleSettings(tenant.settingsJson);
  if (!sample) return { deleted: false, clientId: null, appointments: 0, documents: 0, registryEntriesVoided: 0 };

  const client = await prisma.client.findFirst({ where: { id: sample.clientId, tenantId }, select: { id: true } });
  if (!client) {
    await writeSampleSettings(prisma, tenantId, null);
    invalidateReadiness(tenantId);
    return { deleted: false, clientId: sample.clientId, appointments: 0, documents: 0, registryEntriesVoided: 0 };
  }

  // Un proiect real legat de clientul de exemplu blochează ștergerea (FK RESTRICT) —
  // mai bine un mesaj clar decât „Referință invalidă”.
  const projects = await prisma.project.count({ where: { tenantId, clientId: client.id } });
  if (projects > 0) {
    throw fastify.httpErrors.conflict("Clientul de exemplu are proiecte asociate — ștergeți-le mai întâi");
  }

  const appointments = await prisma.appointment.findMany({
    where: { tenantId, clientId: client.id },
    select: { id: true },
  });
  const appointmentIds = appointments.map((a) => a.id);

  // Documente generate pentru client: cele legate DOAR de el (și de niciun proiect)
  // sau produse de programările lui.
  const docs = await prisma.document.findMany({
    where: {
      tenantId,
      OR: [
        { clients: { some: { clientId: client.id } } },
        ...(appointmentIds.length ? [{ appointmentId: { in: appointmentIds } }] : []),
      ],
    },
    select: { id: true, s3Key: true, status: true, _count: { select: { clients: true, projects: true } } },
  });
  const docsToDelete = docs.filter((d) => d._count.projects === 0 && d._count.clients <= 1);
  const docIds = docsToDelete.map((d) => d.id);

  // Worker-ul alocă numărul de registratură și randează PDF-ul la câteva secunde
  // după creare; dacă ștergem în fereastra aceea, rămâne un număr activ fără
  // document. Mai bine un 409 și o nouă încercare peste câteva secunde.
  if (docsToDelete.some((d) => d.status === "PENDING" || d.status === "GENERATING")) {
    throw fastify.httpErrors.conflict("Documentele de exemplu se generează încă — încercați din nou în câteva secunde");
  }

  const result = await prisma.$transaction(async (tx) => {
    const voided = await tx.registryEntry.updateMany({
      where: {
        tenantId,
        status: "active",
        OR: [{ clientId: client.id }, ...(docIds.length ? [{ documentId: { in: docIds } }] : [])],
      },
      data: {
        status: "voided",
        voidedAt: new Date(),
        voidedById: actorUserId,
        voidReason: "Date de exemplu șterse",
      },
    });

    // Reviziile de centrală ale programărilor (dacă există) cad cu echipamentul (cascade).
    const deletedDocs = docIds.length ? await tx.document.deleteMany({ where: { id: { in: docIds }, tenantId } }) : { count: 0 };
    const deletedAppts = appointmentIds.length
      ? await tx.appointment.deleteMany({ where: { id: { in: appointmentIds }, tenantId } })
      : { count: 0 };
    await tx.task.deleteMany({ where: { tenantId, clientId: client.id } });
    await tx.client.delete({ where: { id: client.id } });
    await writeSampleSettings(tx, tenantId, null);

    return { appointments: deletedAppts.count, documents: deletedDocs.count, registryEntriesVoided: voided.count };
  }, { maxWait: 5_000, timeout: 20_000 });

  // Fișierele din S3 se șterg după commit, best-effort — un PDF orfan e inofensiv.
  for (const d of docsToDelete) {
    if (d.s3Key) await deleteFile(d.s3Key).catch(() => {});
  }

  invalidateReadiness(tenantId);
  await invalidateDashboardCache(tenantId);
  return { deleted: true, clientId: client.id, ...result };
}
