import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  // Create demo tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    update: {},
    create: {
      name: "Demo Gas Company",
      slug: "demo",
    },
  });

  // Create admin user
  const passwordHash = await argon2.hash("password123");
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.com" } },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "admin@demo.com",
      passwordHash,
      firstName: "Admin",
      lastName: "User",
      role: "ADMIN",
    },
  });

  // Create operator user
  await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId: tenant.id, email: "operator@demo.com" },
    },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "operator@demo.com",
      passwordHash,
      firstName: "Operator",
      lastName: "User",
      role: "OPERATOR",
    },
  });

  // Create sample company client
  await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "COMPANY",
      companyName: "SC Gaz Construct SRL",
      cui: "RO12345678",
      address: "Str. Industriei nr. 15",
      city: "Cluj-Napoca",
      county: "Cluj",
      phone: "0264-123-456",
      email: "office@gazconstruct.ro",
      contactPersons: {
        create: [
          {
            firstName: "Ion",
            lastName: "Popescu",
            phone: "0740-111-222",
            email: "ion.popescu@gazconstruct.ro",
          },
          {
            firstName: "Maria",
            lastName: "Ionescu",
            phone: "0740-333-444",
            email: "maria.ionescu@gazconstruct.ro",
          },
        ],
      },
    },
  });

  // Create sample person client
  await prisma.client.create({
    data: {
      tenantId: tenant.id,
      type: "PERSON",
      firstName: "Vasile",
      lastName: "Georgescu",
      address: "Str. Florilor nr. 7",
      city: "Oradea",
      county: "Bihor",
      phone: "0740-555-666",
      email: "vasile.georgescu@email.ro",
    },
  });

  console.log("Seed completed: tenant 'demo' with admin@demo.com / password123");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
