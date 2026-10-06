-- Catch-up migration: the dev database was evolved with `prisma db push`, so these
-- changes never got a migration. Generated with `prisma migrate diff` from the
-- migration history (up to 20260726120000) to schema.prisma; the Employee.userId
-- pieces are left to 20260727090000_employee_user_link, which still applies after this.

-- CreateEnum
CREATE TYPE "SigningStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SignatoryStatus" AS ENUM ('PENDING', 'SIGNED', 'DECLINED');

-- AlterEnum

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- DropForeignKey
ALTER TABLE "WorkflowStepInstance" DROP CONSTRAINT "WorkflowStepInstance_stepDefinitionId_fkey";

-- DropIndex
DROP INDEX "DocumentTemplate_tenantId_category_idx";

-- AlterTable
ALTER TABLE "Client" ALTER COLUMN "status" SET DEFAULT 'PROSPECT';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "contextJson" JSONB;

-- AlterTable
ALTER TABLE "DocumentTemplate" DROP COLUMN "category",
ADD COLUMN     "categoryCode" TEXT NOT NULL,
ADD COLUMN     "fileName" TEXT,
ADD COLUMN     "memberOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parentGroupId" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'single';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "credentials" JSONB,
ADD COLUMN     "employeeType" TEXT NOT NULL DEFAULT 'intern',
ADD COLUMN     "signatureS3Key" TEXT;

-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "airSupply" TEXT,
ADD COLUMN     "deviceAge" TEXT,
ADD COLUMN     "deviceType" TEXT,
ADD COLUMN     "feeding" TEXT,
ADD COLUMN     "fuelIscir" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "power" TEXT;

-- AlterTable
ALTER TABLE "EquipmentRevision" ADD COLUMN     "iscirDocumentId" TEXT,
ADD COLUMN     "sourceEmailId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "category" TEXT,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "vehicleId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "drawingJson" JSONB,
ADD COLUMN     "drawingS3Key" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'project',
ADD COLUMN     "templateGroupId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "emailIngestionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isVatPayer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "iscirDate" TEXT,
ADD COLUMN     "iscirNumber" TEXT,
ADD COLUMN     "logoS3Key" TEXT;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "avgKmPerMonth" INTEGER,
ADD COLUMN     "civS3Key" TEXT,
ADD COLUMN     "rcaS3Key" TEXT,
ADD COLUMN     "talonS3Key" TEXT,
ADD COLUMN     "vignetteExpiry" TIMESTAMP(3),
ADD COLUMN     "vignetteS3Key" TEXT;

-- AlterTable
ALTER TABLE "WorkflowStepInstance" ADD COLUMN     "adHocStepType" TEXT,
ADD COLUMN     "formSchemaJson" JSONB,
ADD COLUMN     "isAdHoc" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "stepDefinitionId" DROP NOT NULL;

