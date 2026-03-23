-- CreateTable
CREATE TABLE "Country" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "iso3" CHAR(3) NOT NULL,
    "iso2" CHAR(2) NOT NULL,
    "numericCode" TEXT,
    "phonecode" TEXT,
    "capital" TEXT,
    "currency" TEXT,
    "currencyName" TEXT,
    "currencySymbol" TEXT,
    "tld" TEXT,
    "native" TEXT,
    "region" TEXT,
    "subregion" TEXT,
    "nationality" TEXT,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "emoji" TEXT,
    "emojiU" TEXT,

    CONSTRAINT "Country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "State" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "countryId" INTEGER NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "stateCode" TEXT,
    "type" TEXT,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),

    CONSTRAINT "State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "City" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "stateId" INTEGER NOT NULL,
    "countryId" INTEGER NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "stateCode" TEXT,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Country_iso3_key" ON "Country"("iso3");

-- CreateIndex
CREATE UNIQUE INDEX "Country_iso2_key" ON "Country"("iso2");

-- CreateIndex
CREATE INDEX "Country_name_idx" ON "Country"("name");

-- CreateIndex
CREATE INDEX "State_countryId_idx" ON "State"("countryId");

-- CreateIndex
CREATE INDEX "State_name_idx" ON "State"("name");

-- CreateIndex
CREATE INDEX "City_stateId_idx" ON "City"("stateId");

-- CreateIndex
CREATE INDEX "City_countryId_idx" ON "City"("countryId");

-- CreateIndex
CREATE INDEX "City_name_idx" ON "City"("name");

-- AddForeignKey
ALTER TABLE "State" ADD CONSTRAINT "State_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "State"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "Country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
