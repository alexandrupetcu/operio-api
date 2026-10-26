import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../test/prisma.js";
import { closeStub, serviceStub } from "../../test/stub.js";
import { searchCities, searchStates } from "./geography.service.js";

/**
 * Căutarea de județe / localități trebuie să meargă și fără diacritice: pe teren se
 * tastează „timis”, „iasi”, „bucuresti”, nu „Timiș”, „Iași”, „București”.
 */
let app: FastifyInstance;
const COUNTRY = 990_001;
const STATE_TIMIS = 990_101;
const STATE_IASI = 990_102;

beforeAll(async () => {
  app = await serviceStub();
  await prisma.city.deleteMany({ where: { countryId: COUNTRY } });
  await prisma.state.deleteMany({ where: { countryId: COUNTRY } });
  await prisma.country.deleteMany({ where: { id: COUNTRY } });
  await prisma.country.create({ data: { id: COUNTRY, name: "Testland", iso2: "T9", iso3: "TS9" } });
  await prisma.state.createMany({
    data: [
      { id: STATE_TIMIS, name: "Timiș", countryId: COUNTRY, countryCode: "T9" },
      { id: STATE_IASI, name: "Iași", countryId: COUNTRY, countryCode: "T9" },
      { id: 990_103, name: "Argeș", countryId: COUNTRY, countryCode: "T9" },
    ],
  });
  await prisma.city.createMany({
    data: [
      { id: 990_201, name: "Timișoara", stateId: STATE_TIMIS, countryId: COUNTRY, countryCode: "T9" },
      { id: 990_202, name: "Șag", stateId: STATE_TIMIS, countryId: COUNTRY, countryCode: "T9" },
      { id: 990_203, name: "Târgu Frumos", stateId: STATE_IASI, countryId: COUNTRY, countryCode: "T9" },
    ],
  });
});
afterAll(async () => {
  await prisma.city.deleteMany({ where: { countryId: COUNTRY } });
  await prisma.state.deleteMany({ where: { countryId: COUNTRY } });
  await prisma.country.deleteMany({ where: { id: COUNTRY } });
  await closeStub();
  await prisma.$disconnect();
});

describe("căutare fără diacritice", () => {
  it("județe: „timis” găsește Timiș, „Iași” și „iasi” dau același rezultat", async () => {
    expect((await searchStates(app.prisma, COUNTRY, "timis", 20)).map((s) => s.name)).toEqual(["Timiș"]);
    expect((await searchStates(app.prisma, COUNTRY, "Iași", 20)).map((s) => s.name)).toEqual(["Iași"]);
    expect((await searchStates(app.prisma, COUNTRY, "iasi", 20)).map((s) => s.name)).toEqual(["Iași"]);
    expect((await searchStates(app.prisma, COUNTRY, "ARGES", 20)).map((s) => s.name)).toEqual(["Argeș"]);
  });

  it("localități: „timisoara” / „sag” / „targu” găsesc orașele cu diacritice; fără q → toate, alfabetic", async () => {
    expect((await searchCities(app.prisma, STATE_TIMIS, "timisoara", 20)).map((c) => c.name)).toEqual(["Timișoara"]);
    expect((await searchCities(app.prisma, STATE_TIMIS, "sag", 20)).map((c) => c.name)).toEqual(["Șag"]);
    expect((await searchCities(app.prisma, STATE_IASI, "targu", 20)).map((c) => c.name)).toEqual(["Târgu Frumos"]);
    expect((await searchCities(app.prisma, STATE_TIMIS, undefined, 20)).map((c) => c.name)).toEqual(["Șag", "Timișoara"]);
  });

  it("caracterele speciale din q nu devin joker SQL", async () => {
    expect(await searchCities(app.prisma, STATE_TIMIS, "%", 20)).toEqual([]);
    expect(await searchCities(app.prisma, STATE_TIMIS, "_ag", 20)).toEqual([]);
    expect((await searchCities(app.prisma, STATE_TIMIS, "ag", 20)).map((c) => c.name)).toEqual(["Șag"]);
  });
});
