/**
 * Detectarea suprapunerilor — pur, fără DB: se injectează rândurile direct în
 * locul interogării Prisma, ca să se verifice fereastra de căutare, filtrul de
 * status și aritmetica intervalelor semi-deschise.
 *
 * Rulează: npx tsx scripts/check-appointment-overlap.ts
 */
import { apptEnd, findOverlaps, MAX_APPOINTMENT_MINUTES } from "../src/modules/appointments/overlap.js";

const fails: string[] = [];
const eq = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (așteptat ${JSON.stringify(expected)})`}`,
  );
  if (!ok) fails.push(name);
};

const DEFAULT_MINUTES = 60;
const at = (hhmm: string) => new Date(`2026-07-27T${hhmm}:00.000Z`);

interface Row {
  id: string;
  title: string;
  date: Date;
  duration: number | null;
  status: string;
  employeeId: string;
  deletedAt: Date | null;
}

/** Prisma de mucava: aplică `where`-ul primit peste rândurile din memorie. */
function fakeFastify(rows: Row[]) {
  let lastWhere: any = null;
  return {
    captured: () => lastWhere,
    fastify: {
      prisma: {
        appointment: {
          findMany: async ({ where, take }: any) => {
            lastWhere = where;
            return rows
              .filter((r) => r.employeeId === where.employeeId)
              .filter((r) => r.deletedAt === null)
              .filter((r) => (where.status?.in ? where.status.in.includes(r.status) : true))
              .filter((r) => (where.id?.not ? r.id !== where.id.not : true))
              .filter((r) => r.date >= where.date.gte && r.date < where.date.lt)
              .sort((a, b) => a.date.getTime() - b.date.getTime())
              .slice(0, take ?? 20);
          },
        },
      },
    } as any,
  };
}

const row = (over: Partial<Row> & { id: string; date: Date }): Row => ({
  title: "Programare",
  duration: 60,
  status: "scheduled",
  employeeId: "emp_a",
  deletedAt: null,
  ...over,
});

const run = (rows: Row[], args: Parameters<typeof findOverlaps>[2]) => {
  const { fastify, captured } = fakeFastify(rows);
  return findOverlaps(fastify, "t1", args).then((res) => ({ res, where: captured() }));
};

// ── Aritmetica orei de sfârșit ──
eq("durata lipsă → default", apptEnd(at("09:00"), null, DEFAULT_MINUTES).toISOString(), at("10:00").toISOString());
eq("durata explicită", apptEnd(at("09:00"), 90, DEFAULT_MINUTES).toISOString(), at("10:30").toISOString());

// ── Intervale semi-deschise ──
{
  const { res } = await run([row({ id: "a", date: at("09:00"), duration: 60 })], {
    employeeId: "emp_a", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES,
  });
  eq("cap la cap nu e suprapunere", res.hasOverlap, false);
}
{
  const { res } = await run([row({ id: "a", date: at("09:00"), duration: 61 })], {
    employeeId: "emp_a", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES,
  });
  eq("un minut de suprapunere e prins", [res.hasOverlap, res.count], [true, 1]);
}
{
  const { res } = await run([row({ id: "a", date: at("10:30"), duration: 60 })], {
    employeeId: "emp_a", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES,
  });
  eq("programare care începe în interval", res.items.map((i) => i.id), ["a"]);
}

// ── Fereastra de căutare: o programare lungă începută demult ──
{
  const { res } = await run([row({ id: "long", date: at("07:00"), duration: 240 })], {
    employeeId: "emp_a", start: at("10:00"), duration: 30, defaultMinutes: DEFAULT_MINUTES,
  });
  eq("programare de 4h începută cu 3h înainte", res.hasOverlap, true);
}
{
  const { where } = await run([], {
    employeeId: "emp_a", start: at("10:00"), duration: 30, defaultMinutes: DEFAULT_MINUTES,
  });
  const back = (at("10:00").getTime() - where.date.gte.getTime()) / 60_000;
  eq("fereastra în urmă = plafonul de durată", back, MAX_APPOINTMENT_MINUTES);
  eq("fereastra înainte = sfârșitul programării", where.date.lt.toISOString(), at("10:30").toISOString());
}

// ── Ce nu ocupă intervalul ──
{
  const { res } = await run(
    [
      row({ id: "anulata", date: at("10:00"), status: "cancelled" }),
      row({ id: "finalizata", date: at("10:00"), status: "completed" }),
      row({ id: "stearsa", date: at("10:00"), deletedAt: new Date() }),
      row({ id: "alt-tehnician", date: at("10:00"), employeeId: "emp_b" }),
    ],
    { employeeId: "emp_a", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES },
  );
  eq("anulate/finalizate/șterse/alt tehnician ignorate", res.count, 0);
}

// ── Editare: programarea nu se ciocnește de ea însăși ──
{
  const rows = [row({ id: "self", date: at("10:00"), duration: 60 })];
  const { res: withSelf } = await run(rows, {
    employeeId: "emp_a", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES,
  });
  const { res: excluded } = await run(rows, {
    employeeId: "emp_a", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES, excludeId: "self",
  });
  eq("fără excludere se ciocnește de ea însăși", withSelf.count, 1);
  eq("cu excludere nu", excluded.count, 0);
}

// ── Rând fără durată ──
{
  const { res } = await run([row({ id: "fara", date: at("09:30"), duration: null })], {
    employeeId: "emp_a", start: at("10:00"), duration: 30, defaultMinutes: DEFAULT_MINUTES,
  });
  eq("rând fără durată tratat ca default", res.hasOverlap, true);
}

// ── Fără tehnician nu există suprapunere ──
{
  const { res } = await run([row({ id: "a", date: at("10:00") })], {
    employeeId: "", start: at("10:00"), duration: 60, defaultMinutes: DEFAULT_MINUTES,
  });
  eq("fără tehnician → fără verificare", res.count, 0);
}

console.log(fails.length ? `\n${fails.length} verificări picate` : "\nToate verificările au trecut");
process.exit(fails.length ? 1 : 0);
