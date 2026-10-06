import { Worker, type Job } from "bullmq";
import { pathToFileURL } from "node:url";
import { PrismaClient, Prisma } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { getFileStream, uploadFile, getPresignedUrl } from "../lib/s3.js";
import { renderDocx, type ImageRenderOptions } from "../lib/docx-engine.js";
import PizZip from "pizzip";
import { ensureBucket } from "../lib/s3.js";
import puppeteer from "puppeteer";
import { allocateEntryForDocument } from "../modules/registry/registry.service.js";
import { completeStep, failStep } from "../lib/workflow-engine/step-completion.js";
import { OPERATIUNI_LABELS, MAT_KINDS, materialClass } from "../modules/appointments/instalatie-constants.js";
import { resolveStampSlots, stampVarName } from "../lib/stamps.js";
import { readCompanySettings } from "../modules/tenant/company-settings.js";
import { readAlertWindows } from "../modules/tenant/alert-settings.js";
import { buildInstalatieFooterHtml, buildContractFooterHtml, embedFooterMarker, extractPdfMarkers } from "../lib/pdf-footer.js";
import type { FastifyInstance } from "fastify";

/**
 * Fixed sizes (px) + overlay for image variables in DOCX templates.
 * Signature/stamp float "In Front of Text" (overlap the content below, e.g. a
 * signature over a line) at a fixed size so they don't shift surrounding text;
 * the project drawing stays inline. ~96 px/in.
 */
// Team roles whose assigned employee's signature can be placed in a document
// as {%rte_signature}, {%sef_santier_signature}, … (mirrors team-roles.ts).
const TEAM_ROLE_CODES = [
  "instalator", "proiectant", "rte", "sef_santier", "cq", "diriginte", "verificator", "sudor",
];
const SIGNATURE_SIZE: [number, number] = [200, 90]; // ~5.3 × 2.4 cm
const roleSignatureSizes = Object.fromEntries(
  TEAM_ROLE_CODES.map((r) => [`${r}_signature`, SIGNATURE_SIZE] as const),
);

const STAMP_SIZE: [number, number] = [140, 140]; // ~3.7 cm square
// The 4 stamp variables: slot 1 = legacy `tenant_stamp`, slots 2-4 = `tenant_stamp_N`.
const STAMP_VARS = ["tenant_stamp", "tenant_stamp_2", "tenant_stamp_3", "tenant_stamp_4"] as const;
const stampSizes = Object.fromEntries(STAMP_VARS.map((v) => [v, STAMP_SIZE] as const));

const DOCX_IMAGE_OPTS: ImageRenderOptions = {
  sizes: {
    tenant_signature: SIGNATURE_SIZE,
    ...stampSizes,
    tenant_logo: [155, 80],        // ~4.1 × 2.1 cm — letterhead default; matches the
                                   // pre-existing header logo size in carte-bransament templates.
    project_drawing: [560, 360],
    ...roleSignatureSizes,
  },
  defaultSize: [570, 380],
  // Signatures + stamps overlay the content below them ("In Front of Text").
  // tenant_logo stays INLINE — letterhead logos sit in the header flow.
  floatTags: ["tenant_signature", ...STAMP_VARS, ...Object.keys(roleSignatureSizes)],
};

interface ContractContext {
  services?: Array<{ name: string; unit?: string; price?: number }>;
  customServices?: string;
  totalPrice?: number;
  paymentMethod?: string;
  parentContractName?: string;
  parentContractDate?: string;
  addendumNumber?: number;
  modifications?: string;
}

interface DocumentJobData {
  documentId: string;
  tenantId: string;
  projectId?: string;
  clientId?: string;
  templateId: string;
  context?: ContractContext;
  revisionId?: string;
}

const prisma = new PrismaClient();

const DEFAULT_REGISTRY_SERIES = "iesiri";

/**
 * Registry series for a document category, driven by
 * `TemplateCategory.registrySeriesCode` (Registratură dinamică). Falls back to
 * the default outgoing series when unset.
 */
async function resolveSeriesCode(categoryCode: string): Promise<string> {
  const cat = await prisma.templateCategory.findUnique({
    where: { code: categoryCode },
    select: { registrySeriesCode: true },
  });
  return cat?.registrySeriesCode || DEFAULT_REGISTRY_SERIES;
}

