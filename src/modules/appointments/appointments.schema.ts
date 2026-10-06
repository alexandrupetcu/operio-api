import { z } from "zod";
import { gasInstallationInputSchema } from "../clients/clients.schema.js";

export const APPOINTMENT_TYPES = [
  "general",
  "revizie",
  "ridicare_documente",
  "revizie_instalatie",
  "verificare_instalatie",
  "itp",
  "rca",
] as const;

/** Query-ul calendarului. `employeeId` acceptă `me`, `none`, un id sau o listă. */
export const calendarQuerySchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    employeeId: z.string().max(500).optional(),
  })
  .refine(
    (q) => !Number.isNaN(Date.parse(q.from)) && !Number.isNaN(Date.parse(q.to)),
    { message: "from and to must be valid dates" }
  );

/** Verificarea de suprapunere dinaintea salvării. */
export const overlapQuerySchema = z
  .object({
    employeeId: z.string().cuid(),
    date: z.string().min(1),
    duration: z.coerce.number().int().min(5).max(480).optional(),
    excludeId: z.string().cuid().optional(),
  })
  .refine((q) => !Number.isNaN(Date.parse(q.date)), { message: "date must be a valid date" });

export const createAppointmentSchema = z.object({
  projectId: z.string().cuid().optional(),
  clientId: z.string().cuid().optional(),
  clientAddressId: z.string().cuid().optional().nullable(),
  employeeId: z.string().cuid().optional(),
  equipmentId: z.string().cuid().optional().nullable(),
  installationId: z.string().cuid().optional().nullable(),
  // Not .cuid(): vehicle IDs may be seed-generated custom strings (e.g. "seed-vehicle-1").
  vehicleId: z.string().min(1).optional().nullable(),
  type: z.enum(APPOINTMENT_TYPES).default("general"),
  title: z.string().min(1).max(200),
  notes: z.string().optional(),
  date: z.string().datetime(),
  // Minute. Plafonul e folosit de fereastra de căutare a suprapunerilor.
  duration: z.number().int().min(5).max(480).optional(),
});

export const updateAppointmentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().optional().nullable(),
  date: z.string().datetime().optional(),
  duration: z.number().int().min(5).max(480).optional().nullable(),
  employeeId: z.string().cuid().optional().nullable(),
  status: z.enum(["scheduled", "in_progress", "awaiting_report", "completed", "cancelled", "rescheduled"]).optional(),
});

// Checklist item: DA / NU / N/A
const checklistValue = z.enum(["DA", "NU", "NA"]);

const equipmentDataSchema = z.object({
  name: z.string().optional(),
  internalName: z.string().optional(),
  serial: z.string().optional(),
  fuel: z.string().optional(),
  deviceType: z.string().optional(),
  power: z.string().optional(),
  airSupply: z.enum(["aspirat", "insuflat"]).optional(),
  feeding: z.enum(["manuala", "automata"]).optional(),
  location: z.string().optional(),
  fuelIscir: z.string().optional(),
  deviceAge: z.enum(["nou", "vechi"]).optional(),
});

