#!/usr/bin/env python3
"""
Templatize residual hardcoded sample data in the 10 files identified by the
diagnostic scan, WITHOUT round-tripping XML through ElementTree.

Strategy:
  - Walk each <w:p> paragraph in document.xml / header*.xml / footer*.xml
  - Concatenate all <w:t> visible text
  - Apply substitution rules
  - Rewrite the paragraph's runs to carry the new text, preserving the FIRST
    run's <w:rPr> properties (font, size, bold, color) so visual styling is kept
  - Re-zip the file in place (after backing up the original to a sibling .bak)

Why not ElementTree: ET.tostring() drops xmlns: declarations for prefixes not
used in emitted elements; Word refuses files where mc:Ignorable references such
prefixes. We use byte-level regex on the relevant XML files inside the .docx zip.
"""
import zipfile
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent / "documente"

# Substitution rules. Order matters — longer / more specific phrases first.
# These are paragraph-level concatenated-text substitutions (after collapsing all
# <w:t> visible text into one string per <w:p>).
SUBS = [
    # --- tenant company name variants ---
    (r"S\.?C\.?\s+PIC\s+TERMO\s+INSTAL\s+GAZ\s+S\.?R\.?L\.?", "{tenant_name}"),
    (r"PIC\s+TERMO\s+INSTAL\s+GAZ", "{tenant_name}"),
    # collapse leftover "{tenant_name} SRL" / "S.C. {tenant_name} S.R.L." patterns
    (r"S\.?C\.?\s+\{tenant_name\}\s+S\.?R\.?L\.?", "{tenant_name}"),
    (r"\{tenant_name\}\s+S\.?R\.?L\.?", "{tenant_name}"),

    # --- diriginte santier ---
    (r"Ing\.\s+VIRJAN\s+CRISTIAN\b", "Ing. {diriginte_nume}"),
    (r"VIRJAN\s+CRISTIAN\b", "{diriginte_nume}"),

    # --- verificator proiect (catch-all for the 4 spelling variants:
    #     CONSTATINESCU / CONSTANTINESCU / CONTANTINESCU / Constantinescu) ---
    (r"Ing\.\s+CON[A-Z]+TINESCU\s+PETRE\s+ADRIAN", "Ing. {verificator_nume}"),
    (r"ING\.\s+CON[A-Z]+TINESCU\s+PETRE\s+ADRIAN", "ING. {verificator_nume}"),
    (r"CON[A-Z]+TINESCU\s+PETRE\s+ADRIAN", "{verificator_nume}"),
    (r"Constantinescu\s+Petre\s+Adrian", "{verificator_nume}"),
    (r"\bV140900131\b", "{verificator_legitimatie}"),

    # --- instalator autorizat / sef santier (Ivan Florin Madalin) ---
    # Case-insensitive: the name appears in both UPPERCASE and Title Case
    # across templates. The (?i) inline flag scope's just the alternation.
    (r"Ing\.\s+(?i:IVAN\s+FLORIN\s+MADALIN)", "Ing. {instalator_nume}"),
    (r"(?i:IVAN\s+FLORIN\s+MADALIN)", "{instalator_nume}"),
    # legitimatie nr. 509201366/<date> tip EGD → collapse with placeholder
    (r"\b509201366\b(?:/\d{2}\.\d{2}\.\d{4})?", "{instalator_legitimatie}"),

    # --- client name (Bransament Templates COMPLET file) ---
    (r"FRIPTU\s+STEFAN\s*-?\s*ALEXANDRU", "{client_name}"),
    (r"FRIPTU\s+STEFAN", "{client_name}"),

    # --- tenant address residuals ---
    (r"localitatea\s+CIOROGARLA,\s*str\.?\s+ZOE\s+SAMURCASI,\s*nr\.?\s*11A,\s*judetul\s+ILFOV",
     "{tenant_address}, loc. {tenant_city}, jud. {tenant_county}"),
    (r"\bCIOROGARLA\b", "{tenant_city}"),

    # --- project number sample codes (MegaConstruct + others) ---
    (r"C242/PIC/2025", "{proiect_nr}"),
    (r"C194/PIC/2024", "{proiect_nr}"),
    (r"22\.10\.2024", "{data_pv_rt}"),

    # --- tenant ANRE authorization (PIC Termo Instal Gaz) ---
    (r"Autoriza[tț]ia\s+ANRE\s+nr\.?\s*19832\s+data\s+09\.12\.2020",
     "Autorizația ANRE nr. {tenant_autorizatie_anre} data {tenant_autorizatie_data}"),
    (r"\b19832\b", "{tenant_autorizatie_anre}"),

    # --- MegaConstruct PV cosignatories (COMAN GABRIEL / BADEA NICOLAE are
    # the OSD's reception delegates — not our tenant team) leave AS-IS since
    # they belong to the OSD's signing party for that template
]

TARGET_GROUPS = [
    "Carte Bransament Templates",
    "Carte Conducta Distrigaz",
    "Carte Bransament Megaconstruct",
    "Carte constructie bransament GN NEOGAS GRID S.A.",
    "Carte Conducta Neogas Grid",
]


def discover_target_files() -> list[str]:
    """Every .docx in each target group (skip ~$ and _backup files)."""
    files = []
    for group in TARGET_GROUPS:
        folder = ROOT / group
        if not folder.exists(): continue
        for fp in sorted(folder.glob("*.docx")):
            if fp.name.startswith("~$") or fp.name.startswith("_"): continue
            files.append(f"{group}/{fp.name}")
    return files


TARGET_FILES = discover_target_files()

