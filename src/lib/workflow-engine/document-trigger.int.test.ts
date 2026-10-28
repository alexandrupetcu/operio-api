import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { enqueuedJobs } from "../../test/setup-int.js";
import { triggerDocumentGeneration } from "./document-trigger.js";

let app: FastifyInstance;
let f: TwoTenants;
let instance: { id: string; entityId: string };
let stepInstanceId: string;
let projectId: string;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  enqueuedJobs.length = 0;
  const type = await prisma.projectType.create({ data: { tenantId: f.a.id, code: "bransament", name: "Branșament" } });
  const project = await prisma.project.create({
    data: { tenantId: f.a.id, clientId: f.a.clientId, projectTypeId: type.id, name: "P", address: "Str. X 1", city: "Jilava", county: "Ilfov" },
  });
  const def = await prisma.workflowDefinition.create({ data: { tenantId: f.a.id, code: "wf", name: "WF" } });
  const step = await prisma.workflowStep.create({ data: { workflowDefinitionId: def.id, code: "gen", name: "Generare", stepType: "document_generation" } });
  const wi = await prisma.workflowInstance.create({ data: { tenantId: f.a.id, workflowDefinitionId: def.id, entityId: project.id, entityType: "project", status: "active" } });
  const si = await prisma.workflowStepInstance.create({ data: { tenantId: f.a.id, workflowInstanceId: wi.id, stepDefinitionId: step.id, status: "active" } });
  instance = { id: wi.id, entityId: project.id };
  projectId = project.id;
  stepInstanceId = si.id;
});

afterAll(closeStub);

describe("triggerDocumentGeneration", () => {
  it("un șablon care nu mai există → pasul e marcat eșuat, nu rămâne în așteptare fără niciun document", async () => {
    const ok = await triggerDocumentGeneration(app, f.a.id, stepInstanceId, instance, { templateRef: "cmlipsa00000000000000000" });
    expect(ok).toBe(false);
    const si = await prisma.workflowStepInstance.findUniqueOrThrow({ where: { id: stepInstanceId } });
    expect(si.status).toBe("failed");
    expect(si.errorJson).toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(await prisma.document.count({ where: { tenantId: f.a.id } })).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });
});

describe("triggerDocumentGeneration — setul dosarului după distribuitorul proiectului", () => {
  async function groups() {
    await prisma.templateCategory.upsert({ where: { code: "CARTE_BRANSAMENT" }, update: {}, create: { code: "CARTE_BRANSAMENT", name: "Carte branșament" } });
    await prisma.documentTemplate.deleteMany({ where: { tenantId: null, name: { startsWith: "Test trigger" } } });
    const mk = (name: string, distributorCode: string | null) =>
      prisma.documentTemplate.create({ data: { tenantId: null, categoryCode: "CARTE_BRANSAMENT", name, type: "group", distributorCode } });
    return { dg: await mk("Test trigger Distrigaz", "DISTRIGAZ"), ng: await mk("Test trigger NEOGAS", "NEOGAS_GRID") };
  }

  it("alege grupul categoriei cu distribuitorul proiectului", async () => {
    const g = await groups();
    const d = await prisma.distributor.create({ data: { tenantId: f.a.id, code: "NEOGAS_GRID", name: "NEOGAS" } });
    await prisma.project.update({ where: { id: projectId }, data: { distributorId: d.id } });
    expect(await triggerDocumentGeneration(app, f.a.id, stepInstanceId, instance, { dossierCategory: "CARTE_BRANSAMENT" })).toBe(true);
    const doc = await prisma.document.findFirstOrThrow({ where: { tenantId: f.a.id } });
    expect(doc.templateId).toBe(g.ng.id);
  });

  it("setul ales în „Completează dosarul” are prioritate", async () => {
    const g = await groups();
    await prisma.project.update({ where: { id: projectId }, data: { templateGroupId: g.dg.id } });
    expect(await triggerDocumentGeneration(app, f.a.id, stepInstanceId, instance, { dossierCategory: "CARTE_BRANSAMENT" })).toBe(true);
    expect((await prisma.document.findFirstOrThrow({ where: { tenantId: f.a.id } })).templateId).toBe(g.dg.id);
  });

  it("fără distribuitor și fără set ales → pas eșuat, cu ce trebuie completat", async () => {
    await groups();
    expect(await triggerDocumentGeneration(app, f.a.id, stepInstanceId, instance, { dossierCategory: "CARTE_BRANSAMENT" })).toBe(false);
    const si = await prisma.workflowStepInstance.findUniqueOrThrow({ where: { id: stepInstanceId } });
    expect(si.status).toBe("failed");
    expect(si.errorJson).toMatchObject({ code: "DOSSIER_GROUP_NOT_FOUND" });
  });
});
