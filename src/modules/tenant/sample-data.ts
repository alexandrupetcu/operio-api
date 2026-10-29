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
import * as employeesService from "../employees/employees.service.js";
import * as stampsService from "../employees/stamps.service.js";
import { withPositions } from "../employees/positions.js";
import * as dossiersService from "../dossiers/dossiers.service.js";
import { createDossierSchema, updateDossierSchema } from "../dossiers/dossiers.schema.js";
import { readSignatories } from "./signatories.js";
import { authorityOf, certType, SIGNATORY_ROLE_KEYS, type CertGroup, type SignatoryRole } from "../../lib/certifications.js";
import { renderSignaturePng, renderStampPng } from "../../lib/sample-images.js";
import { getTenantEntitlements } from "../../lib/entitlements/resolve.js";

/**
 * Date de exemplu pentru onboarding: un client fictiv („Exemplu — Ion Popescu”),
 * cu o instalație de gaz și o revizie finalizată prin același drum ca aplicația
 * mobilă — deci cu documentele RT/PV/contract generate de worker. Alături, o
 * echipă de exemplu (instalator ANRE, RVT/RSL-IP ISCIR, RTE/șef de șantier), cu
 * certificări, semnături și ștampile generate (marcate „EXEMPLU”), și un dosar
 * „Carte branșament” completat și generat. Referința se ține în
 * `Tenant.settingsJson.sample` (vezi sample-settings.ts) și e citită de
 * rapoartele oficiale (Anexa 6), de alertele OS, de lista de pornire și de
 * statisticile clienților ca să excludă rândurile de exemplu.
 */
export const SAMPLE_CLIENT = {
  firstName: "Exemplu — Ion",
  lastName: "Popescu",
  phone: "0700000000",
  email: "exemplu@operio.ro",
  address: "Str. Exemplu nr. 1, Sector 1, București",
} as const;

/** Prefixul numelor din echipa de exemplu (pus pe prenume, ca la client). */
export const SAMPLE_EMPLOYEE_PREFIX = "Exemplu — ";
/** Grupul de sistem din care se face dosarul de exemplu (fără el, exemplul nu are dosar). */
export const SAMPLE_DOSSIER_GROUP_NAME = "Dosar Bransament Distrigaz";
export const SAMPLE_DOSSIER_NAME = "Exemplu — Carte branșament";

type TeamKey = "installer" | "iscir" | "rte";
interface SampleCert {
  type: string;
  number: string;
  domain?: string;
}
interface SamplePerson {
  key: TeamKey;
  firstName: string;
  lastName: string;
  phone: string;
  positions: string[];
  certs: SampleCert[];
}

/** Echipa de exemplu. Numerele „EX-…” se văd pe documente ca numere de exemplu. */
export const SAMPLE_TEAM: SamplePerson[] = [
  {
    key: "installer",
    firstName: `${SAMPLE_EMPLOYEE_PREFIX}Andrei`,
    lastName: "Ionescu",
    phone: "0700000001",
    positions: ["instalator"],
    certs: [
      { type: "anre_egiu", number: "EX-000101" },
      { type: "anre_egd", number: "EX-000102" },
    ],
  },
  {
    key: "iscir",
    firstName: `${SAMPLE_EMPLOYEE_PREFIX}Maria`,
    lastName: "Dobre",
    phone: "0700000002",
    positions: ["cq"],
    certs: [
      { type: "iscir_rvt", number: "EX-000201", domain: "CT ≤ 400 kW (exemplu)" },
      { type: "iscir_rsl", number: "EX-000202", domain: "CT ≤ 400 kW (exemplu)" },
      { type: "cq", number: "EX-000203" },
    ],
  },
  {
    key: "rte",
    firstName: `${SAMPLE_EMPLOYEE_PREFIX}Radu`,
    lastName: "Stan",
    phone: "0700000003",
    positions: ["rte", "sef_santier", "proiectant"],
    certs: [
      { type: "rte", number: "EX-000301", domain: "8.4D" },
      { type: "anre_pgd", number: "EX-000302" },
    ],
  },
];

