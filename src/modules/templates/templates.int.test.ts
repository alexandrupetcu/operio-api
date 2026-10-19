import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, expectReject, serviceStub } from "../../test/stub.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";

// S3 nu există în suita de integrare: reținem doar cheile atinse.
const s3 = vi.hoisted(() => ({ uploaded: [] as string[], deleted: [] as string[] }));
vi.mock("../../lib/s3.js", () => ({
  uploadFile: async (key: string) => {
    s3.uploaded.push(key);
  },
  deleteFile: async (key: string) => {
    s3.deleted.push(key);
  },
  getPresignedUrl: async (key: string) => `https://s3.test/${key}`,
  getFileBuffer: async () => Buffer.from("docx"),
}));

import * as templates from "./templates.service.js";

let app: FastifyInstance;
let f: TwoTenants;
let systemGroup: { id: string };
let systemMember: { id: string };
let systemDocx: { id: string };
let groupB: { id: string };
let docxB: { id: string };

const CATEGORY = "TEST_TEMPLATES";
const docxFile = (name = "anexa.docx") => ({ buffer: Buffer.from("docx"), filename: name, mimetype: "application/octet-stream" });
const multipart = (name = "nou.docx") =>
  ({ filename: name, mimetype: "application/octet-stream", toBuffer: async () => Buffer.from("docx") }) as never;

beforeEach(async () => {
  app = await serviceStub();
  f = await seedTwoTenants();
  s3.uploaded.length = 0;
  s3.deleted.length = 0;
  await prisma.templateCategory.upsert({
    where: { code: CATEGORY },
    create: { code: CATEGORY, name: "Categorie test" },
    update: {},
  });
  // Șabloanele de sistem (tenantId null) — comune tuturor firmelor.
  systemGroup = await prisma.documentTemplate.create({
    data: { tenantId: null, categoryCode: CATEGORY, name: "Dosar sistem", type: "group" },
  });
  systemMember = await prisma.documentTemplate.create({
    data: { tenantId: null, categoryCode: CATEGORY, name: "Membru sistem", s3Key: "templates/system/m.docx", parentGroupId: systemGroup.id },
  });
  systemDocx = await prisma.documentTemplate.create({
    data: { tenantId: null, categoryCode: CATEGORY, name: "DOCX sistem", s3Key: "templates/system/d.docx" },
  });
  groupB = await prisma.documentTemplate.create({
    data: { tenantId: f.b.id, categoryCode: CATEGORY, name: "Dosar B", type: "group" },
  });
  docxB = await prisma.documentTemplate.create({
    data: { tenantId: f.b.id, categoryCode: CATEGORY, name: "DOCX B", s3Key: `templates/${f.b.id}/b.docx` },
  });
});
afterAll(async () => {
  await closeStub();
  await prisma.$disconnect();
});