PARAGRAPH_RE = re.compile(rb"<w:p\b[^>]*>.*?</w:p>", re.DOTALL)
RUN_RE = re.compile(rb"<w:r\b[^>]*>.*?</w:r>", re.DOTALL)
RPR_RE = re.compile(rb"<w:rPr\b[^>]*>.*?</w:rPr>", re.DOTALL)
RPR_EMPTY_RE = re.compile(rb"<w:rPr\s*/>")
T_RE = re.compile(rb"<w:t\b[^>]*>([^<]*)</w:t>", re.DOTALL)


def collapse_paragraph(p_xml: bytes) -> str:
    """Return concatenated visible text from a paragraph's runs."""
    parts = []
    for t in T_RE.finditer(p_xml):
        parts.append(t.group(1).decode("utf-8", "replace"))
    return "".join(parts)


def first_run_rpr(p_xml: bytes) -> bytes:
    """Return the <w:rPr>...</w:rPr> from the paragraph's first run with text content, or empty."""
    for run in RUN_RE.finditer(p_xml):
        run_xml = run.group(0)
        if T_RE.search(run_xml):
            m = RPR_RE.search(run_xml)
            return m.group(0) if m else b""
    return b""


def apply_subs(text: str) -> tuple[str, bool]:
    """Apply substitution rules. Return (new_text, changed)."""
    new = text
    for pat, repl in SUBS:
        new = re.sub(pat, repl, new)
    return new, new != text


def xml_escape(s: str) -> str:
    return (s.replace("&", "&amp;")
             .replace("<", "&lt;")
             .replace(">", "&gt;"))


def rewrite_paragraph(p_xml: bytes, new_text: str) -> bytes:
    """Rewrite the paragraph: keep <w:pPr> and the first run's rPr;
    replace ALL runs (and their <w:t>s) with a SINGLE run containing the new text."""
    # extract pPr (paragraph properties) if present — keep as-is
    ppr_match = re.search(rb"<w:pPr\b[^>]*>.*?</w:pPr>", p_xml, re.DOTALL)
    ppr_xml = ppr_match.group(0) if ppr_match else b""
    # also handle self-closing <w:pPr/>
    if not ppr_xml:
        spr = re.search(rb"<w:pPr\s*/>", p_xml)
        if spr: ppr_xml = spr.group(0)

    # preserve opening <w:p ...> tag verbatim
    open_m = re.match(rb"<w:p\b[^>]*>", p_xml)
    open_tag = open_m.group(0)

    rpr_xml = first_run_rpr(p_xml)

    text_xml = xml_escape(new_text).encode("utf-8")
    # xml:space="preserve" so leading/trailing spaces are kept
    new_run = b"<w:r>" + rpr_xml + b'<w:t xml:space="preserve">' + text_xml + b"</w:t></w:r>"
    return open_tag + ppr_xml + new_run + b"</w:p>"


def process_xml_bytes(xml: bytes, file_label: str = "") -> tuple[bytes, int]:
    """Walk paragraphs, apply subs, rewrite changed paragraphs. Returns (new_bytes, n_paragraphs_changed)."""
    n_changed = 0
    out_parts = []
    last_end = 0
    for pm in PARAGRAPH_RE.finditer(xml):
        out_parts.append(xml[last_end:pm.start()])
        p_xml = pm.group(0)
        orig_text = collapse_paragraph(p_xml)
        new_text, changed = apply_subs(orig_text)
        if changed and new_text.strip() != orig_text.strip():
            # only rewrite if substitution actually changed visible text
            try:
                new_p = rewrite_paragraph(p_xml, new_text)
                out_parts.append(new_p)
                n_changed += 1
            except Exception as e:
                print(f"   ! rewrite failed in {file_label}: {e}")
                out_parts.append(p_xml)
        else:
            out_parts.append(p_xml)
        last_end = pm.end()
    out_parts.append(xml[last_end:])
    return b"".join(out_parts), n_changed


def process_docx(fp: Path) -> dict:
    """Process one docx file, rewriting in place. Backup to .bak-templatize."""
    stats = {"file": fp.name, "paragraphs_changed": 0, "xml_parts_changed": 0}

    bak = fp.with_suffix(fp.suffix + ".bak-templatize")
    if not bak.exists():
        shutil.copy2(fp, bak)

    # Read all parts, modify document/header/footer XMLs
    with zipfile.ZipFile(fp, "r") as zin:
        names = zin.namelist()
        parts = {n: zin.read(n) for n in names}

    for n in list(parts.keys()):
        if re.match(r"word/(document|header\d*|footer\d*)\.xml$", n):
            new_bytes, n_ch = process_xml_bytes(parts[n], file_label=f"{fp.name}::{n}")
            if n_ch:
                parts[n] = new_bytes
                stats["paragraphs_changed"] += n_ch
                stats["xml_parts_changed"] += 1

    # Re-zip preserving original compression
    tmp = fp.with_suffix(fp.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, parts[n])
    tmp.replace(fp)
    return stats


def main():
    total_paragraphs = 0
    for rel in TARGET_FILES:
        fp = ROOT / rel
        if not fp.exists():
            print(f"!! missing: {rel}")
            continue
        stats = process_docx(fp)
        marker = "✓" if stats["paragraphs_changed"] else "·"
        print(f"  {marker} {rel}: {stats['paragraphs_changed']} paragraphs across {stats['xml_parts_changed']} XML parts")
        total_paragraphs += stats["paragraphs_changed"]
    print(f"\nDone. {total_paragraphs} paragraphs rewritten across {len(TARGET_FILES)} files.")


if __name__ == "__main__":
    main()
