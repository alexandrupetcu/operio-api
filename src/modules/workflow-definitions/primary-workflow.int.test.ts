import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { clone, findPrimaryWorkflowFor } from "./workflow-definitions.service.js";

let app: FastifyInstance;
let f: TwoTenants;
const ids: Record<string, { bransament: string; conducta: string; distrigaz: string; neogas: string }> = {};

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  await prisma.workflowDefinition.deleteMany({ where: { tenantId: null, code: { startsWith: "test_general_" } } });
  for (const t of [f.a, f.b]) {
    const br = await prisma.projectType.create({ data: { tenantId: t.id, code: "bransament", name: "Branșament" } });
    const cd = await prisma.projectType.create({ data: { tenantId: t.id, code: "conducta", name: "Conductă" } });
    const dg = await prisma.distributor.create({ data: { tenantId: t.id, code: "DISTRIGAZ", name: "Distrigaz" } });
    const ng = await prisma.distributor.create({ data: { tenantId: t.id, code: "NEOGAS_GRID", name: "NEOGAS" } });
    ids[t.id] = { bransament: br.id, conducta: cd.id, distrigaz: dg.id, neogas: ng.id };
  }
});

afterAll(async () => {
  await prisma.workflowDefinition.deleteMany({ where: { tenantId: null, code: { startsWith: "test_general_" } } });
  await closeStub();
});

const general = (code: string, projectTypeCode: string, distributorCode: string | null) =>
  prisma.workflowDefinition.create({
    data: { tenantId: null, code: `test_general_${code}`, name: code, status: "published", role: "primary", projectTypeCode, distributorCode },
  });

describe("findPrimaryWorkflowFor — workflow-urile generale (de sistem)", () => {
  it("se potrivesc după codul tipului de proiect la ORICE firmă", async () => {
    const wf = await general("br", "bransament", null);
    for (const t of [f.a, f.b]) {
      const found = await findPrimaryWorkflowFor(app, t.id, ids[t.id].bransament, ids[t.id].neogas);
      expect(found?.id).toBe(wf.id);
    }
    expect(await findPrimaryWorkflowFor(app, f.b.id, ids[f.b.id].conducta, null)).toBeNull();
  });

  it("cel pe distribuitor bate pe cel general; al firmei bate pe amândouă", async () => {
    await general("br_any", "bransament", null);
    const dg = await general("br_dg", "bransament", "DISTRIGAZ");
    expect((await findPrimaryWorkflowFor(app, f.b.id, ids[f.b.id].bransament, ids[f.b.id].distrigaz))?.id).toBe(dg.id);
    const own = await prisma.workflowDefinition.create({
      data: { tenantId: f.b.id, code: "own", name: "own", status: "published", role: "primary", projectTypeId: ids[f.b.id].bransament },
    });
    expect((await findPrimaryWorkflowFor(app, f.b.id, ids[f.b.id].bransament, ids[f.b.id].distrigaz))?.id).toBe(own.id);
  });
});

describe("clone — un workflow general copiat într-o firmă", () => {
  it("primește tipul de proiect și distribuitorul firmei după cod", async () => {
    const wf = await general("clone", "bransament", "DISTRIGAZ");
    const copy = await clone(app, f.b.id, wf.id, f.b.admin.id);
    expect(copy?.tenantId).toBe(f.b.id);
    expect(copy?.projectTypeId).toBe(ids[f.b.id].bransament);
    expect(copy?.distributorId).toBe(ids[f.b.id].distrigaz);
  });
});
