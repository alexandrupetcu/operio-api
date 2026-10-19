import { afterAll, beforeEach, describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { prisma } from "../../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { getStampUsage } from "./stamp-usage.js";

let f: TwoTenants;
const CATEGORY = "TEST_STAMPS";
const files = new Map<string, Buffer>();
const readFile = async (key: string) => {
  const b = files.get(key);
  if (!b) throw new Error("missing");
  return b;
};
const docx = (key: string, body: string) => {
  const zip = new PizZip();
  zip.file("word/document.xml", `<w:t>${body}</w:t>`);
  files.set(key, zip.generate({ type: "nodebuffer" }));
  return key;
};

beforeEach(async () => {
  f = await seedTwoTenants();
  files.clear();
  await prisma.templateCategory.upsert({ where: { code: CATEGORY }, create: { code: CATEGORY, name: "Test" }, update: {} });
});
afterAll(async () => {
  await prisma.$disconnect();
});

const tpl = (data: Record<string, unknown>) =>
  prisma.documentTemplate.create({ data: { categoryCode: CATEGORY, name: "x", ...data } as never });

describe("getStampUsage — unde apare fiecare ștampilă", () => {
  it("HTML de sistem + DOCX propriu dintr-un grup; nu și șabloanele altei firme sau cele inactive", async () => {
    await tpl({ tenantId: null, name: "Fișă RT", content: "<img src='{{tenant_stamp}}'>" });
    const group = await tpl({ tenantId: f.a.id, name: "Dosar A", type: "group" });
    await tpl({ tenantId: f.a.id, name: "Anexa", s3Key: docx(`templates/${f.a.id}/1-anexa.docx`, "{%tenant_stamp_2}"), parentGroupId: group.id });
    await tpl({ tenantId: f.b.id, name: "DOCX B", s3Key: docx(`templates/${f.b.id}/1-b.docx`, "{%tenant_stamp_3}") });
    await tpl({ tenantId: f.a.id, name: "Inactiv", content: "{{tenant_stamp_4}}", isActive: false });

    const usage = await getStampUsage(prisma, f.a.id, readFile);
    const names = (slot: number) => usage.find((u) => u.slot === slot)!.templates.map((t) => `${t.name}${t.groupName ? ` (${t.groupName})` : ""}`);
    expect(names(1)).toEqual(["Fișă RT"]);
    expect(names(2)).toEqual(["Anexa (Dosar A)"]);
    expect(names(3)).toEqual([]);
    expect(names(4)).toEqual([]);
  });

  it("membrii unui grup dezactivat nu contează; un DOCX ilizibil nu strică răspunsul", async () => {
    const group = await tpl({ tenantId: f.a.id, name: "Dosar vechi", type: "group", isActive: false });
    await tpl({ tenantId: f.a.id, name: "Anexa", s3Key: docx(`templates/${f.a.id}/2-a.docx`, "{%tenant_stamp_2}"), parentGroupId: group.id });
    await tpl({ tenantId: f.a.id, name: "Lipsă", s3Key: `templates/${f.a.id}/lipsa.docx` });

    const usage = await getStampUsage(prisma, f.a.id, readFile);
    expect(usage.every((u) => u.templates.length === 0)).toBe(true);
  });
});
