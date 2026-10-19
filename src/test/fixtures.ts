import { prisma, resetDb } from "./prisma.js";

/**
 * Două firme complete și independente (A și B), fiecare cu ADMIN + OPERATOR,
 * un client cu o adresă, un angajat, o centrală și o programare. Tot ce verifică
 * izolarea între firme folosește aceste două seturi: orice id din B folosit în
 * contextul lui A trebuie respins.
 *
 * Fiecare fișier de test își cheamă `seedTwoTenants()` în `beforeEach` (care
 * face mai întâi `resetDb()`), deci fișierele sunt independente între ele.
 */

export interface TenantFixture {
  id: string;
  slug: string;
  admin: { id: string; email: string };
  operator: { id: string; email: string };
  clientId: string;
  addressId: string;
  employeeId: string;
  equipmentId: string;
  appointmentId: string;
  installationId: string;
}

export interface TwoTenants {
  a: TenantFixture;
  b: TenantFixture;
}

const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$fixture$fixture-not-a-real-hash";

async function seedTenant(key: string, name: string): Promise<TenantFixture> {
  const tenant = await prisma.tenant.create({
    data: {
      name,
      slug: `fixture-${key}`,
      // Planul implicit din schemă e „execution" (tot catalogul de funcții).
      settingsJson: { company: { name } },
    },
  });

  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `admin.${key}@fixture.test`,
      passwordHash: PASSWORD_HASH,
      firstName: "Admin",
      lastName: key.toUpperCase(),
      role: "ADMIN",
    },
  });
  const operator = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `operator.${key}@fixture.test`,
      passwordHash: PASSWORD_HASH,
      firstName: "Operator",
      lastName: key.toUpperCase(),
      role: "OPERATOR",
    },
  });

  const employee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      firstName: "Tehnician",
      lastName: key.toUpperCase(),
      position: "instalator",
      userId: operator.id,
    },
  });

  const client = await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "PERSON",
      status: "ACTIVE",
      firstName: "Ion",
      lastName: `Client${key.toUpperCase()}`,
      phone: key === "a" ? "0721000001" : "0721000002",
      addresses: { create: { address: `Str. Fixture ${key} nr. 1`, isPrimary: true } },
    },
    include: { addresses: true },
  });
  const addressId = client.addresses[0].id;

  const installation = await prisma.gasInstallation.create({
    data: { clientId: client.id, clientAddressId: addressId, codTehnicPOD: `POD-${key}` },
  });

  const equipment = await prisma.equipment.create({
    data: {
      clientId: client.id,
      clientAddressId: addressId,
      type: "CENTRALA",
      name: "Centrală fixture",
      internalName: "Centrală fixture",
      serial: `SER-${key}`,
    },
  });

  const appointment = await prisma.appointment.create({
    data: {
      tenantId: tenant.id,
      clientId: client.id,
      clientAddressId: addressId,
      employeeId: employee.id,
      equipmentId: equipment.id,
      type: "revizie",
      title: `Revizie fixture ${key}`,
      date: new Date("2026-10-20T09:00:00.000Z"),
      duration: 60,
    },
  });

  return {
    id: tenant.id,
    slug: tenant.slug,
    admin: { id: admin.id, email: admin.email },
    operator: { id: operator.id, email: operator.email },
    clientId: client.id,
    addressId,
    employeeId: employee.id,
    equipmentId: equipment.id,
    appointmentId: appointment.id,
    installationId: installation.id,
  };
}

/** Golește baza și creează firmele A și B. */
export async function seedTwoTenants(): Promise<TwoTenants> {
  await resetDb();
  const a = await seedTenant("a", "Firma A SRL");
  const b = await seedTenant("b", "Firma B SRL");
  return { a, b };
}

/** O serie de registratură pentru o firmă (registratura nu e în fixtura de bază). */
export async function seedRegistrySeries(tenantId: string, code = "iesiri") {
  return prisma.registrySeries.create({
    data: { tenantId, code, name: `Serie ${code}`, direction: code === "intrari" ? "IN" : "OUT", prefix: "OUT" },
  });
}

/** Un document al firmei (pentru legături din registratură). */
export async function seedDocument(tenantId: string, name = "Document fixture") {
  return prisma.document.create({ data: { tenantId, name } });
}