/** Allocate an official outgoing-registry number (Registru Ieșiri) for a document. */
async function allocateOutgoingNumber(
  tenantId: string,
  template: { categoryCode: string; name: string },
  clientName: string,
  documentId: string,
  projectId?: string | null,
  clientId?: string | null,
): Promise<{ nr: string; data: string } | null> {
  const seriesCode = await resolveSeriesCode(template.categoryCode);
  try {
    const subject = `${template.name}${clientName ? ` — ${clientName}` : ""}`;
    const entry = await allocateEntryForDocument(prisma, tenantId, null, seriesCode, subject, documentId, projectId, clientId);
    if (!entry) {
      console.warn(`[doc-worker] No registry series '${seriesCode}' for tenant ${tenantId}`);
      return null;
    }
    return { nr: entry.displayNumber, data: entry.createdAt.toLocaleDateString("ro-RO") };
  } catch (err) {
    console.error("[doc-worker] Failed to allocate registry entry:", err);
    return null;
  }
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

type ClientInput = {
  type: string;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  cui: string | null;
  phone: string | null;
  email: string | null;
  addresses: { address: string; city: { name: string } | null; state: { name: string } | null }[];
};

type TenantInput = {
  name: string;
  cui: string | null;
  regCom: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  adminName: string | null;
  iscirNumber: string | null;
  iscirDate: string | null;
  stampS3Key: string | null;
  signatureS3Key: string | null;
  logoS3Key: string | null;
  brandingJson: unknown;
  settingsJson: unknown;
  city: { name: string } | null;
  state: { name: string } | null;
};

/** Build underscore-keyed data for DOCX templates (e.g. client_name, tenant_address) */
function buildClientData(client: ClientInput) {
  const fullName = client.type === "COMPANY"
    ? client.companyName || ""
    : `${client.firstName || ""} ${client.lastName || ""}`.trim();
  return {
    client_name: fullName,
    client_company_name: client.companyName || "",
    client_first_name: client.firstName || "",
    client_last_name: client.lastName || "",
    client_cui: client.cui || "",
    client_type: client.type,
    client_address: client.addresses[0]?.address || "",
    client_city: client.addresses[0]?.city?.name || "",
    client_county: client.addresses[0]?.state?.name || "",
    client_phone: client.phone || "",
    client_email: client.email || "",
  };
}

function buildTenantData(tenant: TenantInput) {
  const data: Record<string, unknown> = {
    tenant_name: tenant.name,
    tenant_cui: tenant.cui || "",
    tenant_reg_com: tenant.regCom || "",
    tenant_address: tenant.address || "",
    tenant_city: tenant.city?.name || "",
    tenant_county: tenant.state?.name || "",
    tenant_phone: tenant.phone || "",
    tenant_email: tenant.email || "",
    tenant_admin_name: tenant.adminName || "",
    tenant_iscir_number: tenant.iscirNumber || "",
    tenant_iscir_date: tenant.iscirDate || "",
  };
  // Pass all 4 stamp slots + signature as image references for DOCX rendering.
  // Slot 1 → {{tenant_stamp}} (legacy), slots 2-4 → {{tenant_stamp_N}}.
  for (const s of resolveStampSlots(tenant)) {
    if (s.s3Key) {
      data[stampVarName(s.slot)] = { s3Key: s.s3Key, mimetype: "image/png" };
    }
  }
  if (tenant.signatureS3Key) {
    data.tenant_signature = { s3Key: tenant.signatureS3Key, mimetype: "image/png" };
  }
  if (tenant.logoS3Key) {
    data.tenant_logo = { s3Key: tenant.logoS3Key, mimetype: "image/png" };
  }
  return data;
}

/** Build contract-specific data from context (services, price, payment method) */
function buildContractData(ctx: ContractContext): Record<string, string> {
  const result: Record<string, string> = {};

  // Single {{services}} variable — combines table + custom text
  const parts: string[] = [];

  if (ctx.services?.length) {
    const rows = ctx.services
      .map(
        (s, i) =>
          `<tr><td style="border:1px solid #ccc;padding:6px;text-align:center">${i + 1}</td>` +
          `<td style="border:1px solid #ccc;padding:6px">${s.name}</td>` +
          `<td style="border:1px solid #ccc;padding:6px;text-align:center">${s.unit || "-"}</td>` +
          `<td style="border:1px solid #ccc;padding:6px;text-align:right">${s.price != null ? s.price.toLocaleString("ro-RO", { minimumFractionDigits: 2 }) : "-"} RON</td></tr>`
      )
      .join("");
    parts.push(
      `<table style="width:100%;border-collapse:collapse;margin:8px 0">` +
      `<thead><tr><th style="border:1px solid #ccc;padding:6px;background:#f5f5f5">Nr.</th>` +
      `<th style="border:1px solid #ccc;padding:6px;background:#f5f5f5">Serviciu</th>` +
      `<th style="border:1px solid #ccc;padding:6px;background:#f5f5f5">Unitate</th>` +
      `<th style="border:1px solid #ccc;padding:6px;background:#f5f5f5">Preț</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`
    );
  }

  if (ctx.customServices) {
    parts.push(`<p style="margin:8px 0">${ctx.customServices.replace(/\n/g, "<br>")}</p>`);
  }

  result.services = parts.join("");

  if (ctx.totalPrice != null) {
    result.total_price = ctx.totalPrice.toLocaleString("ro-RO", { minimumFractionDigits: 2 });
  } else {
    result.total_price = "";
  }

  result.payment_method = ctx.paymentMethod || "";

  // Addendum fields
  result.parent_contract_name = ctx.parentContractName || "";
  result.parent_contract_date = ctx.parentContractDate || "";
  result.addendum_number = ctx.addendumNumber != null ? String(ctx.addendumNumber) : "";
  result.modifications = ctx.modifications ? ctx.modifications.replace(/\n/g, "<br>") : "";

  return result;
}

/** Build template data from appointment completion report (manual ISCIR fields) */
async function buildAppointmentReportData(report: unknown): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!report || typeof report !== "object") return result;

  const r = report as Record<string, any>;
  const chk = (v: unknown) => (v === "DA" ? "X" : " ");
  result.verif_draft_natural = result.verif_draft_fortat = ".....";
  result.verif_water_pressure_fill = result.verif_water_temp_flow_fill = ".....";

  // Verification type (moved from installationDetails to top-level reportData)
  if (r.verificationType) {
    result.verification_type = r.verificationType;
    result.verification_type_aparat_nou = r.verificationType === "aparat_nou" ? "X" : " ";
    result.verification_type_periodica = r.verificationType === "verificare_periodica" ? "X" : " ";
    result.verification_type_repunere = r.verificationType === "repunere_in_functiune" ? "X" : " ";
  }
  // NOTE: installation data (deviceType, power, etc.) now comes from Equipment model via buildRevisionData()
  // Backward compat: if old data had installationDetails, still read it
  if (r.installationDetails) {
    const d = r.installationDetails;
    if (!result.installation_device_type) result.installation_device_type = d.deviceType || "";
    if (!result.installation_power) result.installation_power = d.power || "";
    if (!result.installation_air_supply) result.installation_air_supply = d.airSupply || "";
    if (!result.installation_feeding) result.installation_feeding = d.feeding || "";
    if (!result.installation_location) result.installation_location = d.location || "";
    if (!result.installation_fuel_iscir) result.installation_fuel_iscir = d.fuelIscir || "";
    if (!result.verification_type) result.verification_type = d.verificationType || "";
    if (d.verificationType) {
      result.verification_type_aparat_nou = d.verificationType === "aparat_nou" ? "X" : " ";
      result.verification_type_periodica = d.verificationType === "verificare_periodica" ? "X" : " ";
      result.verification_type_repunere = d.verificationType === "repunere_in_functiune" ? "X" : " ";
    }
  }

  // Sec. III — Documente
  if (r.verificationDocuments) {
    const d = r.verificationDocuments;
    for (const [key, val] of Object.entries(d)) {
      const snake = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
      result[`doc_${snake}_da`] = val === "DA" ? "X" : " ";
      result[`doc_${snake}_nu`] = val === "NU" ? "X" : " ";
      result[`doc_${snake}_na`] = val === "NA" ? "X" : " ";
    }
  }

  // Sec. IV — Verificare lucrări
  if (r.workVerification) {
    const w = r.workVerification;
    for (const [key, val] of Object.entries(w)) {
      const snake = key.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
      result[`work_${snake}_da`] = val === "DA" ? "X" : " ";
      result[`work_${snake}_nu`] = val === "NU" ? "X" : " ";
      result[`work_${snake}_na`] = val === "NA" ? "X" : " ";
    }
  }

  // Sec. V — Verificări funcționale
  if (r.functionalVerifications) {
    const f = r.functionalVerifications;
    result.verif_fuel_sealing = chk(f.fuelSealingCheck);
    result.verif_fuel_static_pressure = f.fuelStaticPressure || "";
    result.verif_water_sealing = chk(f.waterSealingCheck);
    result.verif_water_pressure_test = f.waterPressureTest || "";
    result.verif_water_pressure_time = f.waterPressureTime || "";
    result.verif_electrical_voltage = f.electricalVoltage || "";
    result.verif_grounding = chk(f.grounding);
    result.verif_load_setting = f.loadSetting || "";
    result.verif_draft_type = f.draftType === "fortat" ? "forțat" : f.draftType || "";
    result.verif_draft_value = f.draftValue || "";
    // "Tiraj: ..... natural / forțat ..... (mbar)" — the value fills the dots next to the chosen type.
    const draftFill = (type: string) =>
      f.draftType === type && f.draftValue ? `<span class="f">${f.draftValue}</span>` : ".....";
    result.verif_draft_natural = draftFill("natural");
    result.verif_draft_fortat = draftFill("fortat");
    result.verif_gas_pressure_ramp = f.gasPressureRamp || "";
    result.verif_gas_pressure_burner = f.gasPressureBurner || "";
    result.verif_gas_pressure_focus = f.gasPressureFocus || "";
    result.verif_flue_gas_sealing = chk(f.flueGasSealingCheck);
    result.verif_protection_functions = chk(f.protectionFunctionsCheck);
    result.verif_water_pressure = f.waterPressure || "";
    result.verif_water_temp_flow = f.waterTempFlow || "";
    // "Apă ..... / Apă tur/retur ....." — value in place of the dots when recorded.
    const dotFill = (v: unknown) => (v ? `<span class="f">${v}</span>` : ".....");
    result.verif_water_pressure_fill = dotFill(f.waterPressure);
    result.verif_water_temp_flow_fill = dotFill(f.waterTempFlow);
    result.verif_comfort_limits = f.comfortLimits || "";
  }

  // Sec. VI — Concluzii
  if (r.conclusions) {
    const c = r.conclusions;
    result.decision = c.decision || "";
    result.decision_admis = chk(c.decision === "admis" ? "DA" : null);
    result.decision_respins = chk(c.decision === "respins" ? "DA" : null);
    if (c.nextRevisionDate) {
      result.next_revision_date = new Date(c.nextRevisionDate).toLocaleDateString("ro-RO");
    }
    result.observations = c.observations || "";
  }

  // Client signature from S3
  if (r.clientSignature?.signatureS3Key) {
    try {
      const stream = await getFileStream(r.clientSignature.signatureS3Key);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      const base64 = buf.toString("base64");
      result.client_signature = `<img src="data:image/png;base64,${base64}" style="max-height:60px">`;
    } catch {
      result.client_signature = "";
    }
  }

  return result;
}

/** Build revision-specific template data from EquipmentRevision record */
function buildRevisionData(revision: {
  revisionDate: Date;
  operatorName: string | null;
  operatorAddress: string | null;
  operatorPhone: string | null;
  operatorEmail: string | null;
  analyzerName: string | null;
  analyzerSerial: string | null;
  location: string | null;
  pdfEquipmentName: string | null;
  pdfEquipmentSerial: string | null;
  analysisData: unknown;
  equipment: {
    name: string | null;
    serial: string | null;
    fuel: string | null;
    deviceType: string | null;
    power: string | null;
    airSupply: string | null;
    feeding: string | null;
    location: string | null;
    fuelIscir: string | null;
    deviceAge: string | null;
  } | null;
}, revisionIntervalYears = 2): Record<string, string> {
  const result: Record<string, string> = {};
  const readings = (revision.analysisData as Record<string, unknown>)?.readings as Record<string, string> | undefined;

  result.revision_date = revision.revisionDate.toLocaleDateString("ro-RO");
  // Next-revision date follows the tenant's configured revision interval
  // (settingsJson.alertWindows.revisionIntervalYears) — kept in sync with the
  // dashboard's expiring-revisions window.
  const nextDue = new Date(revision.revisionDate);
  nextDue.setFullYear(nextDue.getFullYear() + revisionIntervalYears);
  result.next_revision_date = nextDue.toLocaleDateString("ro-RO");
  result.location = revision.location || "";
  result.operator_name = revision.operatorName || "";
  result.operator_address = revision.operatorAddress || "";
  result.operator_phone = revision.operatorPhone || "";
  result.operator_email = revision.operatorEmail || "";
  result.analyzer_name = revision.analyzerName || "";
  result.analyzer_serial = revision.analyzerSerial || "";
  result.equipment_name = revision.pdfEquipmentName || revision.equipment?.name || "";
  result.equipment_serial = revision.pdfEquipmentSerial || revision.equipment?.serial || "";
  result.fuel = revision.equipment?.fuel || (revision.analysisData as Record<string, string>)?.combustibil || "";

  // Installation data from Equipment model
  const eq = revision.equipment;
  if (eq) {
    result.installation_device_type = eq.deviceType || "";
    result.installation_power = eq.power || "";
    result.installation_air_supply = eq.airSupply || "";
    result.installation_feeding = eq.feeding || "";
    result.installation_location = eq.location || "";
    result.installation_fuel_iscir = eq.fuelIscir || "";
    result.device_age_nou = eq.deviceAge === "nou" ? "X" : " ";
    result.device_age_vechi = eq.deviceAge === "vechi" ? "X" : " ";
  }

  // Analysis readings
  if (readings) {
    result.readings_t_gaz = readings.tGaz || readings["T gaz"] || "";
    result.readings_t_aer = readings.tAer || readings["T aer"] || "";
    result.readings_o2 = readings.o2 || readings["O2"] || "";
    result.readings_co2 = readings.co2 || readings["CO2"] || "";
    result.readings_co = readings.co || readings["CO"] || "";
    result.readings_ec = readings.ec || readings["Ec"] || "";
    result.readings_lambda = readings.lambda || readings["Lambda"] || "";
    result.readings_excess_air = readings.excessAir || readings["Excess Air"] || "";
    result.readings_delta_t = readings.dT || readings.deltaT || readings["ΔT"] || "";
    result.readings_qs = readings.qs || readings["Qs"] || "";
    result.readings_es = readings.es || readings["Es"] || "";
    result.readings_et = readings.et || readings["Et"] || "";
    result.readings_no = readings.no || readings["NO"] || "";
    result.readings_nox = readings.nox || readings["NOx"] || "";
    result.readings_pi = readings.pi || readings["PI"] || "";
  }

  return result;
}