/** Rândul principal de pe ștampilă, după autoritate. */
const STAMP_TITLE: Record<CertGroup, (p: SamplePerson) => string> = {
  ANRE: (p) => (p.positions.includes("instalator") ? "Instalator autorizat ANRE" : "Proiectant autorizat ANRE"),
  ISCIR: () => "Personal tehnic ISCIR",
  Construcții: (p) => (p.positions.includes("rte") ? "Responsabil tehnic execuție" : "Control calitate"),
  Altele: () => "Personal autorizat",
};

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

export type CreateSampleResult = {
  clientId: string;
  appointmentId: string | null;
  documentsQueued: boolean;
  employeeIds: string[];
  dossierId: string | null;
};

const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const addYears = (d: Date, n: number) => {
  const x = new Date(d);
  x.setFullYear(x.getFullYear() + n);
  return x;
};
/** Ziua (fără oră) în UTC — ca valorile `@db.Date` să nu alunece cu fusul orar. */
const dateOnly = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const personName = (p: Pick<SamplePerson, "firstName" | "lastName">) =>
  `${p.firstName.replace(SAMPLE_EMPLOYEE_PREFIX, "")} ${p.lastName}`;

/**
 * Creează setul de exemplu (idempotent: dacă există deja și clientul mai e în
 * bază, îl întoarce). Finalizarea trece prin `appointments.service.finalize`,
 * deci RT/PV/contract se generează exact ca pentru o vizită reală.
 */
export async function createSampleData(
  fastify: FastifyInstance,
  tenantId: string,
  /** Cine cere exemplul — trece ca autor al dosarului generat și în jurnalul ștampilelor. */
  actorUserId: string | null = null,
): Promise<CreateSampleResult> {
  const prisma = fastify.prisma;
  const today = new Date();
  const visitDate = new Date(today);
  visitDate.setHours(10, 0, 0, 0);

  // Clientul de exemplu șters manual, restul încă acolo: curățăm întâi echipa, dosarul
  // și semnatarii vechi (altfel ar rămâne orfani când referința se rescrie mai jos).
  if (actorUserId) {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
    const prev = readSampleSettings(t.settingsJson);
    if (prev && !(await prisma.client.count({ where: { id: prev.clientId, tenantId } }))) {
      await deleteSampleData(fastify, tenantId, actorUserId);
    }
  }

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
        if (client) return { existing: true as const, ...existing };
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

      // Echipa de exemplu, cu certificările (ștampilele și semnăturile — imagini în
      // S3 — se pun după commit). Fără cont de utilizator: nu ocupă locuri de tehnician.
      const issuedAt = dateOnly(addYears(today, -1));
      const expiresAt = dateOnly(addYears(today, 3));
      const team = {} as Record<TeamKey, string>;
      for (const p of SAMPLE_TEAM) {
        const e = await tx.employee.create({
          data: {
            tenantId,
            ...withPositions({ firstName: p.firstName, lastName: p.lastName, positions: p.positions }),
            employeeType: "intern",
            isActive: true,
            phone: p.phone,
            certifications: {
              create: p.certs.map((c) => ({
                tenantId,
                type: c.type,
                number: c.number,
                domain: c.domain ?? null,
                issuedAt,
                expiresAt,
                notes: "Certificare de exemplu — nu e reală.",
              })),
            },
          },
          select: { id: true },
        });
        team[p.key] = e.id;
      }
      const employeeIds = SAMPLE_TEAM.map((p) => team[p.key]);

      // Semnatarii impliciți: doar rolurile pe care firma nu le-a ales încă.
      const tenantNow = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
      const settings = (tenantNow.settingsJson && typeof tenantNow.settingsJson === "object" ? tenantNow.settingsJson : {}) as Record<string, unknown>;
      const signatories = readSignatories(settings);
      const roleHolder: Record<SignatoryRole, string> = { instalator: team.installer, rvt: team.iscir, rsl: team.iscir };
      const signatoryRolesSet = SIGNATORY_ROLE_KEYS.filter((role) => !signatories[role]);
      if (signatoryRolesSet.length) {
        for (const role of signatoryRolesSet) signatories[role] = roleHolder[role];
        await tx.tenant.update({
          where: { id: tenantId },
          data: { settingsJson: { ...settings, signatories } as Prisma.InputJsonValue },
        });
      }

      // Programarea se scrie direct (nu prin `appointments.service.create`, care
      // lucrează pe clientul global, în afara tranzacției): client/adresă/instalație
      // tocmai au fost create aici, angajatul e al firmei (filtrat pe tenant).
      const appointment = await tx.appointment.create({
        data: {
          tenantId,
          clientId: client.id,
          clientAddressId: addressId,
          installationId: installation.id,
          employeeId: team.installer,
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
        employeeIds,
        signatoryRolesSet,
        dossierId: null,
      });

      return {
        existing: false as const,
        clientId: client.id,
        appointmentId: appointment.id,
        installationId: installation.id,
        employeeIds,
        signatoryRolesSet,
        team,
      };
    },
    { maxWait: 5_000, timeout: 20_000 },
  );

  if (created.existing) {
    return {
      clientId: created.clientId,
      appointmentId: created.appointmentId,
      documentsQueued: false,
      employeeIds: created.employeeIds,
      dossierId: created.dossierId,
    };
  }

  // Semnăturile și ștampilele, înainte de finalizare: worker-ul le citește la randare.
  await addSampleImages(fastify, tenantId, created.team, actorUserId);

  // Finalizarea trece prin drumul aplicației mobile (documente RT/PV/contract în
  // coadă) — după commit, ca worker-ul să găsească rândurile.
  const input = finalizeAppointmentSchema.parse({
    outcome: "raport_complet",
    installationId: created.installationId,
    reportData: buildSampleReport(today, created.team.installer),
  });
  await appointmentsService.finalize(fastify, tenantId, created.appointmentId, input);

  const dossierId = await createSampleDossier(fastify, tenantId, actorUserId, created.clientId, created.team, today);

  invalidateReadiness(tenantId);
  await invalidateDashboardCache(tenantId);
  return {
    clientId: created.clientId,
    appointmentId: created.appointmentId,
    documentsQueued: true,
    employeeIds: created.employeeIds,
    dossierId,
  };
}