describe("grupuri DOCX de sistem — doar MASTER_ADMIN le modifică", () => {
  it("adminul unei firme nu poate adăuga documente într-un grup de sistem (403, nimic urcat)", async () => {
    const err = await expectReject(() => templates.addGroupDocs(app, f.a.id, systemGroup.id, [docxFile()], "ADMIN"));
    expect(err.status).toBe(403);
    expect(await prisma.documentTemplate.count({ where: { parentGroupId: systemGroup.id } })).toBe(1);
    expect(s3.uploaded).toHaveLength(0);
  });

  it("adminul unei firme nu poate șterge un document dintr-un grup de sistem", async () => {
    const err = await expectReject(() => templates.removeGroupDoc(app, f.a.id, systemGroup.id, systemMember.id, "ADMIN"));
    expect(err.status).toBe(403);
    expect(await prisma.documentTemplate.findUnique({ where: { id: systemMember.id } })).not.toBeNull();
  });

  it("adminul unei firme nu poate reordona un grup de sistem", async () => {
    const err = await expectReject(() => templates.reorderGroupDocs(app, f.a.id, systemGroup.id, [systemMember.id], "MANAGER"));
    expect(err.status).toBe(403);
  });

  it("MASTER_ADMIN poate adăuga în grupul de sistem; membrul rămâne de sistem", async () => {
    const [created] = await templates.addGroupDocs(app, f.a.id, systemGroup.id, [docxFile()], "MASTER_ADMIN");
    expect(created.tenantId).toBeNull();
    expect(s3.uploaded[0]).toMatch(/^templates\/system\//);
  });

  it("grupul propriu al firmei se poate modifica de adminul ei; membrul e al firmei", async () => {
    const own = await templates.createGroup(app, f.a.id, { name: "Dosar A", category: CATEGORY });
    const [created] = await templates.addGroupDocs(app, f.a.id, own.id, [docxFile()], "ADMIN");
    expect(created.tenantId).toBe(f.a.id);
    expect(s3.uploaded[0]).toMatch(new RegExp(`^templates/${f.a.id}/`));
    await templates.removeGroupDoc(app, f.a.id, own.id, created.id, "ADMIN");
    expect(await prisma.documentTemplate.count({ where: { parentGroupId: own.id } })).toBe(0);
  });

  it("grupul altei firme → 404", async () => {
    const err = await expectReject(() => templates.addGroupDocs(app, f.a.id, groupB.id, [docxFile()], "ADMIN"));
    expect(err.status).toBe(404);
  });
});

describe("fișierele DOCX ale șabloanelor — pe firmă pentru admini, oricare pentru MASTER_ADMIN", () => {
  const adminA = () => ({ tenantId: f.a.id, role: "ADMIN" });

  it("adminul firmei descarcă un șablon de sistem și unul propriu", async () => {
    const own = await templates.createFromFile(app, f.a.id, multipart(), "DOCX A", CATEGORY);
    expect((await templates.getDownloadUrl(app, systemDocx.id, adminA())).url).toContain("templates/system/");
    expect((await templates.getDownloadUrl(app, own.id, adminA())).url).toContain(`templates/${f.a.id}/`);
    expect((await templates.getFileContent(app, own.id, adminA())).buffer).toBeInstanceOf(Buffer);
  });

  it("adminul firmei NU descarcă și NU citește DOCX-ul altei firme (404)", async () => {
    expect((await expectReject(() => templates.getDownloadUrl(app, docxB.id, adminA()))).status).toBe(404);
    expect((await expectReject(() => templates.getFileContent(app, docxB.id, adminA()))).status).toBe(404);
  });

  it("adminul firmei înlocuiește fișierul propriu, în folderul firmei", async () => {
    const own = await templates.createFromFile(app, f.a.id, multipart(), "DOCX A", CATEGORY);
    s3.uploaded.length = 0;
    const updated = await templates.replaceFile(app, own.id, multipart("v2.docx"), adminA());
    expect(updated.s3Key).toMatch(new RegExp(`^templates/${f.a.id}/`));
    expect(s3.uploaded).toHaveLength(1);
  });

  it("adminul firmei NU înlocuiește fișierul unui șablon de sistem (403) sau al altei firme (404)", async () => {
    expect((await expectReject(() => templates.replaceFile(app, systemDocx.id, multipart(), adminA()))).status).toBe(403);
    expect((await expectReject(() => templates.replaceFile(app, docxB.id, multipart(), adminA()))).status).toBe(404);
    expect(s3.uploaded).toHaveLength(0);
    expect(s3.deleted).toHaveLength(0);
  });

  it("MASTER_ADMIN ajunge la orice șablon (lista lui de admin le arată pe toate)", async () => {
    const master = { tenantId: f.a.id, role: "MASTER_ADMIN" };
    expect((await templates.getDownloadUrl(app, docxB.id, master)).url).toContain(f.b.id);
    const updated = await templates.replaceFile(app, systemDocx.id, multipart(), master);
    expect(updated.s3Key).toMatch(/^templates\/system\//);
  });
});

describe("crearea din pagina adminului de firmă salvează pe firmă", () => {
  it("HTML, DOCX și grupul primesc tenantId-ul firmei, nu null", async () => {
    const html = await templates.create(app, f.a.id, { category: CATEGORY, name: "HTML A", content: "<p>x</p>" });
    const docx = await templates.createFromFile(app, f.a.id, multipart(), "DOCX A", CATEGORY);
    const group = await templates.createGroup(app, f.a.id, { name: "Dosar A", category: CATEGORY });
    expect([html.tenantId, docx.tenantId, group.tenantId]).toEqual([f.a.id, f.a.id, f.a.id]);
  });

  it("lista firmei arată șabloanele proprii + cele de sistem, nu ale altei firme", async () => {
    await templates.create(app, f.a.id, { category: CATEGORY, name: "HTML A" });
    const { data } = await templates.list(app, f.a.id, { limit: 50 });
    const names = data.map((t) => t.name).sort();
    expect(names).toEqual(["DOCX sistem", "Dosar sistem", "HTML A"]);
  });
});