/**
 * Build flat HTML template vars from a gas-installation FISA report
 * (revizie/verificare instalație). Precomputes ALL conditional cells (the "X"
 * marks, decision, seal) and repeated tables as HTML strings, because
 * `renderHtml` is a plain {{key}} substitution with no logic.
 */
export async function buildInstalatieReportData(
  reportRaw: unknown,
  installation: Record<string, any> | null,
  instalator: Record<string, any> | null,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!reportRaw || typeof reportRaw !== "object") return out;
  const r = reportRaw as Record<string, any>;
  const X = (b: unknown) => (b ? "X" : " ");
  const s = (v: unknown) => (v == null ? "" : String(v));
  // Operator-typed values (material, supplier, certificate) go straight into the
  // rendered HTML — escape them so a stray "<" can't break a table.
  const esc = (v: unknown) =>
    s(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const cell = (v: string, align = "left") =>
    `<td style="border:1px solid #ccc;padding:5px;text-align:${align}">${v}</td>`;

  // Defaults for the RT dual-aparate grid when no installation is linked:
  // one empty body row, "9"/label cells span 2 headers + 1 row.
  out.aparate_dual_table =
    `<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
  out.aparate_dual_rowspan = "3";
  // Physical appliance list (entries expanded by count) — one unit per element.
  // Feeds Tabel 7, where each unit carries its own document numbers.
  const expandedApps: { label: string; debit: string }[] = [];

  // ── Installation identity (from GasInstallation) ──
  if (installation) {
    out.inst_distributor = s(installation.distributorName);
    out.inst_cod_pod = s(installation.codTehnicPOD);
    out.inst_cod_client = s(installation.codClient);
    out.inst_contract_nr = s(installation.contractNumber);
    out.inst_contract_data = s(installation.contractDate);
    out.inst_documentatie_nr = s(installation.documentatieNr);
    out.inst_documentatie_data = s(installation.documentatieData);
    out.inst_contor_tip = s(installation.contorTip);
    out.inst_contor_seria = s(installation.contorSeria);
    out.inst_contor_nr = s(installation.contorNr);
    out.inst_contor_an = s(installation.contorAn);
    out.inst_contor_index = s(installation.contorIndex);
    // Installation-specific address override: when the gas installation is linked
    // to a ClientAddress different from the client's primary, prefer the installation
    // address on the rendered PDFs (RT/PV/FISA reference the place of consumption).
    const instAddr = installation.clientAddress as
      | { address?: string | null; label?: string | null; city?: { name?: string } | null; state?: { name?: string } | null }
      | null
      | undefined;
    if (instAddr) {
      if (instAddr.address) out.client_address = instAddr.address;
      if (instAddr.city?.name) out.client_city = instAddr.city.name;
      if (instAddr.state?.name) out.client_county = instAddr.state.name;
    }
    // Contract "Amplasament / loc consum (dacă diferă)" checkboxes: DA when the
    // installation carries its own consumption address, NU otherwise.
    out.amplasament_da = instAddr?.address ? "X" : "...";
    out.amplasament_nu = instAddr?.address ? "..." : "X";
    const apps = Array.isArray(installation.appliancesJson) ? installation.appliancesJson : [];
    out.inst_aparate_table = apps
      .map((a: any, i: number) =>
        `<tr>${cell(String(i + 1), "center")}` +
        cell(`${a.count ? a.count + " x " : ""}${s(a.kind)}${a.name ? " — " + s(a.name) : ""}`) +
        `${cell(s(a.debit), "center")}</tr>`
      )
      .join("");

    // Dual "Notificate de furnizor" (blank) vs "Identificate la locul de consum"
    // (filled from appliancesJson) grid for the faithful RT template. 8-column
    // rows: 4 Notificate cells (blank) + 4 Identificate cells (first Tip/Debit filled).
    // Row count is DYNAMIC — one row per appliance (min 1 so the grid renders).
    // The template's "9"/label cells span 2 header rows + the body rows, so the
    // rowspan is emitted alongside the fragment.
    const nDual = Math.max(1, apps.length);
    const dualRows: string[] = [];
    for (let i = 0; i < nDual; i++) {
      const a = apps[i];
      const tip = a ? `<span class="f">${a.count ? a.count + " x " : ""}${s(a.kind)}</span>` : "";
      const deb = a ? `<span class="f">${s(a.debit)}</span>` : "";
      dualRows.push(
        `<tr><td></td><td></td><td></td><td></td><td class="c">${tip}</td><td class="c">${deb}</td><td></td><td></td></tr>`
      );
    }
    out.aparate_dual_table = dualRows.join("");
    out.aparate_dual_rowspan = String(2 + nDual);

    // Expand entries by count: {kind:"MA", count:2} → two physical units.
    for (const a of apps) {
      const n = Math.max(1, Number(a.count) || 1);
      for (let k = 0; k < n; k++) {
        expandedApps.push({
          label: `${s(a.kind)}${a.name ? " — " + s(a.name) : ""}`,
          debit: s(a.debit),
        });
      }
    }

    // PV "puncte de consum" grid (client form): Nr | Denumire | Caracteristici |
    // Debit unitar | buc | Debit total | Certificat — padded to 3 rows.
    const pcRows: string[] = [];
    for (let i = 0; i < Math.max(3, apps.length); i++) {
      const a = apps[i];
      const den = a
        ? `<span class="f">${a.count ? a.count + " x " : ""}${esc(a.name || s(a.kind))}</span>`
        : "";
      const unit = a ? `<span class="f">${s(a.debit)}</span>` : "";
      const buc = a ? `<span class="f">${s(a.count ?? 1)}</span>` : "";
      const totNum = a ? Number(String(a.debit ?? "").replace(",", ".")) * (Number(a.count) || 1) : NaN;
      const tot = a ? `<span class="f">${Number.isFinite(totNum) ? String(totNum) : s(a.debit)}</span>` : "";
      pcRows.push(
        `<tr><td class="c b">${a ? i + 1 : "&nbsp;"}</td><td>${den}</td><td></td><td class="c">${unit}</td><td class="c">${buc}</td><td class="c">${tot}</td><td></td></tr>`
      );
    }
    out.pv_puncte_consum_table = pcRows.join("");
  }

  // ── Periodicity / type of work / situation (Tabel 1-2) ──
  out.periodicitate = r.reportKind === "revizie_instalatie" ? "10 ani" : "2 ani";
  out.tip_individuala = X(r.tipLucrare !== "comuna");
  out.tip_comuna = X(r.tipLucrare === "comuna");
  for (const v of ["interval_10_ani", "intrerupere_6_luni", "eveniment", "cerere_client", "interval_2_ani"]) {
    out[`situatie_${v}`] = X(r.situatie === v);
  }

  // ── Tabel 3 — operations (all keys, default blank) ──
  const ops = r.operatiuni && typeof r.operatiuni === "object" ? r.operatiuni : {};
  for (const key of Object.keys(OPERATIUNI_LABELS)) {
    const v = ops[key];
    out[`op_${key}_da`] = X(v === "DA");
    out[`op_${key}_nu`] = X(v === "NU");
    out[`op_${key}_na`] = X(v === "NA");
  }

  // ── PV positions (needed by both Tabel 4 and the PV document) ──
  // Any number of line items, of any kind. Reports written before the line-item
  // model carry the fixed țeavă/armături/detector trio instead; normalise those
  // into the same shape so a single renderer covers both.
  const pv = r.pv || {};
  const pvPositions: Record<string, any>[] = Array.isArray(pv.materiale)
    ? pv.materiale
    : [
        pv.teava && { kind: "teava", material: pv.conducta === "PE" ? "PE100" : pv.conducta === "OL" ? "OL (oțel)" : "", ...pv.teava },
        pv.armaturi && { kind: "armatura", ...pv.armaturi },
        pv.detector && { kind: "detector", ...pv.detector },
      ].filter(Boolean) as Record<string, any>[];

  // The tested pipe's material: distinct materials of the pipe positions (țeavă,
  // tub) — a report may legitimately carry more than one. Falls back to the
  // probe's own material for reports written before the line-item model.
  const pipeMaterials: string[] = [];
  for (const m of pvPositions) {
    const kind = s(m.kind);
    if (kind !== "teava" && kind !== "tub") continue;
    const mat = s(m.material);
    if (mat && !pipeMaterials.includes(mat)) pipeMaterials.push(mat);
  }
  const probeMaterial = (p: any) => pipeMaterials[0] || s(p?.material);

  // ── Tabel 4 — pressure tests (revizie) ──
  // Field units vs document units: the wizard records the pressure in bar or
  // mbar (`presiuneUm`, default bar) and the duration in MINUTES; both RT and PV
  // print bar and hours. Convert here so the forms stay natural to fill in.
  const roNum = (n: number) =>
    (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)).replace(".", ",");
  const probaBar = (p: any): string => {
    const raw = Number(String(p?.presiune ?? "").replace(",", "."));
    if (!Number.isFinite(raw)) return s(p?.presiune);
    return roNum(String(p?.presiuneUm) === "mbar" ? raw / 1000 : raw);
  };
  const probaOre = (p: any): string => {
    const min = Number(String(p?.timp ?? "").replace(",", "."));
    if (!Number.isFinite(min)) return s(p?.timp);
    return roNum(min / 60);
  };

  const proba = (p: any, prefix: string) => {
    out[`${prefix}_material`] = esc(probeMaterial(p));
    out[`${prefix}_amplasare`] = s(p?.amplasare);
    out[`${prefix}_regim`] = s(p?.regim);
    out[`${prefix}_presiune`] = probaBar(p);
    out[`${prefix}_timp`] = probaOre(p);
    out[`${prefix}_admis`] = X(p?.admis === true);
    out[`${prefix}_respins`] = X(p?.admis === false);
  };
  proba(r.probaRezistenta, "proba_rez");
  proba(r.probaEtanseitate, "proba_et");

  // Faithful Tabel 4 grid: columns OL(subteran|suprateran), PE100(subteran),
  // PE80(subteran); regim rows medie/redusa/joasa. The model holds ONE proba
  // object per kind → it fills exactly one column+regim cell; the rest blank.
  const PROBA_COLS = ["ol_sub", "ol_supra", "pe100_sub", "pe80_sub"] as const;
  const PROBA_REGIMS = ["medie", "redusa", "joasa"] as const;
  // The material now comes from the PV positions (the form no longer asks the
  // probe for one). Exact matches take their own column; anything else falls
  // back on its class — metals (cupru, inox) behave as OL, plastics as PE100.
  const colOf = (material: unknown, amplasare: unknown): string | null => {
    const m = String(material ?? "").trim();
    const a = String(amplasare ?? "").toLowerCase();
    if (!m) return null;
    const up = m.toUpperCase();
    if (up === "PE100") return "pe100_sub";
    if (up === "PE80") return "pe80_sub";
    if (up.startsWith("OL")) return a === "suprateran" ? "ol_supra" : "ol_sub";
    return materialClass(m) === "PE" ? "pe100_sub" : a === "suprateran" ? "ol_supra" : "ol_sub";
  };
  const probaGrid = (p: any, prefix: string) => {
    for (const col of PROBA_COLS) {
      for (const reg of PROBA_REGIMS) out[`${prefix}_${col}_${reg}`] = "";
      out[`${prefix}_${col}_admis`] = "";
      out[`${prefix}_${col}_respins`] = "";
    }
    if (!p) return;
    const col = colOf(probeMaterial(p), p.amplasare);
    const reg = String(p.regim ?? "").toLowerCase();
    if (col && (PROBA_REGIMS as readonly string[]).includes(reg)) {
      out[`${prefix}_${col}_${reg}`] = `<span class="f">${probaBar(p)}</span>`;
    }
    if (col) {
      out[`${prefix}_${col}_admis`] = X(p.admis === true);
      out[`${prefix}_${col}_respins`] = X(p.admis === false);
    }
  };
  probaGrid(r.probaRezistenta, "proba_rez");
  probaGrid(r.probaEtanseitate, "proba_et");

  // ── Tabel 5 — defects (padded to 2 rows like the client form) ──
  const defecte = Array.isArray(r.defecte) ? r.defecte : [];
  const defRows = [...defecte];
  while (defRows.length < 2) defRows.push({});
  out.defecte_table = defRows
    .map((d: any, i: number) =>
      `<tr style="height:28px">${cell(String(i + 1) + ".", "center")}${cell(s(d.descriere) || "&nbsp;")}${cell(s(d.remediere) || "&nbsp;")}` +
      `${cell(X(d.remediat === true), "center")}${cell(X(d.remediat === false), "center")}</tr>`
    )
    .join("");

  // ── Tabel 6 / 8 — technical conditions ──
  out.conditii_da = X(r.conditiiTehniceOk === true);
  out.conditii_nu = X(r.conditiiTehniceOk === false);
  out.conditii_observatii = s(r.conditiiObservatii);
  out.tabel8_da = X(r.tabel8Ok === true);
  out.tabel8_nu = X(r.tabel8Ok === false);

  // ── Tabel 7 — appliances + cleaning/verification documents ──
  // One row per PHYSICAL appliance (installation entries expanded by count, so
  // 2xMA + 2xCT → 4 rows), each unit carrying its own document numbers.
  // Aparat/debit prefill from the installation; document numbers come from the
  // report's `documenteAparate` rows when present (matched by index). Min 1 row.
  const docs = Array.isArray(r.documenteAparate) ? r.documenteAparate : [];
  const nT7 = Math.max(expandedApps.length, docs.length, 1);
  const fcell = (v: string, align = "center") =>
    cell(v ? `<span class="f">${v}</span>` : "&nbsp;", align);
  const t7Rows: string[] = [];
  for (let i = 0; i < nT7; i++) {
    const d: any = docs[i] ?? {};
    const a = expandedApps[i];
    const aparat = s(d.aparat) || (a ? a.label : "");
    const debit = s(d.debit) || (a ? a.debit : "");
    t7Rows.push(
      `<tr style="height:24px">${cell(aparat || debit ? String(i + 1) : "&nbsp;", "center")}` +
      `${fcell(aparat, "left")}${fcell(debit)}` +
      `${fcell(s(d.curatareNr))}${fcell(s(d.curatareData))}` +
      `${fcell(s(d.verificareNr))}${fcell(s(d.verificareData))}</tr>`
    );
  }
  out.documente_aparate_table = t7Rows.join("");

  // ── Appreciation form ──
  const ap = r.apreciere || {};
  let sum = 0, cnt = 0;
  for (let i = 1; i <= 5; i++) {
    const v = ap[`i${i}`];
    out[`apreciere_i${i}`] = s(v);
    if (typeof v === "number") { sum += v; cnt++; }
    // Faithful 1..10 scale: each score its own bordered table cell (client form
    // style), the chosen one circled. Emitted as a run of <td>s spliced into
    // the template's 12-column apreciere row.
    const scale: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const chosen = v === n;
      const inner = chosen
        ? `<span style="display:inline-block;min-width:14px;border:1px solid #000;border-radius:50%;font-weight:700;color:var(--fill)">${n}</span>`
        : String(n);
      scale.push(`<td class="c" style="padding:1px!important">${inner}</td>`);
    }
    out[`apreciere_scale_i${i}`] = scale.join("");
  }
  out.apreciere_grad = cnt ? (sum / cnt).toFixed(0) : "";

  // ── Instalator autorizat (from Employee.credentials) ──
  if (instalator) {
    const cred = instalator.credentials && typeof instalator.credentials === "object" ? instalator.credentials : {};
    out.instalator_nume = `${s(instalator.firstName)} ${s(instalator.lastName)}`.trim();
    out.instalator_legitimatie = s(cred.legitimatie);
    out.instalator_tip = s(cred.tip) || "EGIU";
    out.instalator_autorizatie = s(cred.autorizatie);
    out.instalator_valabilitate = s(cred.valabilitate);
    out.instalator_an = s(cred.anul);
  }

  // ── PV materials (revizie) ──
  out.pv_acord_acces = s(pv.acordAccesNr);
  out.pv_proiect_nr = s(pv.proiectNr);
  out.pv_documentatie_nr = s(pv.documentatieNr) || out.inst_documentatie_nr || "";

  const kindLabel = (m: Record<string, any>) =>
    s(m.label) || MAT_KINDS[s(m.kind)]?.label || s(m.kind);
  const kindUm = (m: Record<string, any>) => s(m.um) || MAT_KINDS[s(m.kind)]?.um || "buc";

  // Point 5 table — one row per position. Empty positions (no quantity, no
  // material) are dropped so a half-filled draft doesn't print blank rows.
  const pvRows = pvPositions
    .filter((m) => s(m.cantitate) || s(m.material) || s(m.diametru) || s(m.furnizor))
    .map((m) => {
      const cantitate = s(m.cantitate) ? `${esc(m.cantitate)} ${esc(kindUm(m))}` : "";
      return (
        `<tr><td class="b f">${esc(kindLabel(m))}</td>` +
        `<td class="c f">${esc(m.diametru)}</td>` +
        `<td class="c f">${cantitate}</td>` +
        `<td class="c f">${esc(m.furnizor)}</td>` +
        `<td class="c f">${esc(m.certificat)}</td></tr>`
      );
    });
  // Keep the table from collapsing on an empty report — the printed PV is signed
  // on site and the blank rows are filled by hand.
  while (pvRows.length < 3) {
    pvRows.push(`<tr><td class="b f">&nbsp;</td><td></td><td></td><td></td><td></td></tr>`);
  }
  out.pv_materiale_table = pvRows.join("");

  // Points 10/11 (OL izolație / PE îmbinări) — no longer a form field; derived
  // from the materials actually used.
  const classes = new Set(
    pvPositions.filter((m) => s(m.material)).map((m) => materialClass(s(m.material))),
  );
  out.pv_conducta_ol = X(classes.has("OL"));
  out.pv_conducta_pe = X(classes.has("PE"));

  // PV points 7-9: the client form has separate sections for the SUPRATERAN and
  // SUBTERAN pipe. The report holds one rezistență+etanșeitate pair — route it
  // into the section matching the tested pipe's amplasare; the other stays blank.
  const loc = String(r.probaRezistenta?.amplasare ?? r.probaEtanseitate?.amplasare ?? "").toLowerCase();
  // The pipe passes only if BOTH tests that were performed passed — one failed
  // test cannot be printed as ADMIS.
  const verdicts = [r.probaRezistenta?.admis, r.probaEtanseitate?.admis].filter(
    (v) => typeof v === "boolean",
  ) as boolean[];
  const rezultatTxt = verdicts.length === 0 ? "" : verdicts.every(Boolean) ? "ADMIS" : "RESPINS";
  // Pipe material comes from the PV positions (see probeMaterial above); several
  // materials in the same report are printed together.
  const pipeMaterial = esc(
    pipeMaterials.join(" + ") || s(r.probaRezistenta?.material ?? r.probaEtanseitate?.material),
  );
  for (const key of ["sup", "sub"]) {
    const active = (key === "sup") === (loc !== "subteran"); // default to supraterană
    out[`pv_${key}_material`] = active ? pipeMaterial : "";
    // "X 10⁵ Pa" and "ore" on the form — same conversion as Tabel 4.
    out[`pv_${key}_rez_presiune`] = active ? probaBar(r.probaRezistenta) : "";
    out[`pv_${key}_rez_timp`] = active ? probaOre(r.probaRezistenta) : "";
    out[`pv_${key}_et_presiune`] = active ? probaBar(r.probaEtanseitate) : "";
    out[`pv_${key}_et_timp`] = active ? probaOre(r.probaEtanseitate) : "";
    out[`pv_${key}_rezultat`] = active ? rezultatTxt : "---";
  }

  // ── Seal block (buletin de sigilare) ──
  const seal = r.seal || {};
  out.seal_sigilat = X(seal.operation === "sigilat");
  out.seal_desigilat = X(seal.operation === "desigilat");
  out.seal_desfiintat = X(seal.operation === "desfiintat");
  out.seal_nr_sigiliu = s(seal.nrSigiliu);
  out.seal_contor_tip = s(seal.contorTip) || out.inst_contor_tip || "";
  out.seal_contor_seria = s(seal.contorSeria) || out.inst_contor_seria || "";
  out.seal_contor_nr = s(seal.contorNr) || out.inst_contor_nr || "";
  out.seal_contor_an = s(seal.contorAn) || out.inst_contor_an || "";
  out.seal_contor_index = s(seal.contorIndex) || out.inst_contor_index || "";
  out.seal_boz = s(seal.sigiliuBozContor);
  out.seal_ramas_ct = s(seal.raseInFunctiuneCT);
  out.seal_ramas_ma = s(seal.raseInFunctiuneMA);
  out.seal_resigilat_nr = s(seal.resigilatNr);

  // ── Decision ──
  out.decizie_admis = X(r.decizie === "admis");
  out.decizie_respins = X(r.decizie === "respins");
  out.observatii = s(r.observatii);
  // Clients send the deadline as ISO (web date input) or dd.MM.yyyy (mobile);
  // documents always print the Romanian format.
  const roDate = (v: unknown) => {
    const raw = s(v);
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return iso ? `${iso[3]}.${iso[2]}.${iso[1]}` : raw;
  };
  out.next_date = roDate(r.nextDate);
  // Notificare dates on the RT header grid (no dedicated data source yet):
  // scadența defaults to the next-revision date; last-revision stays hand-fill.
  out.notif_ultima_revizie = roDate(r.notifUltimaRevizie);
  out.notif_scadenta = roDate(r.notifScadenta) || roDate(r.nextDate);

  // ── Client signature (from stored report S3 key) ──
  const sigKey = r.clientSignature?.signatureS3Key;
  if (sigKey) {
    try {
      const stream = await getFileStream(sigKey);
      if (stream) {
        const buf = await streamToBuffer(stream);
        out.client_signature = inkOverlay(
          `<img src="data:image/png;base64,${buf.toString("base64")}" style="height:48px">`
        );
      }
    } catch { /* keep default placeholder */ }
  }

  return out;
}

/** Build dot-notation data for HTML templates (e.g. client.fullName, tenant.address) */
async function buildHtmlTemplateData(
  client: ClientInput | null,
  tenant: TenantInput,
  documentId: string,
): Promise<Record<string, string>> {
  const data: Record<string, string> = {
    // Document
    "document.number": documentId.slice(-8).toUpperCase(),
    "document.date": new Date().toLocaleDateString("ro-RO"),
    // Tenant
    "tenant.name": tenant.name,
    "tenant.cui": tenant.cui || "",
    "tenant.regCom": tenant.regCom || "",
    "tenant.address": tenant.address || "",
    "tenant.city": tenant.city?.name || "",
    "tenant.county": tenant.state?.name || "",
    "tenant.phone": tenant.phone || "",
    "tenant.email": tenant.email || "",
    "tenant.adminName": tenant.adminName || "",
    // Also provide underscore versions so the same editor variables work in HTML
    "tenant_name": tenant.name,
    "tenant_cui": tenant.cui || "",
    "tenant_reg_com": tenant.regCom || "",
    "tenant_address": tenant.address || "",
    "tenant_city": tenant.city?.name || "",
    "tenant_county": tenant.state?.name || "",
    "tenant_phone": tenant.phone || "",
    "tenant_email": tenant.email || "",
    "tenant_admin_name": tenant.adminName || "",
    "tenant_iscir_number": tenant.iscirNumber || "",
    "tenant_iscir_date": tenant.iscirDate || "",
    // Firm-constant fields for official gas-installation docs (settingsJson.company)
    ...(() => {
      const c = readCompanySettings(tenant.settingsJson);
      return {
        "tenant_anre_nr": c.anreNr,
        "tenant_anre_tip": c.anreTip,
        "tenant_anre_data": c.anreData,
        "tenant_anre_exp": c.anreExp,
        "tenant_iban": c.iban,
        "tenant_bank": c.bank,
        "tenant_operator_sistem": c.operatorSistem,
      };
    })(),
    // Date
    "date": new Date().toLocaleDateString("ro-RO"),
    "year": new Date().getFullYear().toString(),
  };

  // Company logo for the HTML path (DOCX path handles it separately in buildTenantData).
  if (tenant.logoS3Key) {
    const logoUrl = await getPresignedUrl(tenant.logoS3Key);
    data["tenant_logo"] = `<img src="${logoUrl}" alt="Logo" style="max-height:60px;max-width:180px;object-fit:contain">`;
  }

  // Generate presigned URLs for stamp & signature
  let stampUrl: string | null = null;
  let signatureUrl: string | null = null;

  if (tenant.stampS3Key) {
    stampUrl = await getPresignedUrl(tenant.stampS3Key);
    data["tenant.stampUrl"] = stampUrl;
  }
  if (tenant.signatureS3Key) {
    signatureUrl = await getPresignedUrl(tenant.signatureS3Key);
    data["tenant.signatureUrl"] = signatureUrl;
  }

  // Compose stamp & signature: signature centered on top of stamp, slightly right.
  // Only slot 1 (tenant_stamp) is composited with the signature; slots 2-4 render plain.
  if (stampUrl && signatureUrl) {
    const composed = [
      `<span style="position:relative;display:inline-block">`,
      `<img src="${stampUrl}" alt="Ștampilă" style="height:100px">`,
      `<img src="${signatureUrl}" alt="Semnătură" style="position:absolute;top:80%;left:95%;transform:translate(-50%,-50%);height:75px">`,
      `</span>`,
    ].join("");
    data["tenant_stamp"] = inkOverlay(composed);
    data["tenant_signature"] = inkOverlay(composed);
  } else if (stampUrl) {
    data["tenant_stamp"] = inkOverlay(`<img src="${stampUrl}" alt="Ștampilă" style="height:100px">`);
  } else if (signatureUrl) {
    data["tenant_signature"] = inkOverlay(`<img src="${signatureUrl}" alt="Semnătură" style="height:75px">`);
  }

  // Stamp slots 2-4 → overlaid ink for the HTML render path.
  for (const s of resolveStampSlots(tenant)) {
    if (s.slot === 1 || !s.s3Key) continue;
    const url = await getPresignedUrl(s.s3Key);
    data[stampVarName(s.slot)] = inkOverlay(`<img src="${url}" alt="${s.label}" style="height:100px">`);
  }

  // Client signature placeholder — will be replaced at signing time
  data["client_signature"] = `<span data-signing-placeholder="client" style="display:inline-block;width:200px;height:80px;border-bottom:1px dotted #999;vertical-align:bottom"></span>`;

  if (client) {
    const fullName = client.type === "COMPANY"
      ? client.companyName || ""
      : `${client.firstName || ""} ${client.lastName || ""}`.trim();
    Object.assign(data, {
      // Dot-notation
      "client.fullName": fullName,
      "client.name": fullName,
      "client.companyName": client.companyName || "",
      "client.firstName": client.firstName || "",
      "client.lastName": client.lastName || "",
      "client.cui": client.cui || "",
      "client.type": client.type,
      "client.address": client.addresses[0]?.address || "",
      "client.city": client.addresses[0]?.city?.name || "",
      "client.county": client.addresses[0]?.state?.name || "",
      "client.phone": client.phone || "",
      "client.email": client.email || "",
      // Underscore-notation (matching template editor variable IDs)
      "client_name": fullName,
      "client_company_name": client.companyName || "",
      "client_first_name": client.firstName || "",
      "client_last_name": client.lastName || "",
      "client_cui": client.cui || "",
      "client_type": client.type,
      "client_address": client.addresses[0]?.address || "",
      "client_city": client.addresses[0]?.city?.name || "",
      "client_county": client.addresses[0]?.state?.name || "",
      "client_phone": client.phone || "",
      "client_email": client.email || "",
    });

    // Contract PF/PJ blocks: check + fill the matching variant, dotted blanks
    // on the other (mirrors the client's paper form).
    const dots = (n: number) => ".".repeat(n);
    const isPF = client.type !== "COMPANY";
    Object.assign(data, {
      "client_pf_x": isPF ? "X" : dots(5),
      "client_pj_x": isPF ? dots(5) : "X",
      "client_pf_name": isPF ? fullName : dots(50),
      "client_pj_name": isPF ? dots(50) : fullName,
      "client_pj_cui": !isPF && client.cui ? client.cui : dots(24),
    });
  }

  return data;
}

/**
 * Zero-footprint "ink" wrapper: the image is centered on the anchor point and
 * painted OVER the surrounding content (like a real stamp/signature applied on
 * the printed page) — the host table cell keeps its own size.
 */
function inkOverlay(inner: string): string {
  return (
    `<span style="display:inline-block;width:0;height:0;overflow:visible;position:relative;vertical-align:middle">` +
    `<span style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);display:inline-block;white-space:nowrap">${inner}</span>` +
    `</span>`
  );
}