/**
 * Semnătura (PNG „de mână”) și câte o ștampilă per autoritate (ANRE / ISCIR /
 * Construcții) pentru fiecare om din echipa de exemplu, prin serviciile reale —
 * aceleași chei S3 și aceleași legături certificare → ștampilă ca la o încărcare
 * din pagina Echipă. Best-effort: fără imagini, exemplul rămâne utilizabil.
 */
async function addSampleImages(
  fastify: FastifyInstance,
  tenantId: string,
  team: Record<TeamKey, string>,
  actorUserId: string | null,
) {
  const tenant = await fastify.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  for (const p of SAMPLE_TEAM) {
    const employeeId = team[p.key];
    const name = personName(p);
    try {
      const signature = await renderSignaturePng(name);
      await employeesService.setSignature(fastify, tenantId, employeeId, `data:image/png;base64,${signature.toString("base64")}`);

      const certs = await fastify.prisma.employeeCertification.findMany({
        where: { tenantId, employeeId },
        select: { id: true, type: true, number: true },
        orderBy: { createdAt: "asc" },
      });
      const byAuthority = new Map<CertGroup, typeof certs>();
      for (const c of certs) {
        const a = authorityOf(c.type);
        byAuthority.set(a, [...(byAuthority.get(a) ?? []), c]);
      }
      for (const [authority, group] of byAuthority) {
        const stamp = await stampsService.createStamp(
          fastify,
          tenantId,
          employeeId,
          { name: `Ștampilă ${authority} (exemplu)`, authority, certIds: group.map((c) => c.id) },
          actorUserId,
        );
        const shorts = group.map((c) => certType(c.type)?.short ?? c.type);
        const png = await renderStampPng({
          firm: tenant.name,
          person: name,
          lines: [STAMP_TITLE[authority](p), ...group.slice(0, 2).map((c) => `${certType(c.type)?.short ?? ""} nr. ${c.number ?? ""}`.trim())],
          bottom: `${authority} · ${shorts.join(" / ")}`,
        });
        // „original”: PNG-ul e deja transparent și curat — fără tăiere / îndreptare.
        await stampsService.setStampImage(fastify, tenantId, employeeId, stamp.id, png, actorUserId, "original");
      }
    } catch (err) {
      fastify.log.warn({ err, tenantId, employeeId }, "sample data: cannot create signature/stamp images");
    }
  }
}