const reportDataSchema = z.object({
  // Sec. II removed — installation data now stored on Equipment model
  verificationType: z.enum(["aparat_nou", "verificare_periodica", "repunere_in_functiune"]).default("verificare_periodica"),
  // Sec. III — Verificare documente
  verificationDocuments: z.object({
    instructions: checklistValue,
    conformityDeclaration: checklistValue,
    thermoMechanicalSchema: checklistValue,
    repairDocumentation: checklistValue,
    fuelNotice: checklistValue,
  }),
  // Sec. IV — Verificare lucrări
  workVerification: z.object({
    installedCorrect: checklistValue,
    repairedCorrect: checklistValue,
    connectionGas: checklistValue,
    connectionElectricity: checklistValue,
    connectionWater: checklistValue,
    flueGas: checklistValue,
    fuelMatch: checklistValue,
    combustionAir: checklistValue,
  }),
  // Sec. V — Verificări funcționale
  functionalVerifications: z.object({
    fuelSealingCheck: checklistValue,
    fuelStaticPressure: z.string().optional(),   // mbar
    waterSealingCheck: checklistValue,
    waterPressureTest: z.string().optional(),    // bar
    waterPressureTime: z.string().optional(),    // minutes
    electricalVoltage: z.string().optional(),    // V
    grounding: checklistValue,
    loadSetting: z.string().optional(),          // %
    draftType: z.enum(["natural", "fortat"]).optional(),
    draftValue: z.string().optional(),           // mbar
    gasPressureRamp: z.string().optional(),
    gasPressureBurner: z.string().optional(),
    gasPressureFocus: z.string().optional(),
    flueGasSealingCheck: checklistValue,
    protectionFunctionsCheck: checklistValue,
    waterPressure: z.string().optional(),        // bar
    waterTempFlow: z.string().optional(),        // ex: "60/40"
    comfortLimits: z.string().optional(),
  }),
  // Sec. VI — Concluzii
  conclusions: z.object({
    decision: z.enum(["admis", "respins"]),
    nextRevisionDate: z.string(),                // ISO date
    observations: z.string().optional(),
  }),
  // Sec. VII — Semnătură client + GDPR
  clientSignature: z.object({
    signatureDataUrl: z.string().optional(),     // PNG base64 data URL
    gdprConsent: z.boolean().default(false),
    gdprConsentAt: z.string().optional(),        // ISO datetime
    clientEmail: z.string().email().optional(),   // to save on client + send docs
  }).optional(),
});

// ── Revizie / Verificare instalație (FISA) report ───────────────────────────
// Per-visit data only; identity (cod tehnic, contract, meter, distributor,
// appliances) lives on GasInstallation, instalator on Employee, operator on Tenant.

const probaSchema = z.object({
  // Legacy — the material is a property of each PV position now (see pvMaterialSchema);
  // still accepted so older clients keep validating.
  material: z.string().optional(),
  amplasare: z.enum(["subteran", "suprateran"]).optional(),
  regim: z.enum(["medie", "redusa", "joasa"]).optional(),
  presiune: z.string().optional(),
  // Unit of `presiune` as filled in the field (rezistență works in bar,
  // etanșeitate in mbar). Documents always print bar — the worker converts.
  presiuneUm: z.enum(["bar", "mbar"]).optional(),
  timp: z.string().optional(),     // MINUTES; documents print hours
  admis: z.boolean().optional(),
});

/** One PV material line item — see MAT_KINDS in instalatie-constants.ts. */
const pvMaterialSchema = z.object({
  kind: z.string().min(1),
  label: z.string().optional(),  // set for operator-defined kinds
  um: z.string().optional(),     // set for operator-defined kinds ("m" | "buc" | "kg")
  material: z.string().optional(),
  diametru: z.string().optional(),
  cantitate: z.string().optional(),
  furnizor: z.string().optional(),
  certificat: z.string().optional(),
});

const aparatDocSchema = z.object({
  aparat: z.string().optional(),       // CT / MA
  debit: z.string().optional(),
  curatareNr: z.string().optional(),
  curatareData: z.string().optional(),
  verificareNr: z.string().optional(),
  verificareData: z.string().optional(),
});

