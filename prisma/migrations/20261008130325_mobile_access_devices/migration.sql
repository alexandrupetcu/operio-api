-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "client" TEXT NOT NULL DEFAULT 'web',
ADD COLUMN     "deviceId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mobileAccess" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MobileDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "platform" TEXT,
    "model" TEXT,
    "name" TEXT,
    "appVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "MobileDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileDevice_tenantId_userId_idx" ON "MobileDevice"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MobileDevice_userId_deviceId_key" ON "MobileDevice"("userId", "deviceId");

-- AddForeignKey
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileDevice" ADD CONSTRAINT "MobileDevice_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