/**
 * Valorile dosarului de exemplu — aceleași care au dat dosare Distrigaz complete
 * la test, cu datele mutate relativ la azi (lucrarea a început acum ~4 luni) și
 * numele de persoane înlocuite cu cele de exemplu.
 */
function sampleDossierMetadata(today: Date, names: Record<TeamKey, string>): Record<string, string> {
  const b = addDays(today, -120); // ordinul de lucru
  const d = (n: number) => fmtRo(addDays(b, n));
  const y = String(addDays(b, 0).getFullYear());
  const rows = (r: string[][]) => r.map((c) => c.join(" | ")).join("\n");
  const installer = names.installer;
  return {
    project_street_type: "Str",
    lucrare_strada: "Exemplu",
    project_street_number: "1",
    project_dn: "32",
    project_material: "PE 100",
    project_length: "2.00",
    bransament_lungime_reiser: "1.30",
    teu_dn: "63/32",
    bransament_presiune: "Redusă presiune",
    zona_afectata: "Pietriș",
    distanta_limita: "1 m dreapta",
    sapatura_adancime: "0.90",
    sapatura_latime: "0.50",
    mod_pozare: "îngropat",
    tub_protectie_diametru: "Dn 90",
    tub_protectie_lungime: "1 m",
    tub_protectie_material: "PE100 SDR11",
    robinet_diametru: "1”",
    robinet_bucati: "1",
    rasuflatori_cu_capace: "-",
    rasuflatori_fara_capace: "2",
    cod_atr: `ATR EX-14001122 / ${d(-20)}`,
    ordin_lucru: "EX-50211001",
    data_ol: d(0),
    autorizatie_construire_nr: "EX-61",
    autorizatie_construire_data: d(12),
    autorizatie_construire_valabilitate: fmtRo(addYears(addDays(b, 12), 1)),
    autorizatie_construire_emitent: "Primăria Sectorului 1 (exemplu)",
    proiect_nr: `EX-C301/${y}`,
    planse_nr: "1, 2, 3",
    nr_schema_izometrica: "1",
    data_incepere_executie: d(28),
    pv_predare_data: d(28),
    pv_trasare_data: d(29),
    pv_sapatura_data: d(33),
    pv_asternere_data: d(34),
    pv_montare_data: d(35),
    pv_lansare_data: d(37),
    pv_fir_trasor_data: d(37),
    pv_rezistenta_data: d(40),
    pv_etanseitate_data: d(41),
    pv_control_calitate_data: d(41),
    pv_lucrari_ascunse_data: d(42),
    pv_data: d(49),
    pv_date_diferite: "da",
    data_finalizare_montaj: d(49),
    data_finalizare_lucrari: d(55),
    data_programare_receptie: d(61),
    data_pv_rt: d(63),
    data_pif: d(64),
    pv_predare_nr: "1", pv_trasare_nr: "2", pv_sapatura_nr: "3", pv_asternere_nr: "4", pv_montare_nr: "5",
    pv_lansare_nr: "6", pv_rezistenta_nr: "7", pv_etanseitate_nr: "8", pv_lucrari_ascunse_nr: "9",
    pv_receptie_nr: "10", pv_control_calitate_nr: "11", pv_rt_br_nr: "12", pv_rt_srm_nr: "13", pv_pif_nr: `14/${y}`, pv_pif_srm_nr: "15",
    fisa_racord_nr: `1 / ${y}`,
    fisa_srm_nr: `2 / ${y}`,
    teava_furnizor: "Exemplu Materiale S.R.L.",
    teava_cc_nr: "EX-26011223", teava_cc_data: d(-1),
    teava_dc_nr: "EX-26011999", teava_dc_data: d(-1),
    teava_lot: "EX-26100321",
    reiser_furnizor: "Exemplu Materiale S.R.L.", reiser_lot: `EX-1188/${y}`, firida_tip: "PRM S300",
    regulator_tip: "FE10", regulator_sn: "EX-202611110001",
    documente_materiale: `FACTURA Nr. EX-0000003001 / ${d(-1)};\nCC Nr. EX-26011223 / ${d(-1)};\nDC Nr. EX-26011999 / ${d(-1)}`,
    procedeu_sudura: "Electrofuziune",
    aparat_sudura: "Aparat electrofuziune, seria EX-0026",
    aparat_sudura_ol: "Aparat sudură OL, seria EX-00116",
    procedeu_omologare_pe: `EX-052-946 / ${d(-300)}`,
    procedeu_omologare_ol: "EX-89C-1150",
    bon_predare: "EX-4920001111", bon_predare_data: d(37), alocare_cont: "EX-1960001",
    proba_rezistenta_presiune: "9*10^5", proba_etanseitate_presiune: "6*10^5",
    proba_rezistenta_timp: "80", proba_etanseitate_timp: "70",
    proba_rezistenta_temperatura: "18", proba_etanseitate_temperatura: "18",
    manometru_scala: "0–10 bar", manometru_serie: "EX-DM01-500-2231", manometru_clasa: "0,5", manometru_verif_metrologica: `EX-P-016-${d(-4)}`,
    suduri_lista: "S1, S2, S3",
    osd_punct_lucru: "Mărășești",
    osd_directia: "Direcția Operațională București",
    cod_sap: "EX-24-21-26 / 0311",
    osd_delegat_nume: "Exemplu — Delegat OSD",
    osd_director: "Exemplu — Director Executiv",
    materiale: rows([
      ["Capăt branșament PE-OL", "32", "1", "Exemplu Materiale S.R.L.", `EX-15056/${d(-14)}`, `EX-15056 / ${d(-14)}`],
      ["Țeavă PE", "32", "4", "Exemplu Materiale S.R.L.", `EX-26011223 / ${d(-1)}`, `EX-26011999 / ${d(-1)}`],
      ["Mufă electrofuziune", "32", "2", "Exemplu Materiale S.R.L.", `EX-8417/${d(-20)}`, `EX-8417/${d(-20)}`],
      ["Armătură închidere OL", "1”", "1", "Exemplu Materiale S.R.L.", `EX-26303/${d(-30)}`, `EX-26303/${d(-30)}`],
      ["Tub protecție OL/PVC", "90", "1", "Exemplu Materiale S.R.L.", `EX-26397704/${d(15)}`, `EX-26104315/${d(15)}`],
      ["Teu branșament", "63/32", "1", "Exemplu Materiale S.R.L.", `EX-101747 / ${y}`, `EX-101747 / ${y}`],
      ["Fir trasor", "1.5", "4.5", "Exemplu Materiale S.R.L.", "-", `EX-045717/${d(-60)}`],
      ["Nisip", "-", "-", "Exemplu Materiale S.R.L.", "", "EX-20288-CPR887"],
      ["Cămin armături", "-", "-", "-", "-", "-"],
      ["Răsuflători SV", "-", "-", "-", "-", "-"],
      ["Capace GN", "-", "-", "-", "-", "-"],
    ]),
    materiale_srm: rows([
      ["Țeavă PE", "32", "5.3", "Exemplu Materiale S.R.L.", `EX-26011223 / ${d(-1)}`, `EX-26011999 / ${d(-1)}`],
      ["Armătură închidere OL", "1”", "1", "Exemplu Materiale S.R.L.", `EX-26303/${d(-30)}`, `EX-26303/${d(-30)}`],
      ["Regulator de presiune", "25mm/1”", "1", "Exemplu Materiale S.R.L.", "", "-"],
      ["Contor", "-", "-", "-", "", "-"],
      ["Firidă", "-", "1", "Exemplu Materiale S.R.L.", "", "-"],
    ]),
    schema_materiale: rows([
      ["Teu branșament OL Ø 2”- Ø 1”", "1", "S1"],
      ["Piesă de tranziție OL 1”- PE DN32", "1", "S2"],
      ["Mufă EF Dn 32mm", "2", "S3, S4"],
      ["Țeavă Dn 32 mm", "4.00 ml", "-"],
      ["Cap de branșament DN32mm", "1", "-"],
      ["Robinet cu bilă 1”", "1", "-"],
    ]),
    suduri_tabel: rows([
      ["S1", installer, "EX-000401", "111/BW", "EX-89C-1150"],
      ["S2", installer, "EX-000401", "111/BW", "EX-89C-1150"],
      ["S3", installer, "EX-000402", "SRM / SW", `EX-052-946 / ${d(-300)}`],
      ["S4", installer, "EX-000402", "SRM / SW", `EX-052-946 / ${d(-300)}`],
    ]),
  };
}

