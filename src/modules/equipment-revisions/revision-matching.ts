import type { PrismaClient } from "@prisma/client";

interface ParsedClientData {
  clientName?: string | null;
  clientSurname?: string | null;
  clientAddress?: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
}

interface ParsedEquipmentData {
  equipmentName?: string | null;
  equipmentSerial?: string | null;
  fuel?: string | null;
}

/**
 * Match client by phone or email ONLY.
 * Returns null if no match found (caller decides: needs_review or create).
 */
export async function matchClient(
  prisma: PrismaClient,
  tenantId: string,
  parsed: ParsedClientData
): Promise<{ id: string } | null> {
  const phone = parsed.clientPhone?.trim();
  const email = parsed.clientEmail?.trim();

  // Strategy 1: Match by phone
  if (phone) {
    const byPhone = await prisma.client.findFirst({
      where: { tenantId, phone },
    });
    if (byPhone) return byPhone;
  }

  // Strategy 2: Match by email
  if (email && email !== "---") {
    const byEmail = await prisma.client.findFirst({
      where: { tenantId, email: { equals: email, mode: "insensitive" } },
    });
    if (byEmail) return byEmail;
  }

  // No match — return null (do NOT create automatically)
  return null;
}

/**
 * Match equipment by serial, or find one with a PENDING revision, or create new.
 * Equipment matching always resolves (never returns null).
 */
export async function matchOrCreateEquipment(
  prisma: PrismaClient,
  clientId: string,
  parsed: ParsedEquipmentData
): Promise<{ id: string }> {
  const serial = parsed.equipmentSerial?.trim();

  // Strategy 1: Match by serial number on this client
  if (serial) {
    const bySerial = await prisma.equipment.findFirst({
      where: { clientId, serial },
    });
    if (bySerial) return bySerial;
  }

  // Strategy 2: Find equipment that has a PENDING revision (created at finalize)
  const withPendingRevision = await prisma.equipment.findFirst({
    where: {
      clientId,
      revisions: {
        some: {
          status: "PENDING",
          sourceEmailId: null,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  if (withPendingRevision) {
    // Update serial if we have one from PDF
    if (serial) {
      await prisma.equipment.update({
        where: { id: withPendingRevision.id },
        data: { serial },
      });
    }
    return withPendingRevision;
  }

  // Strategy 3: Create new equipment with data from PDF
  const name = parsed.equipmentName || "Centrala (auto-import)";
  return prisma.equipment.create({
    data: {
      clientId,
      type: "CENTRALA",
      name,
      internalName: name,
      serial: serial || null,
      fuel: parsed.fuel || null,
    },
  });
}
