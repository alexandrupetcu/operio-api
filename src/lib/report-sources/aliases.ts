/**
 * Etichete tipărite/exportate de analizoare → cheile noastre din
 * `analysisData.readings` (și câteva câmpuri de antet). Tabelul e comun sursei
 * AI (`generic-ai-pdf`) și sursei de fișiere structurate (`structured-file`),
 * ca o etichetă să însemne același lucru indiferent pe unde intră raportul.
 *
 * Ordinea de rezolvare (`resolveReadingKey`): mapping-ul firmei > aliasuri >
 * slug din etichetă (cheia se păstrează ca să nu se piardă nimic din raport).
 */

/** Chei de antet pe care le pot umple sursele label-driven (nu sunt citiri). */
export type HeaderAliasKey =
  | "revisionDate"
  | "time"
  | "location"
  | "clientName"
  | "clientSurname"
  | "clientAddress"
  | "clientPhone"
  | "clientEmail"
  | "equipmentName"
  | "equipmentSerial"
  | "operatorName"
  | "operatorAddress"
  | "operatorPhone"
  | "operatorEmail"
  | "analyzerName"
  | "analyzerSerial"
  | "fuel"
  | "altitude"
  | "humidity";

export const HEADER_ALIAS_KEYS: readonly HeaderAliasKey[] = [
  "revisionDate", "time", "location", "clientName", "clientSurname", "clientAddress",
  "clientPhone", "clientEmail", "equipmentName", "equipmentSerial", "operatorName",
  "operatorAddress", "operatorPhone", "operatorEmail", "analyzerName", "analyzerSerial",
  "fuel", "altitude", "humidity",
];

export const isHeaderAliasKey = (k: string): k is HeaderAliasKey =>
  (HEADER_ALIAS_KEYS as readonly string[]).includes(k);

/**
 * Etichete frecvente pe rapoartele/exporturile analizoarelor (Seitron, Testo,
 * Kane, Wöhler, MRU…) în română, engleză, germană (ZIV) și italiană.
 */