/**
 * Dosarul „Exemplu — Carte branșament” pe clientul de exemplu, prin serviciul
 * Dosare (create → echipa → generate), din grupul de sistem Distrigaz. Fără grup
 * (instalare fără șabloane, teste), fără Dosare în abonament sau la o eroare:
 * exemplul rămâne fără dosar.
 * Id-ul se reține imediat după creare, ca ștergerea să-l găsească și dacă pașii
 * următori pică.
 */
async function createSampleDossier(
  fastify: FastifyInstance,
  tenantId: string,
  actorUserId: string | null,
  clientId: string,
  team: Record<TeamKey, string>,
  today: Date,
): Promise<string | null> {
  if (!(await getTenantEntitlements(fastify.prisma, tenantId)).has("documents.dossiers")) return null;
  const group = await fastify.prisma.documentTemplate.findFirst({
    where: { tenantId: null, type: "group", name: SAMPLE_DOSSIER_GROUP_NAME, isActive: true },
    select: { id: true },
  });
  if (!group) return null;

  const names = Object.fromEntries(SAMPLE_TEAM.map((p) => [p.key, personName(p)])) as Record<TeamKey, string>;
  let dossierId: string | null = null;
  try {
    const dossier = await dossiersService.create(
      fastify,
      tenantId,
      createDossierSchema.parse({
        templateGroupId: group.id,
        client: { id: clientId },
        name: SAMPLE_DOSSIER_NAME,
        address: "Str. Exemplu nr. 1",
        city: "București",
        county: "București",
        metadata: sampleDossierMetadata(today, names),
      }),
    );
    dossierId = dossier.id;
    const t = await fastify.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
    const sample = readSampleSettings(t.settingsJson);
    if (sample) await writeSampleSettings(fastify.prisma, tenantId, { ...sample, dossierId });

    const decision = { decizie_nr: "EX-12", decizie_data: fmtRo(addDays(today, -100)) };
    await dossiersService.update(
      fastify,
      tenantId,
      dossierId,
      updateDossierSchema.parse({
        teamMembers: [
          { role: "instalator", employeeId: team.installer },
          { role: "proiectant", employeeId: team.rte },
          { role: "rte", employeeId: team.rte, credentials: decision },
          { role: "sef_santier", employeeId: team.rte, credentials: decision },
          { role: "cq", employeeId: team.iscir },
        ],
      }),
    );
    // Generarea cere un autor (Document.generatedById e opțional, dar serviciul îl ia mereu).
    if (actorUserId) await dossiersService.generate(fastify, tenantId, actorUserId, dossierId);
  } catch (err) {
    fastify.log.warn({ err, tenantId, dossierId }, "sample data: cannot create sample dossier");
  }
  return dossierId;
}

