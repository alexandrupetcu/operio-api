#!/usr/bin/env python3
"""
Bulk-templatize the Carte Conducta Distrigaz docx files. They contain hardcoded
sample data from a real past project (client FRIPTU STEFAN-ALEXANDRU, address
Str. Unirii nr. 25C, Mihailesti/Giurgiu, OL 50198193, etc.) — this script walks
each <w:p>, finds matches across runs, and substitutes the sample data with the
standard Operio placeholders so the templates work for any project.

Substitution categories:
  • Tenant identity (header company info → {tenant_*} variables)
  • OSD identity (DISTRIGAZ-SUD RETELE → {osd_denumire} metadata)
  • Project people (TOMA DRAGOS MIHAIL → {diriginte_nume})
  • Client (FRIPTU STEFAN-ALEXANDRU → {client_name})
  • Project geo (Str. Unirii nr. 25C → {project_address}, Mihailesti → {project_city}, etc.)
  • Project tech (Dn 63 → {project_dn})
  • Authorizations (OL 50198193 → {ordin_lucru}, autorization nr/date)

Uses the same XML-aware run-collapsing technique as fix-template-keys.py so the
substitution works even when the hardcoded text is split across multiple <w:r>
elements with different formatting (Word does this for emphasis/colors).

Usage:
  python3 scripts/templatize-conducta.py <file.docx> [file2.docx ...]
  Output: <input>-tpl.docx alongside each input.
"""
import sys, os, re, zipfile
from io import BytesIO
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
W = f"{{{W_NS}}}"
XML = f"{{{XML_NS}}}"

ET.register_namespace("", W_NS)
for p, u in {
    "w": W_NS, "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "v": "urn:schemas-microsoft-com:vml", "o": "urn:schemas-microsoft-com:office:office",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "w10": "urn:schemas-microsoft-com:office:word",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16se": "http://schemas.microsoft.com/office/word/2015/wordml/symex",
    "wne": "http://schemas.microsoft.com/office/word/2006/wordml",
    "wp14": "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    "wpi": "http://schemas.microsoft.com/office/word/2010/wordprocessingInk",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
}.items():
    if p: ET.register_namespace(p, u)