export const DEFAULT_LABEL_ALIASES: Record<string, string> = {
  // --- temperatură gaze arse ---
  "t gaz": "tGaz", "tgas": "tGaz", "t gas": "tGaz", "flue temp": "tGaz", "flue gas temp": "tGaz",
  "flue gas temperature": "tGaz", "flue temperature": "tGaz", "ft": "tGaz", "fgt": "tGaz",
  "temperatura gaze": "tGaz", "temp gaze arse": "tGaz", "temperatura gaze arse": "tGaz", "stack temp": "tGaz",
  "stack temperature": "tGaz", "abgastemperatur": "tGaz", "abgastemp": "tGaz", "t abgas": "tGaz", "tabgas": "tGaz",
  "t fumi": "tGaz", "tfumi": "tGaz", "temperatura fumi": "tGaz", "t.fumi": "tGaz",
  // --- temperatură aer / ambient ---
  "t aer": "tAer", "tair": "tAer", "t air": "tAer", "ambient temp": "tAer", "ambient temperature": "tAer",
  "at": "tAer", "temperatura aer": "tAer", "umgebungstemperatur": "tAer", "umgebungstemp": "tAer",
  "verbrennungslufttemperatur": "tAer", "t luft": "tAer", "tluft": "tAer", "tl": "tAer",
  "t aria": "tAer", "taria": "tAer", "temperatura aria": "tAer", "t.aria": "tAer", "air temp": "tAer",
  // --- O2 ---
  "o2": "o2", "oxygen": "o2", "oxigen": "o2", "sauerstoff": "o2", "ossigeno": "o2", "o2 %": "o2",
  // --- CO2 ---
  "co2": "co2", "carbon dioxide": "co2", "kohlendioxid": "co2", "anidride carbonica": "co2", "dioxid de carbon": "co2",
  // --- CO ---
  "co": "co", "carbon monoxide": "co", "monoxid de carbon": "co", "kohlenmonoxid": "co", "monossido di carbonio": "co",
  "co ppm": "co",
  // --- CO corectat la 0% O2 ---
  "co(0%)": "coCorr", "co (0%)": "coCorr", "co 0%": "coCorr", "co corr": "coCorr", "co corectat": "coCorr",
  "co undiluted": "coCorr", "cou": "coCorr", "co unverdünnt": "coCorr", "co unverduennt": "coCorr",
  "co ref": "coCorr", "co bezogen": "coCorr", "co korrigiert": "coCorr", "co corretto": "coCorr", "co n": "coCorr",
  // --- lambda / exces aer ---
  "lambda": "lambda", "λ": "lambda", "l": "lambda", "l;n": "lambda", "luftzahl": "lambda", "luftverhältnis": "lambda",
  "excess air": "excessAir", "exces aer": "excessAir", "excesaer": "excessAir", "ea": "excessAir",
  "luftüberschuss": "excessAir", "luftueberschuss": "excessAir", "eccesso d'aria": "excessAir", "eccesso aria": "excessAir",
  // --- ΔT ---
  "dt": "dT", "δt": "dT", "delta t": "dT", "net temp": "dT", "net temperature": "dT", "differenztemperatur": "dT",
  "temperaturdifferenz": "dT",
  // --- pierderi ---
  "qs": "qs", "qa": "qs", "stack loss": "qs", "flue loss": "qs", "pierderi": "qs", "losses": "qs", "loss": "qs",
  "verluste": "qs", "abgasverlust": "qs", "abgasverluste": "qs", "perdite": "qs", "perdita": "qs",
  "perdite al camino": "qs",
  // --- randament ---
  "es": "es", "eta": "es", "sensible efficiency": "es",
  "et": "et", "eff": "et", "efficiency": "et", "randament": "et", "eficienta": "et", "eficiență": "et",
  "wirkungsgrad": "et", "feuerungstechnischer wirkungsgrad": "et", "rendimento": "et", "rendimento di combustione": "et",
  "combustion efficiency": "et", "efficienza": "et",
  // --- NO / NOx ---
  "no": "no", "stickstoffmonoxid": "no", "nox": "nox", "stickoxide": "nox", "ossidi di azoto": "nox",
  "no(0%)": "noCorr", "nox(0%)": "noxCorr", "no corr": "noCorr", "nox corr": "noxCorr",
  // --- poison index ---
  "pi": "pi", "poison index": "pi",
  // --- tiraj ---
  "draft": "draft", "tiraj": "draft", "draught": "draft", "dp": "draft", "pressure": "draft", "zug": "draft",
  "förderdruck": "draft", "foerderdruck": "draft", "kaminzug": "draft", "schornsteinzug": "draft",
  "tiraggio": "draft", "depressione": "draft", "flue draft": "draft", "flue draught": "draft",
  // --- presiuni gaz ---
  "presiune rampa": "gasPressureRamp", "presiune rampă": "gasPressureRamp", "p rampa": "gasPressureRamp",
  "gas pressure": "gasPressureRamp", "gasdruck": "gasPressureRamp", "pressione gas": "gasPressureRamp",
  "presiune arzator": "gasPressureBurner", "presiune arzător": "gasPressureBurner", "p arzator": "gasPressureBurner",
  "burner pressure": "gasPressureBurner", "düsendruck": "gasPressureBurner", "duesendruck": "gasPressureBurner",
  "pressione bruciatore": "gasPressureBurner",

  // --- câmpuri de antet (doar pentru sursele label-driven) ---
  "date": "revisionDate", "data": "revisionDate", "datum": "revisionDate", "messdatum": "revisionDate",
  "data analizei": "revisionDate", "date of measurement": "revisionDate", "measurement date": "revisionDate",
  "time": "time", "ora": "time", "uhrzeit": "time", "zeit": "time", "messzeit": "time",
  "location": "location", "localitate": "location", "ort": "location", "località": "location", "localita": "location",
  "client": "clientName", "customer": "clientName", "kunde": "clientName", "kundenname": "clientName",
  "cliente": "clientName", "nume client": "clientName", "client name": "clientName", "nachname": "clientName",
  // Căi XML cu frunză generică („Name" sub Kunde/Geraet) — rezolvate pe ultimele două segmente.
  "kunde name": "clientName", "customer name": "clientName", "cliente nome": "clientName", "kunde vorname": "clientSurname",
  "geraet name": "analyzerName", "gerät name": "analyzerName", "messgeraet name": "analyzerName", "messgerät name": "analyzerName",
  "analyzer name": "analyzerName", "device name": "analyzerName", "anlage name": "equipmentName", "feuerstaette name": "equipmentName",
  "feuerstätte name": "equipmentName", "kessel name": "equipmentName", "surname": "clientSurname", "prenume": "clientSurname", "vorname": "clientSurname",
  "first name": "clientSurname", "nome": "clientSurname",
  "address": "clientAddress", "adresa": "clientAddress", "adresă": "clientAddress", "adresse": "clientAddress",
  "indirizzo": "clientAddress", "client address": "clientAddress", "strasse": "clientAddress", "straße": "clientAddress",
  "phone": "clientPhone", "telefon": "clientPhone", "telefono": "clientPhone", "client phone": "clientPhone", "tel": "clientPhone",
  "email": "clientEmail", "e-mail": "clientEmail", "client email": "clientEmail",
  "equipment": "equipmentName", "boiler": "equipmentName", "appliance": "equipmentName", "centrala": "equipmentName",
  "centrală": "equipmentName", "kessel": "equipmentName", "anlage": "equipmentName", "anlagentyp": "equipmentName",
  "feuerstätte": "equipmentName", "feuerstaette": "equipmentName", "gerätetyp": "equipmentName", "caldaia": "equipmentName",
  "generatore": "equipmentName", "equipment name": "equipmentName", "hersteller": "equipmentName", "marca": "equipmentName",
  "equipment serial": "equipmentSerial", "serie centrala": "equipmentSerial", "serie centrală": "equipmentSerial",
  "matricola caldaia": "equipmentSerial", "kesselnummer": "equipmentSerial", "anlagennummer": "equipmentSerial",
  "operator": "operatorName", "technician": "operatorName", "tehnician": "operatorName", "techniker": "operatorName",
  "prüfer": "operatorName", "pruefer": "operatorName", "operatore": "operatorName", "tecnico": "operatorName",
  "bediener": "operatorName",
  "analyzer": "analyzerName", "analyser": "analyzerName", "analizor": "analyzerName", "messgerät": "analyzerName",
  "messgeraet": "analyzerName", "gerät": "analyzerName", "geraet": "analyzerName", "analizzatore": "analyzerName",
  "instrument": "analyzerName", "device": "analyzerName", "model": "analyzerName", "modell": "analyzerName",
  "modello": "analyzerName", "gerätename": "analyzerName",
  "serial": "analyzerSerial", "serial number": "analyzerSerial", "serial no": "analyzerSerial", "s/n": "analyzerSerial",
  "sn": "analyzerSerial", "numar serial": "analyzerSerial", "număr serial": "analyzerSerial", "seriennummer": "analyzerSerial",
  "serien-nr": "analyzerSerial", "seriennr": "analyzerSerial", "serie": "analyzerSerial", "matricola": "analyzerSerial",
  "numero di serie": "analyzerSerial", "numero serie": "analyzerSerial", "geräteseriennummer": "analyzerSerial",
  "fuel": "fuel", "combustibil": "fuel", "brennstoff": "fuel", "combustibile": "fuel", "fuel type": "fuel",
  "altitude": "altitude", "altitudine": "altitude", "höhe": "altitude", "hoehe": "altitude", "altitudine slm": "altitude",
  "humidity": "humidity", "umiditate": "humidity", "feuchte": "humidity", "luftfeuchte": "humidity", "umidità": "humidity",
  "umidita": "humidity",
};

