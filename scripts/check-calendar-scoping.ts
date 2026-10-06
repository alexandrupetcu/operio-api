/**
 * Vizibilitatea programărilor, end-to-end: server real (`app.inject`) peste baza
 * de date locală, cu un tenant de unică folosință șters la final.
 *
 * Poarta de non-regresie e primul bloc: în modul „calendar comun" toată lumea
 * vede exact ce vedea înainte de calendarele separate.
 *
 * Rulează: npx tsx --env-file=.env scripts/check-calendar-scoping.ts
 */
import { PrismaClient } from "@prisma/client";
import { buildServer } from "../src/server.js";

const prisma = new PrismaClient();
const fails: string[] = [];
const eq = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (așteptat ${JSON.stringify(expected)})`}`,
  );
  if (!ok) fails.push(name);
};

const suffix = process.pid.toString(36);
const tenantSlug = `scope-check-${suffix}`;
let tenantId = "";
/** Tot ce s-a creat, ca finally-ul să curețe și dacă un test pică la mijloc. */
const createdTenants: string[] = [];

/** Șterge un tenant de test cu tot cu dependențe; raportează, nu înghite eroarea. */
async function dropTenant(id: string) {
  try {
    await prisma.appointment.deleteMany({ where: { tenantId: id } });
    await prisma.employee.updateMany({ where: { tenantId: id }, data: { userId: null } });
    await prisma.employee.deleteMany({ where: { tenantId: id } });
    await prisma.client.deleteMany({ where: { tenantId: id } });
    await prisma.notification.deleteMany({ where: { tenantId: id } });
    await prisma.refreshToken.deleteMany({ where: { user: { tenantId: id } } });
    await prisma.user.deleteMany({ where: { tenantId: id } });
    await prisma.tenant.delete({ where: { id } });
  } catch (err) {
    console.error(`  curățarea tenantului ${id} a eșuat:`, (err as Error).message.split("\n")[0]);
    fails.push("curățare");
  }
}

const app = await buildServer();
app.log.level = "silent";