# Substitution table. Order matters — longest/most-specific FIRST so partial
# matches don't eat into longer ones (e.g. "PIC TERMO INSTAL GAZ" must run after
# "S.C. PIC TERMO INSTAL GAZ S.R.L." to avoid leaving "S.C. ... S.R.L." debris).
SUBSTITUTIONS = [
    # ─── Tenant — full sentences / multi-token first ───
    (re.compile(r"S\.\s*C\.\s+PIC\s+TERMO\s+INSTAL\s+GAZ\s+S\.\s*R\.\s*L\.", re.IGNORECASE), "{tenant_name}"),
    (re.compile(r"PIC\s+TERMO\s+INSTAL\s+GAZ", re.IGNORECASE), "{tenant_name}"),
    (re.compile(r"Str\.\s+Zoe\s+Samurcasi\s+nr\.\s*11A,?\s*Ciorogarla\s*[\-–]\s*Ilfov", re.IGNORECASE), "{tenant_address}, {tenant_city}"),
    (re.compile(r"Str\.\s+Zoe\s+Samurcasi[^,\.]{0,30}"), "{tenant_address}"),  # fallback
    (re.compile(r"\bRO41642121\b"), "{tenant_cui}"),
    (re.compile(r"\bJ23/4048/2019\b"), "{tenant_reg_com}"),
    (re.compile(r"0723\.?\s*532\.?\s*078"), "{tenant_phone}"),
    (re.compile(r"picinstalgaz@gmail\.com"), "{tenant_email}"),
    (re.compile(r"caliopa\.gica@gmail\.com"), ""),  # secondary email — drop
    (re.compile(r"Ivan\s+Caliopa\s+Gica", re.IGNORECASE), "{tenant_admin_name}"),
    # Standalone "Caliopa Gica" / "Caliopa" — appears in signature lines, footers,
    # "Ing. Caliopa" labels, etc. Must run AFTER the full-name pattern so we don't
    # double-substitute. Word-boundaried so it doesn't eat random text.
    (re.compile(r"\bCaliopa\s+Gica\b", re.IGNORECASE), "{tenant_admin_name}"),
    (re.compile(r"\bCaliopa\b", re.IGNORECASE), "{tenant_admin_name}"),

    # ─── OSD (Operator de Sistem) — Distrigaz identity ───
    # DISTRIGAZ-SUD RETELE → {osd_denumire} metadata. The hyphen comes in
    # multiple forms (-, –, none) and DISTRIGAZ may be split SUD/RETELE.
    (re.compile(r"DISTRIGAZ[\s\-–]*SUD[\s\-–]*RETELE(?:\s+S\.?R\.?L\.?)?", re.IGNORECASE), "{osd_denumire}"),

    # ─── People — project team / client ───
    # Diriginte de șantier — usually appears in salutation "In atentia Ing. <name>".
    (re.compile(r"TOMA\s+DRAGOS\s+MIHAIL", re.IGNORECASE), "{diriginte_nume}"),
    # Beneficiar / client final.
    (re.compile(r"FRIPTU\s+STEFAN[\s\-]*ALEXANDRU", re.IGNORECASE), "{client_name}"),

    # ─── Project geography ───
    # "Str. Unirii, nr. 25C" / "Str. Unirii nr. 25C" / "str. Unirii nr. 25C"
    # Collapse to {project_address}; we drop the literal "Str." prefix and the "nr." separator.
    (re.compile(r"(?i)\bStr\.?\s+Unirii\s*,?\s*nr\.?\s*25C\b"), "{project_address}"),
    (re.compile(r"\bMihailesti\b", re.IGNORECASE), "{project_city}"),
    (re.compile(r"\bGiurgiu\b", re.IGNORECASE), "{project_county}"),

    # ─── Project technical fields ───
    # "Dn 63 mm" → "Dn {project_dn} mm" (preserve Dn prefix and mm suffix
    # because project_dn metadata stores just the number).
    (re.compile(r"\bDn\s*63\s*mm\b"), "Dn {project_dn} mm"),
    (re.compile(r"\bDn\s*63\b(?!\s*mm)"), "Dn {project_dn}"),

    # ─── Authorizations ───
    # "OL 50198193 / 04.07.2025" → "OL {ordin_lucru} / {data_ol}"
    (re.compile(r"\bOL\s+50198193\s*/\s*04\.07\.2025"), "OL {ordin_lucru} / {data_ol}"),
    (re.compile(r"\bOL\s+50198193\b"), "OL {ordin_lucru}"),
    (re.compile(r"04\.07\.2025"), "{data_ol}"),
    # "Autorizatie de construire nr. 52 din 27.08.2025"
    (re.compile(r"(?i)Autorizatie\s+de\s+construire\s+nr\.\s*52\s+din\s+27\.08\.2025"),
     "Autorizatie de construire nr. {autorizatie_construire_nr} din {autorizatie_construire_data}"),
    (re.compile(r"(?i)Autorizatie\s+de\s+construire\s+nr\.\s*52\b"),
     "Autorizatie de construire nr. {autorizatie_construire_nr}"),
    (re.compile(r"27\.08\.2025"), "{autorizatie_construire_data}"),

    # ─── MegaConstruct sample data (project: Angelescu 209, Poienarii Burchii) ───
    # OSD identity — MegaConstruct documents use this OSD instead of Distrigaz.
    # Match all corporate-suffix variants (S.R.L. / S.A. / nothing). Longer first.
    (re.compile(r"S\.\s*C\.\s+MEGACONSTRUCT\s+S\.\s*[RA]\.\s*L?\.?", re.IGNORECASE), "{osd_denumire}"),
    (re.compile(r"\bMEGACONSTRUCT\b"), "{osd_denumire}"),
    # Client (beneficiar)
    (re.compile(r"TRANDAFIR\s+TEODORA", re.IGNORECASE), "{client_name}"),
    # Project address — match the multi-fragment "Str. … Nr. 209 …" pattern with
    # the "Nr. vechi 432" parenthetical + "NC 20995" cadastral number. Collapse
    # the whole address to {project_address} so it can be reset per project.
    (re.compile(
        r"(?i)Str\.\s+General\s+Alexandru\s+Angelescu\s*,?\s*Nr\.\s*209\s*,?\s*\(\s*Nr\.\s*vechi\s+432\s*\)\s*[\-–]\s*NC\s+20995"
    ), "{project_address}"),
    (re.compile(r"(?i)Str\.\s+General\s+Alexandru\s+Angelescu\s*,?\s*Nr\.\s*209"), "{project_address}"),
    (re.compile(r"(?i)Str\.\s+General\s+Alexandru\s+Angelescu"), "{project_address}"),
    (re.compile(r"\bPoienarii\s+Burchii\b", re.IGNORECASE), "{project_city}"),
    (re.compile(r"\bPrahova\b", re.IGNORECASE), "{project_county}"),
    # MegaConstruct project DN is 32 (vs Distrigaz's 63). Reuse {project_dn}.
    (re.compile(r"\bDn\s*32\s*mm\b"), "Dn {project_dn} mm"),
    # ATR code — MegaConstruct uses "ATR BL_6461 / 31.07.2024" format
    (re.compile(r"\bATR\s+BL_6461\s*/\s*31\.07\.2024"), "ATR {cod_atr}"),
    # Acord (MegaConstruct's authorization document — equivalent to Distrigaz's
    # "Autorizatie de construire"). Reuse the same metadata keys; only the
    # surrounding literal label differs.
    (re.compile(r"(?i)Acord\s+nr\.\s*32\s+din\s+03\.09\.2024"),
     "Acord nr. {autorizatie_construire_nr} din {autorizatie_construire_data}"),
    (re.compile(r"(?i)Acord\s+nr\.\s*32\b"), "Acord nr. {autorizatie_construire_nr}"),

    # ─── NEOGAS sample data (bransament: Sabarului 23, conducta: Industriilor 24A) ───
    # OSD identity. NeoGas Grid is sometimes written with the "fosta Premier
    # Energy SRL" historical reference — keep that literal text, only sub the
    # current name. Match BOTH casings: "NeoGas Grid" and "NEOGAS GRID".
    (re.compile(r"\bNeoGas\s+Grid(?:\s+SA)?\b"), "{osd_denumire}"),
    (re.compile(r"\bNEOGAS\s+GRID(?:\s+S\.?A\.?)?", re.IGNORECASE), "{osd_denumire}"),
    # Clients (beneficiars) — two different sample projects across the dossier.
    (re.compile(r"ANDREESCU\s+MARIAN", re.IGNORECASE), "{client_name}"),
    (re.compile(r"\bAndrei\s+Boja\b", re.IGNORECASE), "{client_name}"),
    (re.compile(r"MIRITA\s+LAURENTIU[\s\-]MIRCEA", re.IGNORECASE), "{client_name}"),
    # Diriginte (only in conducta sample)
    (re.compile(r"(?:ING\.?\s*)?RAUTA\s+DANIEL", re.IGNORECASE), "{diriginte_nume}"),
    # Project addresses (bransament + conducta projects). Match the full
    # "Str. NAME nr. NUMBER" cadence; collapse to {project_address}.
    (re.compile(r"(?i)Str\.?\s+SABARULUI\s*,?\s*nr\.?\s*23"), "{project_address}"),
    (re.compile(r"(?i)Str\.?\s+INDUSTRIILOR\s*,?\s*nr\.?\s*24A"), "{project_address}"),
    (re.compile(r"(?i)\bSABARULUI\b"), "{project_address}"),    # bare-street fallback
    (re.compile(r"(?i)\bINDUSTRIILOR\b"), "{project_address}"), # bare-street fallback
    # Localități + județe
    (re.compile(r"\bBolintin[\s\-]Vale\b", re.IGNORECASE), "{project_city}"),
    (re.compile(r"\bBranesti\b", re.IGNORECASE), "{project_city}"),
    (re.compile(r"\bIlfov\b", re.IGNORECASE), "{project_county}"),
    # (Giurgiu already covered by the Distrigaz section above.)
    # DN — NEOGAS uses uppercase "DN 32" (Distrigaz used "Dn 63"). Add an
    # uppercase variant; the existing Distrigaz pattern handles lowercase.
    (re.compile(r"\bDN\s*32\s*mm\b"), "DN {project_dn} mm"),
    (re.compile(r"\bDN\s*32\b(?!\s*mm)"), "DN {project_dn}"),
    # Conducta-specific: "PROIECT NR.: 408 CONSTRUCT..." sample project reference
    (re.compile(r"(?i)PROIECT\s+NR\.?\s*:?\s*408\s+CONSTRUCT\S*"), "PROIECT NR.: {proiect_nr_documentatie}"),
    (re.compile(r"(?i)PROIECT\s+NR\.?\s*:?\s*408\b"), "PROIECT NR.: {proiect_nr_documentatie}"),
]