export type DeleteSampleResult = {
  deleted: boolean;
  clientId: string | null;
  appointments: number;
  documents: number;
  registryEntriesVoided: number;
  /** Câți angajați de exemplu s-au șters. */
  employees: number;
  /** Dacă dosarul de exemplu mai exista și a fost șters. */
  dossier: boolean;
};

const NOTHING: Omit<DeleteSampleResult, "clientId"> = {
  deleted: false,
  appointments: 0,
  documents: 0,
  registryEntriesVoided: 0,
  employees: 0,
  dossier: false,
};

/**
 * Șterge datele de exemplu cu tot ce au produs. Cascada Prisma ia adresele,
 * instalația, echipamentele și legăturile ClientDocument; programările (SET NULL
 * la ștergerea clientului) și rândurile Document (fără cascadă dinspre client)
 * se șterg explicit. Intrările din registratură NU se șterg — se anulează
 * (numerele alocate rămân vizibile ca anulate), de către utilizatorul care cere ștergerea.
 *
 * Proiectele făcute pe clientul de exemplu pleacă și ele, cu workflow-uri și sarcini.
 * Echipa de exemplu pleacă cu certificările și ștampilele ei (cascadă) și cu
 * fișierele din S3; dosarul de exemplu, cu documentele lui. Semnatarii impliciți
 * puși de exemplu se golesc doar dacă încă indică un angajat de exemplu (firma
 * poate să-i fi schimbat între timp). Orice parte ștearsă deja manual se sare.
 */
