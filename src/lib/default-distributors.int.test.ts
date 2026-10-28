import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../test/fixtures.js";
import { ensureDefaultDistributors } from "./default-distributors.js";

let f: TwoTenants;
beforeEach(async () => {
  f = await seedTwoTenants();
});

describe("ensureDefaultDistributors", () => {
  it("adaugă distribuitorii cu seturi de dosare (după cod le găsesc workflow-urile generale)", async () => {
    await ensureDefaultDistributors(prisma, f.a.id);
    const codes = (await prisma.distributor.findMany({ where: { tenantId: f.a.id } })).map((d) => d.code).sort();
    expect(codes).toEqual(["DISTRIGAZ", "MEGACONSTRUCT", "NEOGAS_GRID"]);
  });

  it("au sediul, telefonul și faxul de pe site-urile lor (completate la cei fără date de contact)", async () => {
    await prisma.distributor.create({ data: { tenantId: f.a.id, code: "NEOGAS_GRID", name: "Neogas" } });
    await ensureDefaultDistributors(prisma, f.a.id);
    const mega = await prisma.distributor.findFirstOrThrow({ where: { tenantId: f.a.id, code: "MEGACONSTRUCT" } });
    expect(mega.contactJson).toMatchObject({ region: "București", sector: "Sector 3", phone: "021.310.30.15", fax: "021.313.00.33" });
    const neo = await prisma.distributor.findFirstOrThrow({ where: { tenantId: f.a.id, code: "NEOGAS_GRID" } });
    expect(neo.name).toBe("Neogas");
    expect(neo.contactJson).toMatchObject({ phone: "031.690.46.85", fax: "021.230.02.95" });
  });

  it("nu atinge distribuitorii pe care firma îi are deja (nume, contact)", async () => {
    await prisma.distributor.create({ data: { tenantId: f.a.id, code: "DISTRIGAZ", name: "Distrigaz al meu", contactJson: { phone: "1" } } });
    await ensureDefaultDistributors(prisma, f.a.id);
    await ensureDefaultDistributors(prisma, f.a.id);
    const d = await prisma.distributor.findMany({ where: { tenantId: f.a.id, code: "DISTRIGAZ" } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ name: "Distrigaz al meu", contactJson: { phone: "1" } });
  });
});
