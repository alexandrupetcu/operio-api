/**
 * Single source of truth for the "Revizie instalație" / "Verificare instalație"
 * FISA forms — operation rows (Tabel 3), the periodic-situations (Tabel 1) and
 * the appreciation-form indicators. Used by the report builder (worker), the
 * HTML template seed, and the web/mobile completion forms (copied verbatim) so
 * the `{{op_*}}` template keys and the report `operatiuni` keys never drift.
 */

/** Operation row labels (Tabel 3), keyed by a stable id. */
export const OPERATIUNI_LABELS: Record<string, string> = {
  arzatoare:
    "Verificarea arzătoarelor și a stării îmbinărilor și garniturilor de etanșare aferente",
  stabilitate_conducte: "Verificarea stabilității conductelor montate aparent pe suporturi",
  etanseitate_imbinari:
    "Verificarea etanșeității îmbinării conductelor și armăturilor la presiunea de lucru a gazului din instalație, cu spumă de apă cu săpun sau alte tehnologii de verificare a etanșeității",
  aparate_masurare: "Verificarea funcționării aparatelor de măsurare, control, reglare și de siguranță",
  demontare_neaprobata:
    "Demontarea/Debranșarea aparatelor consumatoare de combustibili gazoși fără aprobarea legală și a instalațiilor de utilizare aferente",
  echipament_reglare: "Verificarea funcționării echipamentului de reglare din instalațiile de utilizare",
  rasuflatori_camine: "Verificarea stării răsuflătorilor și a căminelor existente",
  documente_curatare_cosuri:
    "Verificarea documentelor prezentate de client, din care să reiasă că a fost efectuată curățarea coșurilor și a canalelor de evacuare a gazelor de ardere de către operatori economici autorizați, emise cu maximum 6 luni înainte de data verificării tehnice",
  constructii_statii:
    "Verificarea stării construcțiilor care adăpostesc stațiile și posturile de reglare sau reglare-măsurare",
  documente_iscir_aparate:
    "Verificarea documentelor prezentate de client, care să ateste efectuarea în termen a verificării tehnice periodice a aparatelor consumatoare de combustibili gazoși de către operatorii economici autorizați de ISCIR",
  proba_rezistenta:
    "Efectuarea probei de rezistență la presiune, conform prevederilor normelor tehnice din domeniul gazelor naturale, numai pentru partea de instalație la care s-au făcut înlocuiri și/sau modificări",
  proba_etanseitate:
    "Efectuarea probei de etanșeitate la presiune, conform prevederilor normelor tehnice din domeniul gazelor naturale, a întregii instalații de utilizare a gazelor naturale",
  racord_flexibil:
    "Verificarea faptului că racordul flexibil montat în instalația de utilizare este în termen de valabilitate, având în vedere durata normală de utilizare specificată în prescripțiile tehnice ale producătorului",
  detector_gaze:
    "Verificarea faptului că detectorul/detectoarele automat/e de gaze naturale montat/e la locul de consum este/sunt în termen de valabilitate, având în vedere durata normată de utilizare specificată în prescripțiile tehnice ale producătorului",
  instalatie_comuna:
    "Verificarea/Revizia tehnică a instalației comune de utilizare a gazelor naturale care deservește mai mulți clienți finali, cuprinsă între stația sau postul de reglare și sistemele/mijloacele de măsurare a gazelor naturale",
  instructiuni_utilizare:
    "Verificarea existenței instrucțiunilor de utilizare a gazelor naturale, întocmite conform prevederilor Procedurii privind proiectarea, verificarea, execuția, recepția și punerea în funcțiune a instalației de utilizare a gazelor naturale, aprobată de Ordinul ANRE nr. 32/2012",
};

/** Tabel 3 order for REVIZIE (16 rows — includes the two pressure-test ops). */
export const REVIZIE_OPERATIUNI: string[] = [
  "arzatoare",
  "stabilitate_conducte",
  "etanseitate_imbinari",
  "aparate_masurare",
  "demontare_neaprobata",
  "echipament_reglare",
  "rasuflatori_camine",
  "documente_curatare_cosuri",
  "constructii_statii",
  "documente_iscir_aparate",
  "proba_rezistenta",
  "proba_etanseitate",
  "racord_flexibil",
  "detector_gaze",
  "instalatie_comuna",
  "instructiuni_utilizare",
];

/** Tabel 3 order for VERIFICARE (14 rows — no pressure-test ops; different tail order). */
export const VERIFICARE_OPERATIUNI: string[] = [
  "arzatoare",
  "stabilitate_conducte",
  "etanseitate_imbinari",
  "aparate_masurare",
  "demontare_neaprobata",
  "echipament_reglare",
  "rasuflatori_camine",
  "documente_curatare_cosuri",
  "constructii_statii",
  "documente_iscir_aparate",
  "instalatie_comuna",
  "racord_flexibil",
  "detector_gaze",
  "instructiuni_utilizare",
];