-- DropEnum
DROP TYPE "DocumentCategory";

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasInstallation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientAddressId" TEXT,
    "label" TEXT,
    "distributorName" TEXT,
    "codTehnicPOD" TEXT,
    "codClient" TEXT,
    "contractNumber" TEXT,
    "contractDate" TEXT,
    "documentatieNr" TEXT,
    "documentatieData" TEXT,
    "contorTip" TEXT,
    "contorSeria" TEXT,
    "contorNr" TEXT,
    "contorAn" TEXT,
    "contorIndex" TEXT,
    "appliancesJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectTeamMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT,
    "role" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credentials" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "registrySeriesCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TemplateCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "SigningStatus" NOT NULL DEFAULT 'DRAFT',
    "message" TEXT,
    "documentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "signedDocumentS3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signatory" (
    "id" TEXT NOT NULL,
    "signingSessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT NOT NULL,
    "signOrder" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "status" "SignatoryStatus" NOT NULL DEFAULT 'PENDING',
    "signatureS3Key" TEXT,
    "signedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signatory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningEvent" (
    "id" TEXT NOT NULL,
    "signingSessionId" TEXT NOT NULL,
    "signatoryId" TEXT,
    "eventType" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SigningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleRevision" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "km" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expoToken" TEXT NOT NULL,
    "platform" TEXT,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionFeedState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conditionRef" TEXT NOT NULL,
    "snoozedUntil" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "reason" TEXT,
    "snoozedById" TEXT,
    "snoozedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionFeedState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionFeedSnoozeNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventType" TEXT NOT NULL DEFAULT 'snooze',
    "until" TIMESTAMP(3),
    "note" TEXT,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionFeedSnoozeNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrawingTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "canvasJson" JSONB NOT NULL,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrawingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "clientId" TEXT,
    "clientAddressId" TEXT,
    "employeeId" TEXT,
    "equipmentId" TEXT,
    "equipmentRevisionId" TEXT,
    "installationId" TEXT,
    "vehicleId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'general',
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "completionDataJson" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailInbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "label" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gmail',
    "refreshToken" TEXT,
    "accessToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "purpose" TEXT NOT NULL DEFAULT 'revision_import',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastPolledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrySeries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'INTERNAL',
    "prefix" TEXT,
    "startingNumber" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrySeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "counterpartName" TEXT,
    "fileS3Key" TEXT,
    "documentId" TEXT,
    "projectId" TEXT,
    "clientId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "isManualOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,

    CONSTRAINT "RegistryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailIngestLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inboxId" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "emailFrom" TEXT,
    "emailSubject" TEXT,
    "emailDate" TIMESTAMP(3),
    "fileName" TEXT,
    "s3Key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "parsedClientName" TEXT,
    "parsedClientSurname" TEXT,
    "parsedClientPhone" TEXT,
    "parsedClientEmail" TEXT,
    "parsedEquipmentName" TEXT,
    "parsedEquipmentSerial" TEXT,
    "parsedData" JSONB,
    "matchedClientId" TEXT,
    "matchedEquipmentId" TEXT,
    "matchedRevisionId" TEXT,
    "matchedAppointmentId" TEXT,
    "resolvedClientId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNotes" TEXT,
    "errorMessage" TEXT,
    "errorStep" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailIngestLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "GasInstallation_clientId_idx" ON "GasInstallation"("clientId");

-- CreateIndex
CREATE INDEX "GasInstallation_clientAddressId_idx" ON "GasInstallation"("clientAddressId");

-- CreateIndex
CREATE INDEX "ProjectTeamMember_projectId_role_idx" ON "ProjectTeamMember"("projectId", "role");

-- CreateIndex
CREATE INDEX "ProjectTeamMember_projectId_idx" ON "ProjectTeamMember"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateCategory_code_key" ON "TemplateCategory"("code");

-- CreateIndex
CREATE INDEX "SigningSession_tenantId_idx" ON "SigningSession"("tenantId");

-- CreateIndex
CREATE INDEX "SigningSession_documentId_idx" ON "SigningSession"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "Signatory_token_key" ON "Signatory"("token");

-- CreateIndex
CREATE INDEX "Signatory_signingSessionId_idx" ON "Signatory"("signingSessionId");

-- CreateIndex
CREATE INDEX "Signatory_token_idx" ON "Signatory"("token");

-- CreateIndex
CREATE INDEX "SigningEvent_signingSessionId_idx" ON "SigningEvent"("signingSessionId");

-- CreateIndex
CREATE INDEX "SigningEvent_signatoryId_idx" ON "SigningEvent"("signatoryId");

-- CreateIndex
CREATE INDEX "SigningEvent_eventType_idx" ON "SigningEvent"("eventType");

-- CreateIndex
CREATE INDEX "SigningEvent_createdAt_idx" ON "SigningEvent"("createdAt");

-- CreateIndex
CREATE INDEX "VehicleRevision_vehicleId_idx" ON "VehicleRevision"("vehicleId");

-- CreateIndex
CREATE INDEX "NotificationPreference_tenantId_userId_idx" ON "NotificationPreference"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_tenantId_userId_category_channel_key" ON "NotificationPreference"("tenantId", "userId", "category", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "WebPushSubscription_tenantId_userId_idx" ON "WebPushSubscription"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_expoToken_key" ON "PushDevice"("expoToken");

-- CreateIndex
CREATE INDEX "PushDevice_tenantId_userId_idx" ON "PushDevice"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "ActionFeedState_tenantId_idx" ON "ActionFeedState"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionFeedState_tenantId_actionKey_key" ON "ActionFeedState"("tenantId", "actionKey");

-- CreateIndex
CREATE INDEX "ActionFeedSnoozeNote_tenantId_actionKey_idx" ON "ActionFeedSnoozeNote"("tenantId", "actionKey");

-- CreateIndex
CREATE INDEX "DrawingTemplate_tenantId_idx" ON "DrawingTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "DrawingTemplate_isGlobal_idx" ON "DrawingTemplate"("isGlobal");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_equipmentRevisionId_key" ON "Appointment"("equipmentRevisionId");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_idx" ON "Appointment"("tenantId");

-- CreateIndex
CREATE INDEX "Appointment_projectId_idx" ON "Appointment"("projectId");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_date_idx" ON "Appointment"("tenantId", "date");

-- CreateIndex

-- CreateIndex
CREATE INDEX "Appointment_clientId_type_status_idx" ON "Appointment"("clientId", "type", "status");

-- CreateIndex
CREATE INDEX "Appointment_installationId_idx" ON "Appointment"("installationId");

-- CreateIndex
CREATE INDEX "Appointment_vehicleId_idx" ON "Appointment"("vehicleId");

-- CreateIndex
CREATE INDEX "Appointment_deletedAt_idx" ON "Appointment"("deletedAt");

-- CreateIndex
CREATE INDEX "EmailInbox_tenantId_idx" ON "EmailInbox"("tenantId");

-- CreateIndex
CREATE INDEX "EmailInbox_isActive_idx" ON "EmailInbox"("isActive");

-- CreateIndex
CREATE INDEX "RegistrySeries_tenantId_idx" ON "RegistrySeries"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrySeries_tenantId_code_key" ON "RegistrySeries"("tenantId", "code");

-- CreateIndex
CREATE INDEX "RegistryEntry_tenantId_year_idx" ON "RegistryEntry"("tenantId", "year");

-- CreateIndex
CREATE INDEX "RegistryEntry_seriesId_idx" ON "RegistryEntry"("seriesId");

-- CreateIndex
CREATE INDEX "RegistryEntry_documentId_idx" ON "RegistryEntry"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryEntry_tenantId_seriesId_year_number_key" ON "RegistryEntry"("tenantId", "seriesId", "year", "number");

-- CreateIndex
CREATE INDEX "EmailIngestLog_tenantId_status_idx" ON "EmailIngestLog"("tenantId", "status");

-- CreateIndex
CREATE INDEX "EmailIngestLog_emailMessageId_idx" ON "EmailIngestLog"("emailMessageId");

-- CreateIndex
CREATE INDEX "DocumentTemplate_tenantId_categoryCode_idx" ON "DocumentTemplate"("tenantId", "categoryCode");

-- CreateIndex
CREATE INDEX "DocumentTemplate_parentGroupId_memberOrder_idx" ON "DocumentTemplate"("parentGroupId", "memberOrder");

-- CreateIndex

-- CreateIndex
CREATE INDEX "Notification_tenantId_vehicleId_idx" ON "Notification"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_category_idx" ON "Notification"("tenantId", "category");

-- CreateIndex
CREATE INDEX "Notification_tenantId_userId_dedupeKey_idx" ON "Notification"("tenantId", "userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasInstallation" ADD CONSTRAINT "GasInstallation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasInstallation" ADD CONSTRAINT "GasInstallation_clientAddressId_fkey" FOREIGN KEY ("clientAddressId") REFERENCES "ClientAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_templateGroupId_fkey" FOREIGN KEY ("templateGroupId") REFERENCES "DocumentTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTeamMember" ADD CONSTRAINT "ProjectTeamMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTeamMember" ADD CONSTRAINT "ProjectTeamMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_categoryCode_fkey" FOREIGN KEY ("categoryCode") REFERENCES "TemplateCategory"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_parentGroupId_fkey" FOREIGN KEY ("parentGroupId") REFERENCES "DocumentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningSession" ADD CONSTRAINT "SigningSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningSession" ADD CONSTRAINT "SigningSession_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningSession" ADD CONSTRAINT "SigningSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signatory" ADD CONSTRAINT "Signatory_signingSessionId_fkey" FOREIGN KEY ("signingSessionId") REFERENCES "SigningSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningEvent" ADD CONSTRAINT "SigningEvent_signingSessionId_fkey" FOREIGN KEY ("signingSessionId") REFERENCES "SigningSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningEvent" ADD CONSTRAINT "SigningEvent_signatoryId_fkey" FOREIGN KEY ("signatoryId") REFERENCES "Signatory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleRevision" ADD CONSTRAINT "VehicleRevision_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey

-- AddForeignKey
ALTER TABLE "WorkflowStepInstance" ADD CONSTRAINT "WorkflowStepInstance_stepDefinitionId_fkey" FOREIGN KEY ("stepDefinitionId") REFERENCES "WorkflowStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionFeedState" ADD CONSTRAINT "ActionFeedState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionFeedSnoozeNote" ADD CONSTRAINT "ActionFeedSnoozeNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrawingTemplate" ADD CONSTRAINT "DrawingTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientAddressId_fkey" FOREIGN KEY ("clientAddressId") REFERENCES "ClientAddress"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_equipmentRevisionId_fkey" FOREIGN KEY ("equipmentRevisionId") REFERENCES "EquipmentRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GasInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailInbox" ADD CONSTRAINT "EmailInbox_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrySeries" ADD CONSTRAINT "RegistrySeries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "RegistrySeries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryEntry" ADD CONSTRAINT "RegistryEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailIngestLog" ADD CONSTRAINT "EmailIngestLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "WorkflowInstance_tenantId_entityType_entityId_parentWorkflow_id" RENAME TO "WorkflowInstance_tenantId_entityType_entityId_parentWorkflo_idx";

