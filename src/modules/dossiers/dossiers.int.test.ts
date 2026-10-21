import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import PizZip from "pizzip";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import * as clientsService from "../clients/clients.service.js";
import { updateQuickDossierSchema } from "../clients/clients.schema.js";
import * as dossiers from "./dossiers.service.js";
import { createDossierSchema, updateDossierSchema } from "./dossiers.schema.js";
import { expectReject } from "../../test/stub.js";
import { ensureDefaultProjectTypes } from "../../lib/default-project-types.js";

// Fișierele membrilor grupului: DOCX-uri construite în memorie, pe cheia S3.
const files = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../../lib/s3.js", () => ({
  getFileBuffer: async (key: string) => {
    const b = files.get(key);
    if (!b) throw new Error(`no file ${key}`);
    return b;
  },
}));

function docx(text: string): Buffer {
  const zip = new PizZip();
  zip.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" });
}

let app: FastifyInstance;
let f: TwoTenants;
let groupId: string;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  for (const t of [f.a, f.b]) {
    await prisma.projectType.create({ data: { tenantId: t.id, code: "bransament", name: "Branșament" } });
  }
  await prisma.templateCategory.upsert({
    where: { code: "CARTE_BRANSAMENT" },
    update: {},
    create: { code: "CARTE_BRANSAMENT", name: "Carte branșament" },
  });
  // Grupurile de sistem (fără firmă) nu cad la resetDb.
  await prisma.documentTemplate.deleteMany({ where: { tenantId: null, name: { startsWith: "Test dosar" } } });
  const group = await prisma.documentTemplate.create({
    data: { tenantId: null, categoryCode: "CARTE_BRANSAMENT", name: "Test dosar branșament", type: "group", distributorCode: "DISTRIGAZ" },
  });
  groupId = group.id;
  // Cheie nouă la fiecare test: cache-ul de placeholdere e pe cheie.
  const k1 = `test/${Date.now()}-${Math.random()}/pv.docx`;
  const k2 = `test/${Date.now()}-${Math.random()}/opis.docx`;
  files.set(k1, docx("ATR {cod_atr} RTE {rte_nume} {rte_decizie_nr} {tenant_name}"));
  files.set(k2, docx("Proiect {proiect_nr_documentatie} {#project_sudori}{sudor_ol_nume}{/project_sudori} {camp_firma}"));
  await prisma.documentTemplate.createMany({
    data: [
      { tenantId: null, categoryCode: "CARTE_BRANSAMENT", name: "Test dosar PV", type: "single", s3Key: k1, parentGroupId: groupId, memberOrder: 1 },
      { tenantId: null, categoryCode: "CARTE_BRANSAMENT", name: "Test dosar Opis", type: "single", s3Key: k2, parentGroupId: groupId, memberOrder: 2 },
    ],
  });
  await prisma.distributor.create({ data: { tenantId: f.a.id, code: "DISTRIGAZ", name: "Distrigaz Sud Rețele" } });
});

const newDossier = (tenantId: string, clientId: string, extra: Record<string, unknown> = {}) =>
  dossiers.create(app, tenantId, createDossierSchema.parse({ templateGroupId: groupId, client: { id: clientId }, ...extra }));
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("dosare — echipa", () => {
  it("salvarea echipei fără credentials păstrează nr. deciziei RTE", async () => {
    const d = await clientsService.createDossier(app, f.a.id, f.a.admin.id, f.a.clientId, {
      templateGroupId: groupId,
      address: "Str. X 1",
      city: "Ploiești",
      county: "Prahova",
      teamMembers: [{ role: "rte", employeeId: f.a.employeeId, credentials: { decizie_nr: "12", decizie_data: "01.10.2026" } }],
    });
    await clientsService.updateDossier(
      app,
      f.a.id,
      f.a.clientId,
      d.id,
      updateQuickDossierSchema.parse({ teamMembers: [{ role: "rte", employeeId: f.a.employeeId }] }),
    );
    const tm = await prisma.projectTeamMember.findFirstOrThrow({ where: { projectId: d.id, role: "rte" } });
    expect(tm.credentials).toMatchObject({ decizie_nr: "12", decizie_data: "01.10.2026" });
  });
});