/** Substitute {{variable}} placeholders in HTML content */
function renderHtml(html: string, data: Record<string, string>): string {
  return html.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const trimmed = key.trim();
    return data[trimmed] ?? "";
  });
}

/** Convert HTML to PDF using puppeteer */
async function htmlToPdf(html: string): Promise<Buffer> {
  // `<template id="pdf-header/pdf-footer">` markers → per-page puppeteer bands.
  const { body, headerHtml, footerHtml } = extractPdfMarkers(html);
  html = body;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const styledHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: 'Helvetica Neue', Arial, sans-serif;
            font-size: 12px;
            line-height: 1.6;
            margin: 0;
            padding: 40px;
            color: #333;
          }
          h1 { font-size: 18px; text-align: center; margin-bottom: 20px; }
          h2 { font-size: 14px; margin-top: 24px; margin-bottom: 8px; }
          hr { border: none; border-top: 1px solid #ccc; margin: 20px 0; }
          ul { padding-left: 20px; }
          li { margin-bottom: 4px; }
          p { margin: 6px 0; }
          /* Remove the variable badge styling from the editor */
          span[data-type="variable"] {
            display: inline;
            background: none !important;
            padding: 0 !important;
            border-radius: 0 !important;
            font-size: inherit !important;
            color: inherit !important;
          }
          img {
            max-height: 80px;
            display: inline-block;
          }
          /* Tables: default solid borders; .no-border overrides for signatures */
          table {
            border-collapse: collapse;
            width: 100%;
            table-layout: auto;
            margin: 8px 0;
          }
          td, th {
            border: 1px solid #ccc;
            padding: 6px 10px;
            vertical-align: top;
          }
          th {
            background-color: #f5f5f5;
            font-weight: 600;
          }
          table.no-border, table.no-border td, table.no-border th {
            border: none;
            background-color: transparent;
          }
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;
    await page.setContent(styledHtml, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      ...(headerHtml || footerHtml
        ? {
            displayHeaderFooter: true,
            headerTemplate: headerHtml ?? "<div></div>",
            footerTemplate: footerHtml ?? "<div></div>",
            margin: {
              top: headerHtml ? "32mm" : "10mm",
              right: headerHtml ? "12mm" : "10mm",
              bottom: "18mm",
              left: headerHtml ? "12mm" : "10mm",
            },
          }
        : {
            margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
          }),
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

async function processJob(job: Job<DocumentJobData>) {
  const { documentId, tenantId, projectId, clientId, templateId } = job.data;

  const documentRecord = await prisma.document.update({
    where: { id: documentId },
    data: { status: "GENERATING" },
  });

  try {
    const template = await prisma.documentTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });

    const isHtmlTemplate = !!template.content && !template.s3Key;
    // A DOCX "group" template renders into a single ZIP bundling all members.
    const isGroup = template.type === "group";
    const docCtx = documentRecord.contextJson as Record<string, unknown> | null;

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: {
        city: { select: { name: true } },
        state: { select: { name: true } },
      },
    });

    // Underscore-keyed data for DOCX, dot-keyed for HTML
    const data: Record<string, unknown> = {
      ...buildTenantData(tenant),
      date: new Date().toLocaleDateString("ro-RO"),
      current_date: new Date().toLocaleDateString("ro-RO"), // alias for {date}
      year: new Date().getFullYear().toString(),
    };

    let clientRecord: ClientInput | null = null;
    let s3Key: string;

    if (projectId) {
      // === Project document flow ===
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        include: {
          client: {
            include: {
              addresses: {
                where: { isPrimary: true },
                include: {
                  city: { select: { name: true } },
                  state: { select: { name: true } },
                },
                take: 1,
              },
            },
          },
          projectType: true,
          teamMembers: {
            include: { employee: { select: { credentials: true, firstName: true, lastName: true, signatureS3Key: true } } },
          },
        },
      });

      clientRecord = project.client;
      Object.assign(data, buildClientData(project.client));
      const meta = (project.metadata as Record<string, unknown>) || {};
      Object.assign(data, {
        project_name: project.name,
        project_type: project.projectType.name,
        project_address: project.address,
        project_city: project.city,
        project_county: project.county,
        project_status: project.status,
        // Detailed address & technical fields from metadata
        project_street_type: meta.project_street_type || meta.streetType || "Str",
        project_street: meta.project_street || meta.street || "",
        project_street_number: meta.project_street_number || meta.streetNumber || "",
        project_dn: meta.project_dn || meta.dn || "",
        project_material: meta.project_material || meta.material || "",
        project_length: meta.project_length || meta.length || "",
        ...meta,
      });

      // Pass project drawing as image reference for DOCX rendering
      if (project.drawingS3Key) {
        data.project_drawing = { s3Key: project.drawingS3Key, mimetype: "image/png" };
      }

      // Professional credentials come from the assigned EMPLOYEE (Employees page);
      // per-project assignment fields (e.g. decizie de numire nr/dată) come from
      // the team-member association and override/extend them.
      type TM = (typeof project.teamMembers)[number];
      const credsOf = (tm: TM) => ({
        ...((tm.employee?.credentials as Record<string, string> | null) ?? {}),
        ...((tm.credentials as Record<string, string> | null) ?? {}),
      });
      const nameOf = (tm: TM) =>
        tm.employee ? `${tm.employee.firstName} ${tm.employee.lastName}` : tm.name;

      // Build sudori array for loop templates (e.g. welder table)
      const sudoriMembers = project.teamMembers.filter(tm => tm.role === "sudor");
      data.project_sudori = sudoriMembers.map((tm, i) => {
        const creds = credsOf(tm);
        return {
          nr_crt: String(i + 1),
          sudor_ol_nume: nameOf(tm),
          sudor_ol_aut_intern: creds.autorizatie_ol_intern ?? creds.autorizatii ?? "",
          sudor_ol_aut_iscir: creds.autorizatie_ol_iscir ?? "",
          sudor_ol_poanson: creds.poanson ?? "",
          sudor_pe_nume: nameOf(tm),
          sudor_pe_aut_intern: creds.autorizatie_pe_intern ?? creds.autorizatii ?? "",
          sudor_pe_aut_iscir: creds.autorizatie_pe_iscir ?? "",
          sudor_pe_poanson: creds.poanson ?? "",
        };
      });

      // Load team member variables
      for (const tm of project.teamMembers) {
        const creds = credsOf(tm);
        data[`${tm.role}_nume`] = nameOf(tm);
        data[`${tm.role}_legitimatie`] = creds.legitimatie ?? "";
        data[`${tm.role}_tip`] = creds.tip ?? "";
        data[`${tm.role}_autorizatie`] = creds.autorizatie ?? "";
        data[`${tm.role}_autorizatii`] = creds.autorizatii ?? "";
        data[`${tm.role}_poanson`] = creds.poanson ?? "";
        data[`${tm.role}_valabilitate`] = creds.valabilitate ?? "";
        // ISCIR dossier fields (decizii de numire, atestate, domenii de autorizare)
        data[`${tm.role}_atestat`] = creds.atestat ?? "";
        data[`${tm.role}_domeniu`] = creds.domeniu ?? "";
        data[`${tm.role}_decizie_nr`] = creds.decizie_nr ?? "";
        data[`${tm.role}_decizie_data`] = creds.decizie_data ?? "";
        // Employee signature image (placed via {%rte_signature} etc.). Image-ref
        // objects are downloaded from S3 + embedded by the DOCX branch below.
        if (tm.employee?.signatureS3Key) {
          data[`${tm.role}_signature`] = { s3Key: tm.employee.signatureS3Key, mimetype: "image/png" };
        }

        // Backward compat: sudor → sudor_pe + sudor_ol aliases
        if (tm.role === "sudor") {
          data["sudor_pe_nume"] = nameOf(tm);
          data["sudor_pe_autorizatii"] = creds.autorizatii ?? "";
          data["sudor_pe_poanson"] = creds.poanson ?? "";
          data["sudor_ol_nume"] = nameOf(tm);
          data["sudor_ol_autorizatii"] = creds.autorizatii ?? "";
          data["sudor_ol_poanson"] = creds.poanson ?? "";
        }
      }

      // Load workflow step outputs
      const workflowInstance = await prisma.workflowInstance.findFirst({
        where: { entityId: projectId, tenantId, status: { in: ["running", "completed"] } },
        orderBy: { createdAt: "desc" },
        include: {
          stepInstances: {
            where: { status: "completed", outputJson: { not: undefined } },
            include: { stepDefinition: { select: { code: true } } },
          },
        },
      });

      if (workflowInstance) {
        for (const step of workflowInstance.stepInstances) {
          const output = step.outputJson as Record<string, unknown> | null;
          if (!output) continue;
          for (const [key, value] of Object.entries(output)) {
            if (step.stepDefinition) {
              data[`${step.stepDefinition.code}.${key}`] = value;
            }
            if (!(key in data)) {
              data[key] = value;
            }
          }
        }
      }

      const ext = isHtmlTemplate ? "pdf" : isGroup ? "zip" : "docx";
      s3Key = `${tenantId}/projects/${projectId}/documents/${documentId}.${ext}`;
    } else if (clientId) {
      // === Client document flow (e.g. GDPR) ===
      const client = await prisma.client.findUniqueOrThrow({
        where: { id: clientId },
        include: {
          addresses: {
            where: { isPrimary: true },
            include: {
              city: { select: { name: true } },
              state: { select: { name: true } },
            },
            take: 1,
          },
        },
      });

      clientRecord = client;
      Object.assign(data, buildClientData(client));

      // Merge contract context (services, price, payment method) if provided
      if (job.data.context) {
        Object.assign(data, buildContractData(job.data.context));
      }

      // Merge revision data if this is a revision document
      if (job.data.revisionId) {
        const revision = await prisma.equipmentRevision.findUnique({
          where: { id: job.data.revisionId },
          include: {
            equipment: { select: { name: true, serial: true, fuel: true, deviceType: true, power: true, airSupply: true, feeding: true, location: true, fuelIscir: true, deviceAge: true } },
            appointment: { select: { completionDataJson: true } },
          },
        });
        if (revision) {
          Object.assign(data, buildRevisionData(revision, readAlertWindows(tenant.settingsJson).revisionIntervalYears));

          // Get completion data: from linked appointment OR find unlinked one for same client
          let completionData = revision.appointment?.completionDataJson;
          if (!completionData && clientId) {
            const fallbackAppointment = await prisma.appointment.findFirst({
              where: {
                clientId,
                type: "revizie",
                status: "completed",
                completionDataJson: { not: Prisma.JsonNull },
                deletedAt: null,
              },
              orderBy: { updatedAt: "desc" },
              select: { completionDataJson: true },
            });
            completionData = fallbackAppointment?.completionDataJson ?? null;
            if (completionData) {
              console.log("[doc-worker] Using fallback appointment completionData for client", clientId);
            }
          }

          if (completionData) {
            Object.assign(data, await buildAppointmentReportData(completionData));
          }
        }
      }

      const ext = isHtmlTemplate ? "pdf" : isGroup ? "zip" : "docx";
      s3Key = `${tenantId}/clients/${clientId}/documents/${documentId}.${ext}`;
    } else {
      throw new Error("Job must have either projectId or clientId");
    }

    let outputBuffer: Buffer;
    let contentType: string;

    if (isHtmlTemplate) {
      // HTML template → substitute variables → PDF
      const htmlData = await buildHtmlTemplateData(clientRecord, tenant, documentId);

      // Merge contract context into HTML data
      if (job.data.context) {
        Object.assign(htmlData, buildContractData(job.data.context));
      }

      // Merge revision data into HTML data
      if (job.data.revisionId) {
        const revision = await prisma.equipmentRevision.findUnique({
          where: { id: job.data.revisionId },
          include: {
            equipment: { select: { name: true, serial: true, fuel: true, deviceType: true, power: true, airSupply: true, feeding: true, location: true, fuelIscir: true, deviceAge: true } },
            appointment: { select: { completionDataJson: true } },
          },
        });
        if (revision) {
          Object.assign(htmlData, buildRevisionData(revision, readAlertWindows(tenant.settingsJson).revisionIntervalYears));

          let completionData = revision.appointment?.completionDataJson;
          if (!completionData && clientId) {
            const fallbackAppointment = await prisma.appointment.findFirst({
              where: {
                clientId,
                type: "revizie",
                status: "completed",
                completionDataJson: { not: Prisma.JsonNull },
                deletedAt: null,
              },
              orderBy: { updatedAt: "desc" },
              select: { completionDataJson: true },
            });
            completionData = fallbackAppointment?.completionDataJson ?? null;
          }

          if (completionData) {
            Object.assign(htmlData, await buildAppointmentReportData(completionData));
          }
        }
      }

      // Merge gas-installation FISA report (revizie/verificare instalație)
      if (docCtx?.appointmentId) {
        const appt = await prisma.appointment.findUnique({
          where: { id: docCtx.appointmentId as string },
          include: {
            installation: {
              include: {
                clientAddress: {
                  include: { country: true, state: true, city: true },
                },
              },
            },
          },
        });
        if (appt?.completionDataJson) {
          const empId = (docCtx.instalatorEmployeeId as string | null) ?? null;
          const instalator = empId
            ? await prisma.employee.findUnique({ where: { id: empId } })
            : null;
          // Preserve the client's own (domicile) address before the installation
          // consumption address overrides client_address/* — the contract shows both.
          htmlData.client_home_address = htmlData.client_address ?? "";
          htmlData.client_home_city = htmlData.client_city ?? "";
          htmlData.client_home_county = htmlData.client_county ?? "";
          Object.assign(
            htmlData,
            await buildInstalatieReportData(
              appt.completionDataJson,
              appt.installation as Record<string, any> | null,
              instalator as Record<string, any> | null,
            ),
          );
        }
      }

      console.log("[doc-worker] Template content length:", template.content!.length);
      console.log("[doc-worker] Tenant adminName:", tenant.adminName);
      console.log("[doc-worker] Tenant stampS3Key:", tenant.stampS3Key);
      console.log("[doc-worker] Tenant signatureS3Key:", tenant.signatureS3Key);
      console.log("[doc-worker] htmlData keys:", Object.keys(htmlData).filter(k => k.startsWith("tenant_")));
      console.log("[doc-worker] htmlData tenant_admin_name:", htmlData["tenant_admin_name"]);
      console.log("[doc-worker] htmlData tenant_stamp present:", !!htmlData["tenant_stamp"]);
      console.log("[doc-worker] htmlData tenant_signature present:", !!htmlData["tenant_signature"]);

      // Embed client signature from document.contextJson (for auto-generated GDPR docs)
      if (docCtx?.clientSignatureS3Key) {
        try {
          const stream = await getFileStream(docCtx.clientSignatureS3Key as string);
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
          const buf = Buffer.concat(chunks);
          htmlData.client_signature = inkOverlay(
            `<img src="data:image/png;base64,${buf.toString("base64")}" style="height:48px">`
          );
        } catch {
          htmlData.client_signature = "";
        }
      }

      // Allocate registry entry (official numbering) before rendering PDF
      const clientName = clientRecord
        ? (clientRecord.companyName || `${clientRecord.firstName ?? ""} ${clientRecord.lastName ?? ""}`.trim())
        : "";
      const reg = await allocateOutgoingNumber(tenantId, template, clientName, documentId, projectId, clientId);
      htmlData.nr_inregistrare = reg?.nr ?? "";
      htmlData.nr_inregistrare_data = reg?.data ?? "";

      // Log which {{variables}} are in the template
      const templateVars = [...template.content!.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
      console.log("[doc-worker] Variables found in template:", templateVars);

      // Single resolved "operator de sistem" for the RT header: the installation's
      // distributor wins, else the firm-level setting.
      htmlData.operator_sistem = htmlData.inst_distributor || htmlData.tenant_operator_sistem || "";

      let renderedHtml = renderHtml(template.content!, htmlData);
      // Only the RT carries the per-page footer (company + IBAN + page number) —
      // the client's PV form has none. Embedded as a marker so it survives to
      // the S3 copy and is reproduced at signing re-render.
      if (template.categoryCode === "REVIZIE_INSTALATIE_RT") {
        renderedHtml = embedFooterMarker(renderedHtml, buildInstalatieFooterHtml(htmlData));
      }

      // Service contracts repeat the pg./Reg./IBAN footer on EVERY page (no
      // letterhead header — per the client's preference).
      if (
        template.categoryCode === "CONTRACT_REVIZIE_INSTALATIE" ||
        template.categoryCode === "CONTRACT_VERIFICARE_INSTALATIE"
      ) {
        renderedHtml = embedFooterMarker(renderedHtml, buildContractFooterHtml(htmlData));
      }
      outputBuffer = await htmlToPdf(renderedHtml);
      contentType = "application/pdf";

      // Save rendered HTML alongside PDF for re-rendering at signing time
      const htmlS3Key = s3Key.replace(/\.pdf$/, ".html");
      await uploadFile(htmlS3Key, Buffer.from(renderedHtml, "utf-8"), "text/html");
    } else {
      // DOCX: a single template, or a "group" → ZIP bundling all rendered members.
      const clientName = clientRecord
        ? (clientRecord.companyName || `${clientRecord.firstName ?? ""} ${clientRecord.lastName ?? ""}`.trim())
        : "";

      // Detect image references in the (shared) project context and download
      // them once — the same images apply to every member of a group.
      const images: Record<string, Buffer> = {};
      for (const [key, value] of Object.entries(data)) {
        if (
          value &&
          typeof value === "object" &&
          "s3Key" in (value as any) &&
          "mimetype" in (value as any)
        ) {
          const ref = value as { s3Key: string; mimetype: string };
          if (ref.mimetype.startsWith("image/")) {
            const imgStream = await getFileStream(ref.s3Key);
            if (imgStream) {
              images[key] = await streamToBuffer(imgStream);
              data[key] = key;
            }
          }
        }
      }

      // Auto-allocate an outgoing-registry number (Registru Ieșiri) only when a
      // template's body uses {nr_inregistrare}/{data_inregistrare} — so a 12-member
      // dossier doesn't burn 12 numbers (only the members that need one get one).
      const allocIfNeeded = async (buf: Buffer, tpl: { categoryCode: string; name: string }) => {
        const xml = new PizZip(buf).file("word/document.xml")?.asText() ?? "";
        if (/\{(nr_inregistrare|data_inregistrare)\}/.test(xml)) {
          const reg = await allocateOutgoingNumber(tenantId, tpl, clientName, documentId, projectId, clientId);
          if (reg) {
            data.nr_inregistrare = reg.nr;
            data.data_inregistrare = reg.data;
            data.nr_inregistrare_data = reg.data;
          }
        }
      };

      if (isGroup) {
        // Render every active member with the same project context, then bundle
        // them into a single ZIP — the project then shows ONE document.
        const members = await prisma.documentTemplate.findMany({
          where: { parentGroupId: template.id, isActive: true, s3Key: { not: null } },
          orderBy: { memberOrder: "asc" },
        });
        if (members.length === 0) throw new Error("Group has no documents to generate");

        const zip = new PizZip();
        const used = new Set<string>();
        for (const member of members) {
          const memberStream = await getFileStream(member.s3Key!);
          if (!memberStream) throw new Error(`Group member file not found in S3: ${member.name}`);
          const memberBuffer = await streamToBuffer(memberStream);
          await allocIfNeeded(memberBuffer, member);
          const rendered = renderDocx(memberBuffer, data, images, DOCX_IMAGE_OPTS);
          // Friendly, unique filename inside the archive.
          const base = (member.fileName || member.name || "document").replace(/\.docx$/i, "");
          let entry = `${base}.docx`;
          let n = 1;
          while (used.has(entry)) entry = `${base} (${++n}).docx`;
          used.add(entry);
          zip.file(entry, rendered);
        }
        outputBuffer = Buffer.from(zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));
        contentType = "application/zip";
      } else {
        if (!template.s3Key) throw new Error("Template has no S3 file");
        const templateStream = await getFileStream(template.s3Key);
        if (!templateStream) throw new Error("Template file not found in S3");
        const templateBuffer = await streamToBuffer(templateStream);
        await allocIfNeeded(templateBuffer, template);
        outputBuffer = renderDocx(templateBuffer, data, images, DOCX_IMAGE_OPTS);
        contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      }
    }

    // Upload to S3
    await uploadFile(s3Key, outputBuffer, contentType);

    // Update document status
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "COMPLETED", s3Key },
    });

    // If this document belongs to a workflow step, check if step can be completed
    try {
      await maybeResolveWorkflowStep(documentId, tenantId);
    } catch (stepErr) {
      console.error("[doc-worker] maybeResolveWorkflowStep (success path) failed:", stepErr);
    }

    // Auto-send document to client email (GDPR or ISCIR report)
    const sendToEmail = (docCtx?.sendToEmail as string) || (docCtx?.gdprAutoGenerated ? null : null);
    const shouldSendEmail = contentType === "application/pdf" && (sendToEmail || docCtx?.gdprAutoGenerated);
    if (shouldSendEmail && clientId) {
      try {
        const client = await prisma.client.findUnique({
          where: { id: clientId },
          select: { email: true, firstName: true, lastName: true, companyName: true },
        });
        const recipientEmail = (sendToEmail as string) || client?.email;
        if (recipientEmail) {
          const { sendSigningComplete } = await import("../lib/email.js");
          const clientName = client?.companyName || `${client?.firstName ?? ""} ${client?.lastName ?? ""}`.trim() || "Client";
          const docName = template.name || "Document";
          await sendSigningComplete({
            to: recipientEmail,
            signatoryName: clientName,
            documentName: docName,
            tenantName: tenant.name,
            pdfBuffer: outputBuffer,
          });
          console.log(`[doc-worker] PDF "${docName}" sent to ${recipientEmail}`);
        }
      } catch (emailErr) {
        console.error("[doc-worker] Failed to send document email:", emailErr);
      }
    }

    return { success: true, documentId };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED", errorMessage },
    });

    // If this document belongs to a workflow step, check if step should fail
    try {
      await maybeResolveWorkflowStep(documentId, tenantId);
    } catch (stepErr) {
      console.error("[doc-worker] maybeResolveWorkflowStep (failure path) failed:", stepErr);
    }

    throw error;
  }
}

