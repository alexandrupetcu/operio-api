/**
 * Clauzele de vizibilitate a programărilor — pur, fără DB.
 *
 * Proprietatea critică: în modul „calendar comun" clauza trebuie să fie `{}`
 * pentru orice rol, adică SQL identic cu cel dinainte de calendarele separate.
 * A doua: un filtru cerut de client poate doar să restrângă, niciodată să lărgească.
 *
 * Rulează: npx tsx scripts/check-appointment-scope.ts
 */
import {
  type ApptScope,
  apptVisibilityWhere,
  requestedEmployeeWhere,
  canSeeEmployee,
} from "../src/modules/appointments/scope.js";

const fails: string[] = [];
const eq = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (așteptat ${JSON.stringify(expected)})`}`,
  );
  if (!ok) fails.push(name);
};

const ALL: ApptScope = { kind: "all" };
const OWN: ApptScope = { kind: "own", employeeId: "emp_a" };
const UNLINKED: ApptScope = { kind: "own", employeeId: null };

// ── Vizibilitate ──
eq("comun / coordonator → fără filtru", apptVisibilityWhere(ALL), {});
eq("separat / tehnician legat", apptVisibilityWhere(OWN), {
  OR: [{ employeeId: "emp_a" }, { employeeId: null }],
});
eq("separat / cont nelegat → doar nerepartizate", apptVisibilityWhere(UNLINKED), {
  employeeId: null,
});

// ── Filtrul cerut de client ──
eq("fără filtru", requestedEmployeeWhere(undefined, ALL), {});
eq("filtru gol", requestedEmployeeWhere("  ", ALL), {});
eq("coordonator filtrează un tehnician", requestedEmployeeWhere("emp_b", ALL), {
  employeeId: { in: ["emp_b"] },
});
eq("listă de tehnicieni", requestedEmployeeWhere("emp_a,emp_b", ALL), {
  employeeId: { in: ["emp_a", "emp_b"] },
});
eq("nerepartizate", requestedEmployeeWhere("none", ALL), { employeeId: null });
eq("tehnician + nerepartizate", requestedEmployeeWhere("emp_a,none", ALL), {
  OR: [{ employeeId: { in: ["emp_a"] } }, { employeeId: null }],
});
eq("filtrul me pentru un tehnician legat", requestedEmployeeWhere("me", OWN), {
  employeeId: { in: ["emp_a"] },
});
eq("filtrul me pentru un cont nelegat → nimic", requestedEmployeeWhere("me", UNLINKED), {
  id: "__none__",
});

// Cheia de securitate: filtrul pe un coleg NU lărgește vizibilitatea. Clauza
// cerută se combină prin AND cu cea de vizibilitate, deci intersecția e vidă.
{
  const visibility = apptVisibilityWhere(OWN);
  const requested = requestedEmployeeWhere("emp_b", OWN);
  const and = [visibility, requested];
  const matches = (employeeId: string | null) => {
    const visible =
      "OR" in visibility
        ? (visibility.OR as { employeeId: string | null }[]).some((c) => c.employeeId === employeeId)
        : true;
    const req = (requested as { employeeId?: { in: string[] } }).employeeId;
    const requestedOk = req ? req.in.includes(employeeId ?? "") : true;
    return visible && requestedOk;
  };
  eq("AND: programarea colegului nu se vede", matches("emp_b"), false);
  eq("AND: propria programare nu trece de filtrul pe coleg", matches("emp_a"), false);
  eq("AND: nerepartizata nu trece de filtrul pe coleg", matches(null), false);
  eq("AND are două clauze", and.length, 2);
}

// ── canSeeEmployee (folosit de endpointul de suprapuneri) ──
eq("coordonator poate verifica pe oricine", canSeeEmployee(ALL, "emp_b"), true);
eq("tehnician se poate verifica pe el", canSeeEmployee(OWN, "emp_a"), true);
eq("tehnician nu poate verifica un coleg", canSeeEmployee(OWN, "emp_b"), false);
eq("nerepartizat e vizibil oricui", canSeeEmployee(OWN, null), true);
eq("cont nelegat nu poate verifica pe nimeni", canSeeEmployee(UNLINKED, "emp_a"), false);

console.log(fails.length ? `\n${fails.length} verificări picate` : "\nToate verificările au trecut");
process.exit(fails.length ? 1 : 0);
