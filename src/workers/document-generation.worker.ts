import { Worker, type Job } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { redisConnection } from "../config/redis.js";
import { getFileStream, uploadFile, getPresignedUrl } from "../lib/s3.js";
import { renderDocx } from "../lib/docx-engine.js";
import { ensureBucket } from "../lib/s3.js";
import puppeteer from "puppeteer";
import { allocateEntryForDocument } from "../modules/registry/registry.service.js";

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
  // Pass stamp & signature as image references for DOCX rendering
  if (tenant.stampS3Key) {
    data.tenant_stamp = { s3Key: tenant.stampS3Key, mimetype: "image/png" };
  }
  if (tenant.signatureS3Key) {
    data.tenant_signature = { s3Key: tenant.signatureS3Key, mimetype: "image/png" };
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
    result.verif_draft_type = f.draftType || "";
    result.verif_draft_value = f.draftValue || "";
    result.verif_gas_pressure_ramp = f.gasPressureRamp || "";
    result.verif_gas_pressure_burner = f.gasPressureBurner || "";
    result.verif_gas_pressure_focus = f.gasPressureFocus || "";
    result.verif_flue_gas_sealing = chk(f.flueGasSealingCheck);
    result.verif_protection_functions = chk(f.protectionFunctionsCheck);
    result.verif_water_pressure = f.waterPressure || "";
    result.verif_water_temp_flow = f.waterTempFlow || "";
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
}): Record<string, string> {
  const result: Record<string, string> = {};
  const readings = (revision.analysisData as Record<string, unknown>)?.readings as Record<string, string> | undefined;

  result.revision_date = revision.revisionDate.toLocaleDateString("ro-RO");
  const nextYear = new Date(revision.revisionDate);
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  result.next_revision_date = nextYear.toLocaleDateString("ro-RO");
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
    // Date
    "date": new Date().toLocaleDateString("ro-RO"),
    "year": new Date().getFullYear().toString(),
  };

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

  // Compose stamp & signature: signature centered on top of stamp, slightly right
  if (stampUrl && signatureUrl) {
    const composed = [
      `<span style="position:relative;display:inline-block">`,
      `<img src="${stampUrl}" alt="Ștampilă" style="height:120px">`,
      `<img src="${signatureUrl}" alt="Semnătură" style="position:absolute;top:80%;left:95%;transform:translate(-50%,-50%);height:90px">`,
      `</span>`,
    ].join("");
    data["tenant_stamp"] = composed;
    data["tenant_signature"] = composed;
  } else if (stampUrl) {
    data["tenant_stamp"] = `<img src="${stampUrl}" alt="Ștampilă" style="height:120px">`;
  } else if (signatureUrl) {
    data["tenant_signature"] = `<img src="${signatureUrl}" alt="Semnătură" style="height:90px">`;
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
  }

  return data;
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
      margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" },
      printBackground: true,
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
          teamMembers: true,
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

      // Build sudori array for loop templates (e.g. welder table)
      const sudoriMembers = project.teamMembers.filter(tm => tm.role === "sudor");
      data.project_sudori = sudoriMembers.map((tm, i) => {
        const creds = (tm.credentials as Record<string, string>) ?? {};
        return {
          nr_crt: String(i + 1),
          sudor_ol_nume: tm.name,
          sudor_ol_aut_intern: creds.autorizatie_ol_intern ?? creds.autorizatii ?? "",
          sudor_ol_aut_iscir: creds.autorizatie_ol_iscir ?? "",
          sudor_ol_poanson: creds.poanson ?? "",
          sudor_pe_nume: tm.name,
          sudor_pe_aut_intern: creds.autorizatie_pe_intern ?? creds.autorizatii ?? "",
          sudor_pe_aut_iscir: creds.autorizatie_pe_iscir ?? "",
          sudor_pe_poanson: creds.poanson ?? "",
        };
      });

      // Load team member variables
      for (const tm of project.teamMembers) {
        const creds = (tm.credentials as Record<string, string>) ?? {};
        data[`${tm.role}_nume`] = tm.name;
        data[`${tm.role}_legitimatie`] = creds.legitimatie ?? "";
        data[`${tm.role}_tip`] = creds.tip ?? "";
        data[`${tm.role}_autorizatie`] = creds.autorizatie ?? "";
        data[`${tm.role}_autorizatii`] = creds.autorizatii ?? "";
        data[`${tm.role}_poanson`] = creds.poanson ?? "";
        data[`${tm.role}_valabilitate`] = creds.valabilitate ?? "";

        // Backward compat: sudor → sudor_pe + sudor_ol aliases
        if (tm.role === "sudor") {
          data["sudor_pe_nume"] = tm.name;
          data["sudor_pe_autorizatii"] = creds.autorizatii ?? "";
          data["sudor_pe_poanson"] = creds.poanson ?? "";
          data["sudor_ol_nume"] = tm.name;
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
            data[`${step.stepDefinition.code}.${key}`] = value;
            if (!(key in data)) {
              data[key] = value;
            }
          }
        }
      }

      const ext = isHtmlTemplate ? "pdf" : "docx";
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
          Object.assign(data, buildRevisionData(revision));

          // Get completion data: from linked appointment OR find unlinked one for same client
          let completionData = revision.appointment?.completionDataJson;
          if (!completionData && clientId) {
            const fallbackAppointment = await prisma.appointment.findFirst({
              where: {
                clientId,
                type: "revizie",
                status: "completed",
                completionDataJson: { not: null },
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

      const ext = isHtmlTemplate ? "pdf" : "docx";
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
          Object.assign(htmlData, buildRevisionData(revision));

          let completionData = revision.appointment?.completionDataJson;
          if (!completionData && clientId) {
            const fallbackAppointment = await prisma.appointment.findFirst({
              where: {
                clientId,
                type: "revizie",
                status: "completed",
                completionDataJson: { not: null },
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
          htmlData.client_signature = `<img src="data:image/png;base64,${buf.toString("base64")}" style="max-height:60px">`;
        } catch {
          htmlData.client_signature = "";
        }
      }

      // Allocate registry entry (official numbering) before rendering PDF
      // Map template category → registry series code
      const seriesCodeMap: Record<string, string> = {
        REVIZIE_CENTRALA: "iesiri",
        SERVICE_AGREEMENT: "iesiri",
        ACT_ADITIONAL_CONTRACT_SERVICII: "iesiri",
        GDPR: "iesiri",
      };
      const seriesCode = seriesCodeMap[template.categoryCode] ?? "iesiri";
      try {
        const registryEntry = await allocateEntryForDocument(
          prisma,
          tenantId,
          null,
          seriesCode,
          `${template.name} — ${clientRecord ? (clientRecord.companyName || `${clientRecord.firstName ?? ""} ${clientRecord.lastName ?? ""}`.trim()) : ""}`.trim(),
          documentId,
          projectId,
          clientId
        );
        if (registryEntry) {
          htmlData.nr_inregistrare = registryEntry.displayNumber;
          htmlData.nr_inregistrare_data = registryEntry.createdAt.toLocaleDateString("ro-RO");
          console.log(`[doc-worker] Registry entry allocated: ${registryEntry.displayNumber}`);
        } else {
          htmlData.nr_inregistrare = "";
          htmlData.nr_inregistrare_data = "";
          console.warn(`[doc-worker] No registry series '${seriesCode}' for tenant ${tenantId}`);
        }
      } catch (err) {
        console.error("[doc-worker] Failed to allocate registry entry:", err);
        htmlData.nr_inregistrare = "";
        htmlData.nr_inregistrare_data = "";
      }

      // Log which {{variables}} are in the template
      const templateVars = [...template.content!.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
      console.log("[doc-worker] Variables found in template:", templateVars);

      const renderedHtml = renderHtml(template.content!, htmlData);
      outputBuffer = await htmlToPdf(renderedHtml);
      contentType = "application/pdf";

      // Save rendered HTML alongside PDF for re-rendering at signing time
      const htmlS3Key = s3Key.replace(/\.pdf$/, ".html");
      await uploadFile(htmlS3Key, Buffer.from(renderedHtml, "utf-8"), "text/html");
    } else {
      // DOCX template from S3
      if (!template.s3Key) throw new Error("Template has no S3 file");
      const templateStream = await getFileStream(template.s3Key);
      if (!templateStream) throw new Error("Template file not found in S3");
      const templateBuffer = await streamToBuffer(templateStream);

      // Detect image references and download from S3
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

      outputBuffer = renderDocx(templateBuffer, data, images);
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }

    // Upload to S3
    await uploadFile(s3Key, outputBuffer, contentType);

    // Update document status
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "COMPLETED", s3Key },
    });

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

    throw error;
  }
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

main().catch(console.error);
