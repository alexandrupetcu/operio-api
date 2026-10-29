-- CreateTable
CREATE TABLE "SessionHandoff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionHandoff_tokenHash_key" ON "SessionHandoff"("tokenHash");

-- CreateIndex
CREATE INDEX "SessionHandoff_userId_idx" ON "SessionHandoff"("userId");

-- AddForeignKey
ALTER TABLE "SessionHandoff" ADD CONSTRAINT "SessionHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

