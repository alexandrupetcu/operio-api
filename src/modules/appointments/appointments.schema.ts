import { z } from "zod";

export const createAppointmentSchema = z.object({
  projectId: z.string().cuid().optional(),
  clientId: z.string().cuid().optional(),
  employeeId: z.string().cuid().optional(),
  type: z.enum(["general", "revizie", "ridicare_documente"]).default("general"),
  title: z.string().min(1).max(200),
  notes: z.string().optional(),
  date: z.string().datetime(),
  duration: z.number().int().min(1).optional(),
});

export const updateAppointmentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  notes: z.string().optional().nullable(),
  date: z.string().datetime().optional(),
  duration: z.number().int().min(1).optional().nullable(),
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

export const finalizeAppointmentSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("raport_complet"),
    equipmentId: z.string().cuid().optional(),    // existing equipment
    equipmentData: equipmentDataSchema.optional(), // create or update equipment fields
    reportData: reportDataSchema,
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
      duration: z.number().int().min(1).optional(),
      notes: z.string().optional(),
      type: z.enum(["general", "revizie", "ridicare_documente"]).default("general"),
    }),
  }),
]);

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;
export type FinalizeAppointmentInput = z.infer<typeof finalizeAppointmentSchema>;
export type ReportData = z.infer<typeof reportDataSchema>;