export const instalatieReportSchema = z.object({
  reportKind: z.enum(["revizie_instalatie", "verificare_instalatie"]),
  instalatorEmployeeId: z.string().cuid().optional(),
  // Tabel 1 — selected situation (value from REVIZIE/VERIFICARE_SITUATII)
  situatie: z.string().optional(),
  tipLucrare: z.enum(["individuala", "comuna"]).default("individuala"),
  // Tabel 3 — operations { <opKey>: DA|NU|NA }
  operatiuni: z.record(z.string(), checklistValue).optional(),
  // Tabel 4 — pressure tests (revizie only)
  probaRezistenta: probaSchema.optional(),
  probaEtanseitate: probaSchema.optional(),
  // Tabel 5 — defects
  defecte: z.array(z.object({
    descriere: z.string().optional(),
    remediere: z.string().optional(),
    remediat: z.boolean().optional(),
  })).optional(),
  // Tabel 6 / 8 — technical-conditions conclusions
  conditiiTehniceOk: z.boolean().optional(),
  conditiiObservatii: z.string().optional(),
  tabel8Ok: z.boolean().optional(),
  // Tabel 7 — appliances + cleaning/verification documents
  documenteAparate: z.array(aparatDocSchema).optional(),
  // FORMULAR DE APRECIERE — 5 indicators 1..10
  apreciere: z.object({
    i1: z.number().int().min(1).max(10).optional(),
    i2: z.number().int().min(1).max(10).optional(),
    i3: z.number().int().min(1).max(10).optional(),
    i4: z.number().int().min(1).max(10).optional(),
    i5: z.number().int().min(1).max(10).optional(),
  }).optional(),
  // PV RTIU (revizie only) — materials + consumption points
  pv: z.object({
    acordAccesNr: z.string().optional(),
    proiectNr: z.string().optional(),
    documentatieNr: z.string().optional(),
    // Current shape — any number of positions, of any kind. `kind` is a key from
    // MAT_KINDS or an operator-defined one, in which case `label`/`um` carry its
    // display name and unit. The material is per position: one report can hold a
    // PE100 pipe and a copper one at the same time.
    materiale: z.array(pvMaterialSchema).optional(),
    // Legacy single-row shape (pre-v2 mobile + web wizard) — still accepted and
    // normalised into `materiale` when the document is built.
    teava: z.object({ diametru: z.string().optional(), cantitate: z.string().optional(), furnizor: z.string().optional(), certificat: z.string().optional() }).optional(),
    armaturi: z.object({ diametru: z.string().optional(), cantitate: z.string().optional() }).optional(),
    detector: z.object({ diametru: z.string().optional(), cantitate: z.string().optional() }).optional(),
    conducta: z.enum(["OL", "PE"]).optional(),
  }).optional(),
  // Seal block (revizie only) — drives the conditional Buletin de sigilare.
  // Meter tip/serie/nr/an default from GasInstallation; index + seal nrs are per-visit.
  seal: z.object({
    present: z.boolean().default(false),
    operation: z.enum(["sigilat", "desigilat", "desfiintat"]).optional(),
    nrSigiliu: z.string().optional(),
    contorTip: z.string().optional(),
    contorSeria: z.string().optional(),
    contorNr: z.string().optional(),
    contorAn: z.string().optional(),
    contorIndex: z.string().optional(),
    sigiliuBozContor: z.string().optional(),
    raseInFunctiuneCT: z.string().optional(),
    raseInFunctiuneMA: z.string().optional(),
    resigilatNr: z.string().optional(),
  }).optional(),
  decizie: z.enum(["admis", "respins"]),
  observatii: z.string().optional(),
  nextDate: z.string().optional(),
  clientSignature: z.object({
    signatureDataUrl: z.string().optional(),
    gdprConsent: z.boolean().default(false),
    gdprConsentAt: z.string().optional(),
    clientEmail: z.string().email().optional(),
  }).optional(),
});

export const finalizeAppointmentSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("raport_complet"),
    equipmentId: z.string().cuid().optional(),    // existing equipment (centrala)
    equipmentData: equipmentDataSchema.optional(), // create or update equipment fields
    installationId: z.string().cuid().optional(),  // existing gas installation (instalatie)
    installationData: gasInstallationInputSchema.optional(), // create/update installation
    // Centrala report OR gas-installation FISA report (disambiguated by reportKind / fields)
    reportData: z.union([reportDataSchema, instalatieReportSchema]),
  }),
  z.object({
    outcome: z.literal("revenire"),
    followup: z.object({
      title: z.string().min(1).max(500),
      dueAt: z.string().datetime().optional(),
      description: z.string().optional(),
      assignedUserId: z.string().cuid().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    }),
  }),
  z.object({
    outcome: z.literal("programare_noua"),
    newAppointment: z.object({
      title: z.string().min(1).max(200),
      date: z.string().datetime(),
      // Minute. Plafonul e folosit de fereastra de căutare a suprapunerilor.
  duration: z.number().int().min(5).max(480).optional(),
      notes: z.string().optional(),
      type: z.enum(APPOINTMENT_TYPES).default("general"),
    }),
  }),
]);

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type FinalizeAppointmentInput = z.infer<typeof finalizeAppointmentSchema>;
export type ReportData = z.infer<typeof reportDataSchema>;
export type InstalatieReportData = z.infer<typeof instalatieReportSchema>;