export async function deleteSampleData(
  fastify: FastifyInstance,
  tenantId: string,
  actorUserId: string,
): Promise<DeleteSampleResult> {
  const prisma = fastify.prisma;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
  const sample = readSampleSettings(tenant.settingsJson);
  if (!sample) return { ...NOTHING, clientId: null };

  const [client, dossier, employees] = await Promise.all([
    prisma.client.findFirst({ where: { id: sample.clientId, tenantId }, select: { id: true } }),
    sample.dossierId
      ? prisma.project.findFirst({ where: { id: sample.dossierId, tenantId }, select: { id: true } })
      : Promise.resolve(null),
    sample.employeeIds.length
      ? prisma.employee.findMany({
          where: { id: { in: sample.employeeIds }, tenantId },
          select: { id: true, signatureS3Key: true, stamps: { select: { s3Key: true } } },
        })
      : Promise.resolve([]),
  ]);
  const employeeIds = employees.map((e) => e.id);

  // Tot ce ține de exemplu pleacă în cascadă (cerința lui Alex, 30.10): dosarul de exemplu
  // și orice proiect făcut între timp pe clientul de exemplu, cu workflow-uri, sarcini și
  // documente. Un om de exemplu pus în echipa unui proiect real doar iese din echipă.
  const projectIds = [
    ...new Set([
      ...(dossier ? [dossier.id] : []),
      ...(client
        ? (await prisma.project.findMany({ where: { tenantId, clientId: client.id }, select: { id: true } })).map((p) => p.id)
        : []),
    ]),
  ];

  const appointmentIds =
    client || projectIds.length
      ? (
          await prisma.appointment.findMany({
            where: {
              tenantId,
              OR: [...(client ? [{ clientId: client.id }] : []), ...(projectIds.length ? [{ projectId: { in: projectIds } }] : [])],
            },
            select: { id: true },
          })
        ).map((a) => a.id)
      : [];

  // Documente generate pentru exemplu: cele legate DOAR de client (și de niciun alt
  // proiect decât dosarul de exemplu), produse de programările lui sau de dosar.
  const docs =
    client || projectIds.length
      ? await prisma.document.findMany({
          where: {
            tenantId,
            OR: [
              ...(client ? [{ clients: { some: { clientId: client.id } } }] : []),
              ...(appointmentIds.length ? [{ appointmentId: { in: appointmentIds } }] : []),
              ...(projectIds.length ? [{ projects: { some: { projectId: { in: projectIds } } } }] : []),
            ],
          },
          select: { id: true, s3Key: true, status: true, projects: { select: { projectId: true } }, _count: { select: { clients: true } } },
        })
      : [];
  // Doar documentele care nu țin și de un proiect sau client real.
  const docsToDelete = docs.filter((d) => d.projects.every((p) => projectIds.includes(p.projectId)) && d._count.clients <= 1);
  const docIds = docsToDelete.map((d) => d.id);

  // Worker-ul alocă numărul de registratură și randează PDF-ul la câteva secunde
  // după creare; dacă ștergem în fereastra aceea, rămâne un număr activ fără
  // document. Mai bine un 409 și o nouă încercare peste câteva secunde.
  if (docsToDelete.some((d) => d.status === "PENDING" || d.status === "GENERATING")) {
    throw fastify.httpErrors.conflict("Documentele de exemplu se generează încă — încercați din nou în câteva secunde");
  }

  const result = await prisma.$transaction(async (tx) => {
    const registryScope = [
      ...(client ? [{ clientId: client.id }] : []),
      ...(docIds.length ? [{ documentId: { in: docIds } }] : []),
      ...(projectIds.length ? [{ projectId: { in: projectIds } }] : []),
    ];
    const voided = registryScope.length
      ? await tx.registryEntry.updateMany({
          where: { tenantId, status: "active", OR: registryScope },
          data: {
            status: "voided",
            voidedAt: new Date(),
            voidedById: actorUserId,
            voidReason: "Date de exemplu șterse",
          },
        })
      : { count: 0 };

    // Reviziile de centrală ale programărilor (dacă există) cad cu echipamentul (cascade).
    const deletedDocs = docIds.length ? await tx.document.deleteMany({ where: { id: { in: docIds }, tenantId } }) : { count: 0 };
    const deletedAppts = appointmentIds.length
      ? await tx.appointment.deleteMany({ where: { id: { in: appointmentIds }, tenantId } })
      : { count: 0 };
    // Proiectele de exemplu: workflow-urile (pașii și jurnalul cad în cascadă) și sarcinile
    // întâi; echipa, legăturile ProjectDocument și programările proiectului cad cu proiectul.
    if (projectIds.length) {
      await tx.task.deleteMany({ where: { tenantId, projectId: { in: projectIds } } });
      await tx.workflowInstance.deleteMany({ where: { tenantId, entityId: { in: projectIds } } });
      await tx.project.deleteMany({ where: { tenantId, id: { in: projectIds } } });
    }
    // Un om de exemplu din echipa unui proiect real iese din echipă (rândul ar rămâne gol).
    if (employeeIds.length) await tx.projectTeamMember.deleteMany({ where: { employeeId: { in: employeeIds } } });
    if (client) {
      await tx.task.deleteMany({ where: { tenantId, clientId: client.id } });
      await tx.client.delete({ where: { id: client.id } });
    }
    // Certificările și ștampilele cad în cascadă; programările reale ale lor rămân fără tehnician.
    const deletedEmployees = employeeIds.length
      ? await tx.employee.deleteMany({ where: { id: { in: employeeIds }, tenantId } })
      : { count: 0 };

    // Semnatarii impliciți puși de exemplu — doar dacă încă indică echipa de exemplu.
    const fresh = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
    const settings = { ...((fresh.settingsJson && typeof fresh.settingsJson === "object" ? fresh.settingsJson : {}) as Record<string, unknown>) };
    const signatories = readSignatories(settings);
    let reverted = false;
    for (const role of sample.signatoryRolesSet) {
      const current = signatories[role as SignatoryRole];
      if (current && sample.employeeIds.includes(current)) {
        signatories[role as SignatoryRole] = null;
        reverted = true;
      }
    }
    if (reverted) settings.signatories = signatories;
    delete settings.sample;
    await tx.tenant.update({ where: { id: tenantId }, data: { settingsJson: settings as Prisma.InputJsonValue } });

    return {
      appointments: deletedAppts.count,
      documents: deletedDocs.count,
      registryEntriesVoided: voided.count,
      employees: deletedEmployees.count,
      dossier: !!dossier,
    };
  }, { maxWait: 5_000, timeout: 20_000 });

  // Fișierele din S3 se șterg după commit, best-effort — un fișier orfan e inofensiv.
  const keys = [
    ...docsToDelete.map((d) => d.s3Key),
    ...employees.flatMap((e) => [e.signatureS3Key, ...e.stamps.map((s) => s.s3Key)]),
  ].filter((k): k is string => !!k);
  for (const k of keys) await deleteFile(k).catch(() => {});

  invalidateReadiness(tenantId);
  await invalidateDashboardCache(tenantId);
  return {
    deleted: !!client || result.employees > 0 || result.dossier,
    clientId: client?.id ?? sample.clientId,
    ...result,
  };
}