/** Tabel 1 — situations in which the work is performed. `value` is stored in the report. */
export const REVIZIE_SITUATII: { value: string; label: string }[] = [
  { value: "interval_10_ani", label: "La intervale de maximum 10 ani" },
  { value: "intrerupere_6_luni", label: "După orice întrerupere a utilizării instalației pentru o perioadă mai mare de 6 luni" },
  { value: "eveniment", label: "După orice eveniment care poate afecta instalația de utilizare" },
  { value: "cerere_client", label: "La cererea clientului final" },
];

export const VERIFICARE_SITUATII: { value: string; label: string }[] = [
  { value: "interval_2_ani", label: "La intervale de maximum 2 ani" },
  { value: "cerere_client", label: "La cererea clientului" },
];

export const AMPLASARE_OPTIONS = [
  { value: "subteran", label: "Subteran" },
  { value: "suprateran", label: "Suprateran" },
] as const;

export const REGIM_OPTIONS = [
  { value: "medie", label: "Medie presiune" },
  { value: "redusa", label: "Redusă presiune" },
  { value: "joasa", label: "Joasă presiune" },
] as const;

export const CONDUCTA_OPTIONS = [
  { value: "OL", label: "OL (oțel)" },
  { value: "PE", label: "PE (polietilenă)" },
] as const;

/**
 * PV — material line-item kinds. A report holds any number of positions of any
 * kind (a copper pipe and a PE pipe can coexist), so the material is a property
 * of the POSITION, never a global field. Each kind declares its unit of measure
 * and which detail columns make sense for it; operator-defined kinds arrive on
 * the report as `label`/`um` overrides on the position itself.
 */
export const MAT_KINDS: Record<string, { label: string; um: string; hasMaterial: boolean; hasDiam: boolean }> = {
  teava: { label: "Țeavă", um: "m", hasMaterial: true, hasDiam: false },
  armatura: { label: "Armătură de închidere", um: "buc", hasMaterial: true, hasDiam: true },
  detector: { label: "Detector gaze", um: "buc", hasMaterial: false, hasDiam: false },
  fiting: { label: "Fiting", um: "buc", hasMaterial: true, hasDiam: true },
  racord: { label: "Racord flexibil", um: "buc", hasMaterial: true, hasDiam: true },
  tub: { label: "Tub protecție", um: "m", hasMaterial: true, hasDiam: true },
};

/** Display order of the built-in kinds (custom kinds follow, in insertion order). */
export const MAT_KIND_ORDER: string[] = ["teava", "armatura", "detector", "fiting", "racord", "tub"];

/** Preset vocabularies offered in the field forms; operators may add their own. */
export const MATERIAL_PRESETS: string[] = ["PE100", "PE80", "OL (oțel)", "Cupru", "Inox", "Multistrat", "PVC"];
export const DIAMETRU_PRESETS_METRIC: string[] = ["20", "25", "32", "40", "50", "63"];
export const DIAMETRU_PRESETS_INCH: string[] = ['1/2"', '3/4"', '1"', '5/4"'];

const MATERIAL_CLASS: Record<string, "OL" | "PE"> = {
  PE100: "PE",
  PE80: "PE",
  "OL (oțel)": "OL",
  Cupru: "OL",
  Inox: "OL",
  Multistrat: "PE",
  PVC: "PE",
};

/**
 * PV point 10/11 splits the pipework into an OL branch and a PE branch. The form
 * no longer asks for it — the class is derived from the material of each position
 * when the document is built (metals → OL, plastics → PE).
 */
export function materialClass(material?: string | null): "OL" | "PE" {
  const m = String(material ?? "").trim();
  if (!m) return "OL";
  return MATERIAL_CLASS[m] ?? (/^PE/i.test(m) ? "PE" : "OL");
}

/** FORMULAR DE APRECIERE — 5 indicators rated 1..10. */
export const APRECIERE_INDICATORS: string[] = [
  "Sunteți mulțumit de durata lucrărilor/serviciilor în raport cu prevederile contractuale?",
  "Sunteți mulțumit de numărul și pregatirea personalului alocat lucrărilor/serviciilor contractate?",
  "Sunteți mulțumit de disponibilitatea și calitatea dotărilor materiale, materialelor și componentelor utilizate, respectiv a documentelor elaborate?",
  "Sunteți mulțumit de tipul și modul de rezolvare a solicitărilor punctuale adresate titularului de autorizație sau a personalului acestuia?",
  "Sunteți mulțumit de calitatea globală a lucrărilor realizate sau a serviciilor prestate?",
];