def substitute_paragraph(p_elem, pattern, replacement):
    """Walk a <w:p>; for each match of `pattern` in concatenated visible text,
       rewrite the involved <w:r>/<w:t> elements. Returns count of replacements."""
    replaced = 0
    while True:
        runs_with_t = []
        for r in list(p_elem):
            if r.tag != f"{W}r": continue
            t = r.find(f"{W}t")
            if t is not None:
                runs_with_t.append((r, t))
        if not runs_with_t: return replaced

        cum = []
        for _, t in runs_with_t:
            cum.append((cum[-1] if cum else 0) + len(t.text or ""))
        full = "".join((t.text or "") for _, t in runs_with_t)

        m = pattern.search(full)
        if not m: return replaced

        def to_run(pos):
            for i, e in enumerate(cum):
                if pos < e: return i
            return len(cum) - 1

        first = to_run(m.start())
        last = to_run(m.end() - 1)
        first_t = runs_with_t[first][1]
        last_t = runs_with_t[last][1]
        first_run_start = cum[first-1] if first > 0 else 0
        last_run_start = cum[last-1] if last > 0 else 0
        off_first = m.start() - first_run_start
        off_after = m.end() - last_run_start

        ft = first_t.text or ""
        lt = last_t.text or ""

        if first == last:
            first_t.text = ft[:off_first] + replacement + ft[off_after:]
        else:
            first_t.text = ft[:off_first] + replacement
            for mid in range(first+1, last):
                runs_with_t[mid][1].text = ""
            last_t.text = lt[off_after:]

        if first_t.text != first_t.text.strip():
            first_t.set(f"{XML}space", "preserve")

        replaced += 1