describe("dosare — câmpuri și completare", () => {
  it("câmpurile grupului vin din DOCX-urile lui; necunoscutele la „Alte câmpuri”", async () => {
    const r = await dossiers.getFields(app, f.a.id, groupId);
    expect(r.fields.map((x) => x.key)).toEqual(["cod_atr", "proiect_nr", "camp_firma"]);
    expect(r.fields.find((x) => x.key === "camp_firma")!.section).toBe("Alte câmpuri");
    expect(r.fields.find((x) => x.key === "cod_atr")!.docs).toEqual(["Test dosar PV"]);
    expect(r.roles.map((x) => x.role)).toEqual(["rte", "sudor"]);
    expect(r.roles[0].assignmentFields).toEqual(["decizie_nr"]);
    expect(r.usesSudoriTable).toBe(true);
  });

  it("dosarul nou ia OSD-ul din distribuitorul firmei, adresa din client, și calculează completarea", async () => {
    const d = await newDossier(f.a.id, f.a.clientId);
    expect(d.distributorId).not.toBeNull();
    expect(d.metadata).toMatchObject({ osd_denumire: "Distrigaz Sud Rețele" });
    expect(d.address).toBe("Str. Fixture a nr. 1");
    expect(d.completion).toMatchObject({ filled: 0, total: 5 });

    const u = await dossiers.update(app, f.a.id, d.id, updateDossierSchema.parse({
      metadata: { cod_atr: "ATR-1", proiect_nr: "P-7" },
      teamMembers: [{ role: "rte", employeeId: f.a.employeeId }],
    }));
    expect(u.completion).toMatchObject({ filled: 3, total: 5 });
    expect(u.completion!.missing.map((m) => m.key)).toEqual(["camp_firma", "role:sudor"]);
  });

  it("PATCH combină metadata; null șterge doar cheia respectivă", async () => {
    const d = await newDossier(f.a.id, f.a.clientId, { metadata: { cod_atr: "A", cod_sap: "S" } });
    const u = await dossiers.update(app, f.a.id, d.id, updateDossierSchema.parse({ metadata: { cod_sap: null, ordin_lucru: "OL" } }));
    expect(u.metadata).toMatchObject({ cod_atr: "A", ordin_lucru: "OL", osd_denumire: "Distrigaz Sud Rețele" });
    expect(u.metadata).not.toHaveProperty("cod_sap");
  });

  it("mai mulți sudori; scoaterea unuia îl șterge doar pe el", async () => {
    const e2 = await prisma.employee.create({ data: { tenantId: f.a.id, firstName: "Sudor", lastName: "Doi" } });
    const d = await newDossier(f.a.id, f.a.clientId);
    await dossiers.update(app, f.a.id, d.id, { teamMembers: [{ role: "sudor", employeeId: f.a.employeeId }, { role: "sudor", employeeId: e2.id }] });
    let tm = await prisma.projectTeamMember.findMany({ where: { projectId: d.id } });
    expect(tm).toHaveLength(2);
    await dossiers.update(app, f.a.id, d.id, { teamMembers: [{ role: "sudor", employeeId: e2.id }] });
    tm = await prisma.projectTeamMember.findMany({ where: { projectId: d.id } });
    expect(tm.map((t) => t.employeeId)).toEqual([e2.id]);
  });
});

describe("dosare — creare cu client nou", () => {
  it("clientul nou se creează împreună cu dosarul", async () => {
    const d = await dossiers.create(app, f.a.id, createDossierSchema.parse({
      templateGroupId: groupId,
      client: { type: "PERSON", firstName: "Maria", lastName: "Nouă", phone: "0722000111", addresses: [{ address: "Str. Nouă 3" }] },
    }));
    expect(d.clientName).toBe("Maria Nouă");
    expect(d.address).toBe("Str. Nouă 3");
  });

  it("firma fără tipuri de proiect (înregistrată după seed) → se creează automat, dosarul merge", async () => {
    await prisma.projectType.deleteMany({ where: { tenantId: f.a.id } });
    const d = await dossiers.create(app, f.a.id, createDossierSchema.parse({
      templateGroupId: groupId,
      client: { type: "PERSON", firstName: "X", lastName: "Y", phone: "0722000112", addresses: [{ address: "Str. Y 1" }] },
    }));
    expect(d.clientName).toBe("X Y");
    const types = await prisma.projectType.findMany({ where: { tenantId: f.a.id }, select: { code: true } });
    expect(types.map((t) => t.code).sort()).toEqual(["bransament", "conducta", "dosar_iscir", "revizie_centrala"]);
  });

  it("ensureDefaultProjectTypes nu dublează și nu atinge tipurile existente", async () => {
    await prisma.projectType.updateMany({ where: { tenantId: f.a.id, code: "bransament" }, data: { name: "Numele firmei" } });
    await ensureDefaultProjectTypes(prisma, f.a.id);
    await ensureDefaultProjectTypes(prisma, f.a.id);
    const types = await prisma.projectType.findMany({ where: { tenantId: f.a.id } });
    expect(types).toHaveLength(4);
    expect(types.find((t) => t.code === "bransament")!.name).toBe("Numele firmei");
  });
});

describe("dosare — izolarea între firme", () => {
  it("dosarul lui B nu se vede, nu se modifică și nu se generează din A", async () => {
    const d = await newDossier(f.b.id, f.b.clientId);
    for (const call of [
      () => dossiers.get(app, f.a.id, d.id),
      () => dossiers.update(app, f.a.id, d.id, { metadata: { cod_atr: "X" } }),
      () => dossiers.generate(app, f.a.id, f.a.admin.id, d.id),
      () => dossiers.remove(app, f.a.id, d.id),
    ]) {
      expect((await expectReject(call)).status).toBe(404);
    }
    expect(await dossiers.list(app, f.a.id)).toHaveLength(0);
  });

  it("clientul, angajatul sau grupul altei firme → respins", async () => {
    expect((await expectReject(() => newDossier(f.a.id, f.b.clientId))).status).toBe(404);
    const d = await newDossier(f.a.id, f.a.clientId);
    expect((await expectReject(() => dossiers.update(app, f.a.id, d.id, { clientId: f.b.clientId }))).status).toBe(404);
    expect((await expectReject(() => dossiers.update(app, f.a.id, d.id, { teamMembers: [{ role: "rte", employeeId: f.b.employeeId }] }))).status).toBe(400);
    const own = await prisma.documentTemplate.create({ data: { tenantId: f.b.id, categoryCode: "CARTE_BRANSAMENT", name: "Grup B", type: "group" } });
    expect((await expectReject(() => dossiers.getFields(app, f.a.id, own.id))).status).toBe(404);
    expect((await expectReject(() => dossiers.update(app, f.a.id, d.id, { templateGroupId: own.id }))).status).toBe(404);
  });
});