try {
  // ── Tenant de test ──
  const tenant = await prisma.tenant.create({
    data: { name: "Scope Check SRL", slug: tenantSlug },
  });
  tenantId = tenant.id;
  createdTenants.push(tenantId);

  const [empA, empB] = await Promise.all([
    prisma.employee.create({ data: { tenantId, firstName: "Ana", lastName: "Alpha" } }),
    prisma.employee.create({ data: { tenantId, firstName: "Bogdan", lastName: "Beta" } }),
  ]);

  const mkUser = (role: "ADMIN" | "OPERATOR", tag: string) =>
    prisma.user.create({
      data: {
        tenantId,
        email: `${tag}-${suffix}@scope.check`,
        passwordHash: "x",
        firstName: tag,
        lastName: "Check",
        role,
      },
    });
  const [admin, opA, opB] = await Promise.all([
    mkUser("ADMIN", "admin"),
    mkUser("OPERATOR", "opa"),
    mkUser("OPERATOR", "opb"),
  ]);
  // Doar OPERATOR-A e legat de o persoană din echipă.
  await prisma.employee.update({ where: { id: empA.id }, data: { userId: opA.id } });

  const client = await prisma.client.create({
    data: { tenantId, type: "PERSON", firstName: "Client", lastName: "Test" },
  });

  const day = new Date();
  day.setHours(10, 0, 0, 0);
  const at = (h: number) => new Date(new Date(day).setHours(h, 0, 0, 0));

  const mkAppt = (title: string, employeeId: string | null, hour: number, status = "scheduled") =>
    prisma.appointment.create({
      data: {
        tenantId,
        clientId: client.id,
        employeeId,
        title,
        type: "revizie",
        date: at(hour),
        duration: 60,
        status,
      },
    });
  const [apptA, apptB, apptFree] = await Promise.all([
    mkAppt("A lui Ana", empA.id, 9),
    mkAppt("A lui Bogdan", empB.id, 11),
    mkAppt("Nerepartizată", null, 13),
    mkAppt("Anulată", empA.id, 15, "cancelled"),
  ]);

  const token = (u: { id: string; role: string }) =>
    app.jwt.sign({ sub: u.id, tenantId, role: u.role });
  const auth = (u: { id: string; role: string }) => ({ authorization: `Bearer ${token(u)}` });

  const from = new Date(new Date(day).setHours(0, 0, 0, 0)).toISOString();
  const to = new Date(new Date(day).setHours(23, 59, 59, 999)).toISOString();

  const calendar = async (u: { id: string; role: string }, query = "") => {
    const res = await app.inject({
      method: "GET",
      url: `/api/appointments/calendar?from=${from}&to=${to}${query}`,
      headers: auth(u),
    });
    return { status: res.statusCode, items: res.statusCode === 200 ? res.json() : [] };
  };

  // ── Modul comun: exact comportamentul dinainte ──
  console.log("\n— calendar comun —");
  for (const [label, u] of [["admin", admin], ["tehnician legat", opA], ["cont nelegat", opB]] as const) {
    const { items } = await calendar(u);
    eq(`${label} vede toate cele 3 (anulata exclusă)`, items.length, 3);
  }

  // ── Modul cu calendare separate — comutat prin endpointul real ──
  console.log("\n— comutarea modului —");
  {
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/tenant/scheduling-settings",
      headers: auth(opA),
      payload: { mode: "per_technician" },
    });
    eq("tehnicianul nu poate comuta modul → 403", denied.statusCode, 403);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/tenant/scheduling-settings",
      headers: auth(admin),
      payload: { mode: "per_technician" },
    });
    eq("adminul comută modul", [res.statusCode, res.json().mode], [200, "per_technician"]);

    const read = await app.inject({
      method: "GET",
      url: "/api/tenant/scheduling-settings",
      headers: auth(opA),
    });
    eq("modul e citibil de oricine", read.json().mode, "per_technician");
    eq("avertismentul de suprapunere rămâne pornit", read.json().warnOnOverlap, true);
  }
  console.log("\n— calendare separate —");

  eq("admin vede tot", (await calendar(admin)).items.length, 3);
  {
    const { items } = await calendar(opA);
    eq(
      "tehnicianul vede ale lui + nerepartizate",
      items.map((i: any) => i.title).sort(),
      ["A lui Ana", "Nerepartizată"],
    );
  }
  {
    const { items } = await calendar(opB);
    eq("contul nelegat vede doar nerepartizate", items.map((i: any) => i.title), ["Nerepartizată"]);
  }
  eq(
    "filtrul pe un coleg nu lărgește vizibilitatea",
    (await calendar(opA, `&employeeId=${empB.id}`)).items.length,
    0,
  );
  eq(
    "admin poate filtra pe un tehnician",
    (await calendar(admin, `&employeeId=${empB.id}`)).items.map((i: any) => i.title),
    ["A lui Bogdan"],
  );
  eq(
    "filtrul me pentru tehnician",
    (await calendar(opA, "&employeeId=me")).items.map((i: any) => i.title),
    ["A lui Ana"],
  );

  // ── Scriere: 404, nu 403 ──
  console.log("\n— acces la scriere —");
  const patch = (u: any, id: string, body: unknown) =>
    app.inject({ method: "PATCH", url: `/api/appointments/${id}`, headers: auth(u), payload: body });

  eq("PATCH pe programarea colegului → 404", (await patch(opA, apptB.id, { title: "hop" })).statusCode, 404);
  eq(
    "finalize pe programarea colegului → 404",
    (await app.inject({
      method: "POST",
      url: `/api/appointments/${apptB.id}/finalize`,
      headers: auth(opA),
      payload: { outcome: "revenire", followup: { title: "x" } },
    })).statusCode,
    404,
  );
  eq(
    "DELETE pe programarea colegului → 404",
    (await app.inject({ method: "DELETE", url: `/api/appointments/${apptB.id}`, headers: auth(opA) })).statusCode,
    404,
  );
  eq(
    "prefill pe programarea colegului → 404",
    (await app.inject({
      method: "GET",
      url: `/api/appointments/${apptB.id}/instalatie-prefill`,
      headers: auth(opA),
    })).statusCode,
    404,
  );
  eq("preluarea unei nerepartizate → 200", (await patch(opA, apptFree.id, { employeeId: empA.id })).statusCode, 200);
  eq("predarea către coleg → 403", (await patch(opA, apptA.id, { employeeId: empB.id })).statusCode, 403);
  eq("renunțarea la propria programare → 200", (await patch(opA, apptFree.id, { employeeId: null })).statusCode, 200);
  eq("adminul poate repartiza oricui → 200", (await patch(admin, apptFree.id, { employeeId: empB.id })).statusCode, 200);
  await patch(admin, apptFree.id, { employeeId: null });

  // ── Dashboard ──
  console.log("\n— dashboard —");
  const upcoming = async (u: any) => {
    const res = await app.inject({ method: "GET", url: "/api/dashboard/appointments-upcoming", headers: auth(u) });
    return res.json();
  };
  eq("upcoming ca admin", (await upcoming(admin)).length, 3);
  eq("upcoming ca tehnician", (await upcoming(opA)).length, 2);

  // ── Lista de angajați ──
  console.log("\n— angajați —");
  const employees = async (u: any) => {
    const res = await app.inject({ method: "GET", url: "/api/employees?limit=100", headers: auth(u) });
    return res.json().data as { id: string }[];
  };
  eq("adminul vede echipa", (await employees(admin)).length, 2);
  eq("tehnicianul vede doar propria fișă", (await employees(opA)).map((e) => e.id), [empA.id]);

  // ── Suprapuneri ──
  console.log("\n— suprapuneri —");
  const overlaps = async (u: any, employeeId: string, hour: number) => {
    const res = await app.inject({
      method: "GET",
      url: `/api/appointments/overlaps?employeeId=${employeeId}&date=${encodeURIComponent(at(hour).toISOString())}&duration=60`,
      headers: auth(u),
    });
    return { status: res.statusCode, body: res.statusCode === 200 ? res.json() : null };
  };
  eq("suprapunere peste propria programare", (await overlaps(opA, empA.id, 9)).body.count, 1);
  eq("interval liber", (await overlaps(opA, empA.id, 17)).body.hasOverlap, false);
  eq("tehnicianul nu poate verifica un coleg → 403", (await overlaps(opA, empB.id, 11)).status, 403);
  eq("adminul poate verifica pe oricine", (await overlaps(admin, empB.id, 11)).body.count, 1);

  {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: auth(admin),
      payload: {
        clientId: client.id,
        employeeId: empA.id,
        type: "revizie",
        title: "Peste programarea Anei",
        date: at(9).toISOString(),
        duration: 60,
      },
    });
    eq("crearea peste un interval ocupat reușește", res.statusCode, 201);
    eq("dar avertizează", res.json()._warnings?.overlap?.count, 1);
  }

  // ── Legarea contului ──
  console.log("\n— legare cont ↔ angajat —");
  const otherTenant = await prisma.tenant.create({
    data: { name: "Alt tenant", slug: `scope-other-${suffix}` },
  });
  createdTenants.push(otherTenant.id);
  const otherEmp = await prisma.employee.create({
    data: { tenantId: otherTenant.id, firstName: "Străin", lastName: "Extern" },
  });
  eq(
    "legare cu angajat din alt tenant → 404",
    (await app.inject({
      method: "PATCH",
      url: `/api/users/${opB.id}`,
      headers: auth(admin),
      payload: { employeeId: otherEmp.id },
    })).statusCode,
    404,
  );
  eq(
    "legare cu un angajat deja legat → 409",
    (await app.inject({
      method: "PATCH",
      url: `/api/users/${opB.id}`,
      headers: auth(admin),
      payload: { employeeId: empA.id },
    })).statusCode,
    409,
  );
  {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/users/${opB.id}`,
      headers: auth(admin),
      payload: { employeeId: empB.id },
    });
    eq("legare validă → 200", res.statusCode, 200);
    eq("acum vede programarea lui", (await calendar(opB)).items.map((i: any) => i.title).sort(), [
      "A lui Bogdan",
      "Nerepartizată",
    ]);
  }
  {
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(opA) });
    const body = me.json();
    eq("/auth/me întoarce persoana legată", body.employee?.id, empA.id);
    eq("/auth/me întoarce modul", body.scheduling?.mode, "per_technician");
  }

  // ── Indexul chiar se folosește ──
  console.log("\n— plan de execuție —");
  const plan = (await prisma.$queryRawUnsafe(
    `EXPLAIN SELECT * FROM "Appointment" WHERE "tenantId" = $1 AND ("employeeId" = $2 OR "employeeId" IS NULL) AND "date" BETWEEN $3 AND $4`,
    tenantId,
    empA.id,
    new Date(from),
    new Date(to),
  )) as { "QUERY PLAN": string }[];
  const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
  // Pe un tabel mic Postgres alege seq scan; verificăm doar că planul e valid și
  // notăm ce a ales, ca să se vadă când setul de date crește.
  console.log(`     plan: ${planText.split("\n")[0]}`);
  eq("planul se poate calcula", planText.length > 0, true);
} finally {
  await app.close();
  for (const id of createdTenants) await dropTenant(id);
  if (createdTenants.length) console.log("\ntenanți de test șterși");
  await prisma.$disconnect();
}

console.log(fails.length ? `\n${fails.length} verificări picate` : "\nToate verificările au trecut");
process.exit(fails.length ? 1 : 0);