def fix_xml(xml: str) -> tuple[str, int]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return xml, 0
    total = 0
    for p in root.iter(f"{W}p"):
        for pattern, replacement in SUBSTITUTIONS:
            total += substitute_paragraph(p, pattern, replacement)
    if total == 0:
        return xml, 0
    out = ET.tostring(root, encoding="utf-8").decode("utf-8")
    if xml.lstrip().startswith("<?xml") and not out.startswith("<?xml"):
        out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + out
    # CRITICAL: ET.tostring drops xmlns: declarations for namespaces that aren't
    # used in any emitted element. But mc:Ignorable="w14 wp14 w15" references
    # those by prefix — Word then refuses to open the file because the prefixes
    # in Ignorable can't be resolved. LibreOffice tolerates it (so PDF rendering
    # works), Word doesn't. See scripts/fix-docx-namespaces.py for the dedicated
    # repair pass — we inline the same logic here as a final guard.
    out = _restore_ignorable_namespaces(out)
    return out, total


# Canonical OOXML namespace URIs for the prefixes commonly listed in
# mc:Ignorable on documents authored by modern Word.
_OOXML_NS = {
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16se": "http://schemas.microsoft.com/office/word/2015/wordml/symex",
    "w16": "http://schemas.microsoft.com/office/word/2018/wordml",
    "wp14": "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "wne": "http://schemas.microsoft.com/office/word/2006/wordml",
    "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    "wpi": "http://schemas.microsoft.com/office/word/2010/wordprocessingInk",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "w10": "urn:schemas-microsoft-com:office:word",
}

def _restore_ignorable_namespaces(xml: str) -> str:
    for root_tag in ("w:document", "w:hdr", "w:ftr", "w:styles"):
        m = re.search(rf"<{re.escape(root_tag)}\b([^>]*)>", xml)
        if not m: continue
        attrs = m.group(1)
        ig_m = re.search(r'mc:Ignorable="([^"]+)"', attrs)
        if not ig_m: continue
        declared = set(re.findall(r'xmlns:(\w+)=', attrs))
        to_add = [f'xmlns:{p}="{_OOXML_NS[p]}"' for p in ig_m.group(1).split()
                  if p not in declared and p in _OOXML_NS]
        if not to_add: continue
        new_attrs = " " + " ".join(to_add) + " " + attrs.lstrip()
        xml = xml[:m.start()] + f"<{root_tag}{new_attrs}>" + xml[m.end():]
    return xml


def fix_one(in_path: str, in_place: bool = False) -> dict:
    out_buf = BytesIO()
    stats = {"replacements": 0, "files_touched": 0}
    with zipfile.ZipFile(in_path, "r") as zin:
        with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if re.match(r"^word/(document|header\d*|footer\d*)\.xml$", item.filename):
                    xml = data.decode("utf-8", errors="replace")
                    new_xml, n = fix_xml(xml)
                    if n > 0:
                        data = new_xml.encode("utf-8")
                        stats["files_touched"] += 1
                        stats["replacements"] += n
                zout.writestr(item, data)

    if in_place:
        out_path = in_path
    else:
        base, ext = os.path.splitext(in_path)
        out_path = base + "-tpl" + ext
    with open(out_path, "wb") as f:
        f.write(out_buf.getvalue())
    stats["output"] = out_path
    return stats


def main():
    args = sys.argv[1:]
    in_place = "--in-place" in args
    args = [a for a in args if a != "--in-place"]
    if not args:
        print("Usage: python3 templatize-conducta.py [--in-place] <file.docx> ...")
        sys.exit(1)
    grand = 0
    touched = 0
    for path in args:
        if not os.path.exists(path):
            print(f"  ✗ {path}: not found")
            continue
        try:
            stats = fix_one(path, in_place)
        except Exception as e:
            print(f"  ✗ {os.path.basename(path)}: {e}")
            continue
        if stats["replacements"]:
            print(f"  ~ {os.path.basename(path)}  ({stats['replacements']} replacement(s))")
            grand += stats["replacements"]
            touched += 1
        else:
            print(f"  · {os.path.basename(path)}  (no matches)")
    print(f"\nDone: {grand} total replacement(s) across {touched} file(s).")


if __name__ == "__main__":
    main()
