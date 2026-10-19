import { PrismaClient } from "@prisma/client";
import { resolveTestDbUrl } from "./test-db-url.js";

/**
 * Clientul Prisma al suitei de integrare, legat explicit la `TEST_DATABASE_URL`
 * (nu la `DATABASE_URL`), ca un `.env` încărcat accidental să nu poată
 * redirecționa testele spre baza de dezvoltare.
 */
const { url } = resolveTestDbUrl(process.env.TEST_DATABASE_URL ?? "");

export const prisma = new PrismaClient({
  datasources: { db: { url } },
  log: process.env.INT_SQL_LOG ? ["query", "warn", "error"] : ["warn", "error"],
});

/**
 * Golește tot ce creează fixturile, în ordinea cheilor străine. Nu atinge
 * tabelele de geografie (Country/State/City), care sunt date de referință.
 */
export async function resetDb() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "RegistryEntry", "RegistrySeries",
      "Task", "Notification", "AuditLog",
      "Appointment", "EquipmentRevision", "Equipment", "GasInstallation",
      "ClientDocument", "ContactPerson", "ClientAddress", "Client",
      "Document",
      "MobileDevice", "RefreshToken", "PasswordResetToken",
      "Employee", "User", "Tenant"
    RESTART IDENTITY CASCADE
  `);
}

export async function disconnect() {
  await prisma.$disconnect();
}
