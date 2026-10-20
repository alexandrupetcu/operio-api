import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { seedTwoTenants, type TwoTenants } from "../../test/fixtures.js";
import { resolveSignatory } from "./signatories.js";

let f: TwoTenants;
beforeEach(async () => {
  f = await seedTwoTenants();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const stamp = (name: string, s3Key: string | null) =>
  prisma.employeeStamp.create({ data: { tenantId: f.a.id, employeeId: f.a.employeeId, name, authority: "ISCIR", s3Key } });
const cert = (type: string, number: string, stampId: string | null) =>
  prisma.employeeCertification.create({ data: { tenantId: f.a.id, employeeId: f.a.employeeId, type, number, stampId } });

describe("ștampila de pe document = ștampila pe care e trecută certificarea folosită", () => {
  it("RVT pe o ștampilă proprie, fără imagine → fără ștampilă (nu împrumută ștampila RSL-IP)", async () => {
    const rslStamp = await stamp("Ștampilă ISCIR", `${f.a.id}/employees/x/rsl.png`);
    const rvtStamp = await stamp("Ștampilă ISCIR RVT", null);
    await cert("iscir_rsl", "RSL-4471", rslStamp.id);
    await cert("iscir_rvt", "RVT-0921", rvtStamp.id);

    const rvt = await resolveSignatory(prisma, f.a.id, "rvt", { technicianEmployeeId: f.a.employeeId });
    expect(rvt?.number).toBe("RVT-0921");
    expect(rvt?.stampS3Key).toBeNull();
    const rsl = await resolveSignatory(prisma, f.a.id, "rsl", { technicianEmployeeId: f.a.employeeId });
    expect(rsl?.stampS3Key).toBe(`${f.a.id}/employees/x/rsl.png`);
  });

  it("RVT și RSL-IP pe aceeași ștampilă → aceeași imagine pe ambele casete", async () => {
    const both = await stamp("Ștampilă ISCIR", `${f.a.id}/employees/x/iscir.png`);
    await cert("iscir_rsl", "15902", both.id);
    await cert("iscir_rvt", "15902", both.id);
    const rvt = await resolveSignatory(prisma, f.a.id, "rvt", { technicianEmployeeId: f.a.employeeId });
    expect(rvt?.stampS3Key).toBe(`${f.a.id}/employees/x/iscir.png`);
  });

  it("certificare pe nicio ștampilă → fără ștampilă", async () => {
    await cert("iscir_rvt", "RVT-1", null);
    expect((await resolveSignatory(prisma, f.a.id, "rvt", { technicianEmployeeId: f.a.employeeId }))?.stampS3Key).toBeNull();
  });
});