// „CO(0.0%)", „CO (0 %)" → „co(0%)" ca să prindă aliasul corectat-la-0%-O2.
export const normalizeLabel = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*0(?:[.,]0+)?\s*%\s*\)/g, "(0%)");

export const slugKey = (label: string) =>
  normalizeLabel(label)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "value";

/** Cheia din mapping-ul firmei pentru o etichetă (exact, apoi normalizat); undefined dacă nu e. */
export function mappedKey(label: string, mapping?: Record<string, string>): string | undefined {
  if (!mapping) return undefined;
  // Doar proprietăți proprii: o etichetă „constructor” / „__proto__” din fișier
  // nu trebuie să nimerească prototipul obiectului.
  const own = (k: string) => (Object.hasOwn(mapping, k) ? mapping[k] : undefined);
  const exact = own(label) ?? own(label.trim());
  if (exact) return exact;
  const norm = normalizeLabel(label);
  for (const [k, v] of Object.entries(mapping)) {
    if (normalizeLabel(k) === norm) return v;
  }
  return undefined;
}

/** Cheia din aliasuri pentru o etichetă; undefined dacă nu e cunoscută. */
export function aliasKey(label: string): string | undefined {
  const norm = normalizeLabel(label);
  return Object.hasOwn(DEFAULT_LABEL_ALIASES, norm) ? DEFAULT_LABEL_ALIASES[norm] : undefined;
}

/** Cheia noastră pentru o etichetă tipărită: mapping-ul firmei > aliasuri > slug. */
export function resolveReadingKey(label: string, mapping?: Record<string, string>): string {
  return mappedKey(label, mapping) ?? aliasKey(label) ?? slugKey(label);
}