/**
 * Minimal fastify-like stub so step-completion functions (which expect a
 * FastifyInstance) can be invoked from this worker process.
 */
const engineFastify = {
  prisma,
  httpErrors: {
    badRequest: (msg: string) => new Error(`BadRequest: ${msg}`),
    notFound: (msg: string) => new Error(`NotFound: ${msg}`),
    conflict: (msg: string) => new Error(`Conflict: ${msg}`),
  },
  log: {
    info: (data: unknown, msg?: string) =>
      console.log("[doc-worker:engine]", msg ?? "", data),
    warn: (data: unknown, msg?: string) =>
      console.warn("[doc-worker:engine]", msg ?? "", data),
    error: (data: unknown, msg?: string) =>
      console.error("[doc-worker:engine]", msg ?? "", data),
  },
} as unknown as FastifyInstance;

/**
 * After a document reaches a terminal status, check whether its workflow step
 * can now be completed (all siblings COMPLETED) or failed (any FAILED with no
 * pending siblings). Called from processJob on both success and failure paths.
 *
 * Returns silently if the document is not linked to a workflow step, or if
 * siblings are still in progress.
 */
async function maybeResolveWorkflowStep(documentId: string, tenantId: string) {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { workflowStepInstanceId: true },
  });
  if (!doc?.workflowStepInstanceId) return; // not linked to a workflow step

  const stepInstanceId = doc.workflowStepInstanceId;

  // Load step + all sibling documents (linked to the same step)
  const [stepInstance, siblings] = await Promise.all([
    prisma.workflowStepInstance.findUnique({
      where: { id: stepInstanceId },
      select: { id: true, status: true },
    }),
    prisma.document.findMany({
      where: { workflowStepInstanceId: stepInstanceId, tenantId },
      select: { id: true, status: true, name: true, errorMessage: true },
    }),
  ]);

  if (!stepInstance) return;
  // Only act if the step is waiting (avoid double-completing on retries)
  if (stepInstance.status !== "waiting") return;

  const counts = {
    pending: 0,
    generating: 0,
    completed: 0,
    failed: 0,
    other: 0,
  };
  for (const s of siblings) {
    if (s.status === "PENDING") counts.pending++;
    else if (s.status === "GENERATING") counts.generating++;
    else if (s.status === "COMPLETED") counts.completed++;
    else if (s.status === "FAILED") counts.failed++;
    else counts.other++;
  }

  const stillInFlight = counts.pending + counts.generating;
  if (stillInFlight > 0) {
    return; // wait for remaining jobs
  }

  if (counts.failed > 0) {
    const failedDocs = siblings
      .filter((s) => s.status === "FAILED")
      .map((s) => ({
        documentId: s.id,
        name: s.name,
        error: s.errorMessage ?? "unknown",
      }));
    await failStep(engineFastify, tenantId, stepInstanceId, "system", {
      reason: "document_generation_failed",
      failedDocuments: failedDocs,
    });
    console.log(
      `[doc-worker] Step ${stepInstanceId} failed — ${counts.failed}/${siblings.length} documents FAILED`
    );
    return;
  }

  // All siblings COMPLETED — finalize the step
  await completeStep(engineFastify, tenantId, stepInstanceId, "system", {
    documentsGenerated: counts.completed,
  });
  console.log(
    `[doc-worker] Step ${stepInstanceId} completed — all ${counts.completed} documents generated`
  );
}

// Start worker
async function main() {
  await ensureBucket();

  const worker = new Worker("document-generation", processJob, {
    connection: redisConnection,
    concurrency: 3,
  });

  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed for document ${job.data.documentId}`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `Job ${job?.id} failed for document ${job?.data.documentId}:`,
      err.message
    );
  });

  console.log("Document generation worker started");

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

// Only boot the queue when this file is the entry point — importing it (e.g. to
// exercise buildInstalatieReportData) must not open Redis/Prisma connections.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(console.error);
}
