#!/usr/bin/env python3
"""
Verify templatize-v2 outputs against their originals.

  python3 scripts/verify-templates.py scripts/templatize-v2/distrigaz.json [--only 12,13] [--no-render]

Per member:
  • red      — runs/paragraph marks/styles still colored red (must be 0)
  • deny     — sample-work tokens from the mapping's denyList still in the text (must be none)
  • unknown  — placeholder names the generator doesn't know (existing variables + the contract)
  • parse    — docxtemplater (operio-api/node_modules, same options as docx-engine.ts) parses + renders
  • pages    — filled with scripts/templatize-v2/sample-data.json and rendered by LibreOffice: page
               count vs the original's (blank spill pages that only carry the header/footer don't count)
  • _check/NN.png — original | filled, side by side, for a visual check

Needs: lxml, Pillow, soffice, pdftoppm/pdfinfo/pdftotext, node.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

HERE = Path(__file__).resolve().parent
API = HERE.parent
ROOT = API.parent
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def w(t):
    return f"{{{W}}}{t}"


sys.path.insert(0, str(HERE))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("tv2", HERE / "templatize-v2.py")
tv2 = importlib.util.module_from_spec(_spec)
sys.modules["tv2"] = tv2
_spec.loader.exec_module(tv2)

# ───────────── known variables ─────────────

ROLES = ["instalator", "proiectant", "rte", "sef_santier", "cq", "diriginte", "verificator", "sudor", "rts"]
ROLE_FIELDS = ["nume", "nume_familie", "prenume", "legitimatie", "legitimatie_data", "tip", "autorizatie", "autorizatii", "poanson", "valabilitate",
               "atestat", "atestat_data", "domeniu", "decizie_nr", "decizie_data", "signature"]
STATIC = """
tenant_name tenant_cui tenant_reg_com tenant_address tenant_city tenant_county tenant_phone tenant_email tenant_admin_name
tenant_iscir_number tenant_iscir_date tenant_logo tenant_signature tenant_stamp tenant_stamp_2 tenant_stamp_3 tenant_stamp_4
tenant_anre_nr tenant_anre_tip tenant_anre_data tenant_anre_exp tenant_autorizatie_anre tenant_autorizatie_data tenant_iscir_exp
tenant_postal tenant_iban tenant_bank tenant_operator_sistem
tenant_autorizatie_proiectare_nr tenant_autorizatie_proiectare_data tenant_autorizatie_proiectare_tip
client_name client_company_name client_first_name client_last_name client_cui client_type client_address client_city
client_county client_phone client_email
project_name PROJECT_NAME project_type project_address project_city project_county project_status project_street_type
project_street project_street_number project_dn project_material project_length project_drawing project_sudori
nr_inregistrare data_inregistrare nr_inregistrare_data
osd_denumire osd_adresa osd_regiune osd_sector osd_telefon osd_fax osd_punct_lucru osd_directia
bransament_lungime_reiser bransament_lungime_totala teu_dn teava_cc_data teava_dc_data documente_materiale bon_predare_data
reiser_lot reiser_furnizor firida_tip planse_nr zona_afectata distanta_limita suduri_lista suduri total_suduri
nr_crt cod rezultat
sudor_ol_nume sudor_ol_aut_intern sudor_ol_aut_iscir sudor_ol_poanson sudor_ol_autorizatii sudor_ol_aut_data
sudor_pe_nume sudor_pe_aut_intern sudor_pe_aut_iscir sudor_pe_poanson sudor_pe_autorizatii sudor_pe_aut_data
rts_atestat_data proba_rezistenta_durata_text proba_etanseitate_durata_text
year osd_director project_length_km teava_cc_an teava_dc_an bransament_presiune_abr conducta_stradala_dn adresa_detalii_text
pv_predare_data pv_trasare_data pv_sapatura_data pv_asternere_data pv_montare_data pv_lansare_data pv_fir_trasor_data
pv_rezistenta_data pv_etanseitate_data pv_lucrari_ascunse_data pv_control_calitate_data
etape nr_etapa sufix lungime_etapa dn_etapa tronsoane_etapa_text lungime_total_pe lungime_total_ol tip buc operatiune spatiu_verde pietris macadam pavele asfalt_carosabil asfalt_trotuar beton latime cantitate
documente_materiale_linii text tronsoane_text project_drawing_mic dn_1 lungime_1 dn_2 lungime_2 suduri_coduri_text dimensiune schita_materiale nr_inregistrare
pv_proba_casa_data pv_tub_protectie_data pv_receptie_calitativa_data proba_casa_durata_text
conducta_lungime_totala conducta_dn_lungimi_text conducta_dn_text lungimi_dn tronsoane subtraversari comuna strada de_la pana_la dn material lungime data descriere adancime
ldn_20 lungime_dn_20 ldn_25 lungime_dn_25 ldn_32 lungime_dn_32 ldn_40 lungime_dn_40 ldn_50 lungime_dn_50 ldn_63 lungime_dn_63 ldn_75 lungime_dn_75 ldn_90 lungime_dn_90 ldn_110 lungime_dn_110 ldn_125 lungime_dn_125 ldn_160 lungime_dn_160 ldn_180 lungime_dn_180 ldn_200 lungime_dn_200 ldn_225 lungime_dn_225 ldn_250 lungime_dn_250 ldn_315 lungime_dn_315
materiale materiale_srm materiale_conducta schema_materiale denumire diametru cantitate furnizor certificat declaratie nr_suduri
sudor autorizatie procedeu omologare sudori_autorizatii nume
""".split()


def known_names() -> set[str]:
    names = set(STATIC)
    src = (API / "src/lib/dossier-fields.ts").read_text()
    for m in re.finditer(r'\{\s*key:\s*"([a-z_0-9]+)"[^\n]*?(?:aliases:\s*\[([^\]]*)\])?', src):
        names.add(m.group(1))
        if m.group(2):
            names.update(re.findall(r'"([a-z_0-9]+)"', m.group(2)))
    import itertools
    sys.path.insert(0, str(API))
    for slug in ["vana_pehd","mufa_ef","reductie_injectat","reductie_electrofuziune","cot_injectat","cot_electrofuziune","teu_egal_injectat","teu_egal_electrofuziune","teu_redus_injectat","teu_redus_electrofuziune","sa_bransament","capac_ef"]:
        for i, k in itertools.product((1, 2), ("dn", "buc")):
            names.add(f"fpe_{slug}_{i}_{k}")
    for slug in ["vana_ol","curba_sudura","reductie_ol","fiting_tranzitie_ol_pe","banda_izolatie_kebulen","rasuflator_spatiu_verde","rasuflator_carosabil","capac_gn","capac_gn_mare","fir_trasor","banda_avertizare"]:
        names.update({f"fol_{slug}_dn", f"fol_{slug}_q"})
    for d in ["2", "3", "4", "6", "8", "10", "12", "14"]:
        names.add(f"lungime_dn_ol_{d}")
    for r in ROLES:
        for f in ROLE_FIELDS:
            names.add(f"{r}_{f}")
    return names


# ───────────── checks on the template ─────────────

def parts(z: zipfile.ZipFile):
    return [n for n in z.namelist() if re.fullmatch(r"word/(document|header\d*|footer\d*)\.xml", n)]


def red_count(z: zipfile.ZipFile) -> int:
    n = 0
    for name in parts(z) + (["word/styles.xml"] if "word/styles.xml" in z.namelist() else []):
        root = etree.fromstring(z.read(name))
        n += sum(1 for c in root.iter(w("color")) if tv2.is_red(c.get(w("val"))))
    return n


def all_text(z: zipfile.ZipFile) -> str:
    out = []
    for name in parts(z):
        root = etree.fromstring(z.read(name))
        for p in root.iter(w("p")):
            out.append(tv2.visible_text(p))
    return "\n".join(out)


PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr",
             "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap",
             "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid",
             "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
             "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"]
RPR_ORDER = ["rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
             "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
             "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs",
             "em", "lang", "eastAsianLayout", "specVanish", "oMath"]
ORDERS = {"pPr": PPR_ORDER, "rPr": RPR_ORDER, "tblPr": tv2.TBLPR_ORDER, "tcPr": tv2.TCPR_ORDER}


def word_problems(z: zipfile.ZipFile) -> list[str]:
    """Things Word refuses or 'repairs': mc:Ignorable prefixes without a namespace declaration,
    out-of-order children in pPr/rPr/tblPr/tcPr."""
    out = []
    for name in parts(z) + ["word/styles.xml", "word/settings.xml"]:
        if name not in z.namelist():
            continue
        raw = z.read(name)
        root = etree.fromstring(raw)
        ig = root.get("{http://schemas.openxmlformats.org/markup-compatibility/2006}Ignorable")
        if ig:
            missing = [p for p in ig.split() if p not in (root.nsmap or {})]
            if missing:
                out.append(f"{name}: mc:Ignorable prefixes not declared {missing}")
        for tag, order in ORDERS.items():
            for el in root.iter(w(tag)):
                seq = [k.tag.split("}")[1] for k in el if isinstance(k.tag, str) and k.tag.startswith("{" + W)]
                idx = [order.index(k) for k in seq if k in order]
                if idx != sorted(idx):
                    out.append(f"{name}: <w:{tag}> children out of order {seq}")
                    break
    return out


def deny_hits(text: str, deny: list[str]) -> list[str]:
    hits = []
    for tok in deny:
        pat = re.escape(tok)
        if re.match(r"\w", tok):
            pat = r"(?<![\w])" + pat
        if re.search(r"\w$", tok):
            pat = pat + r"(?![\w])"
        if re.search(pat, text):
            hits.append(tok)
    return hits


def placeholders(text: str) -> list[str]:
    return [m.group(1) for m in re.finditer(r"\{[#/^%]?([^{}]+)\}", text)]


# ───────────── rendering ─────────────

def soffice_pdf(files: list[Path], outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", "pdf",
                        "--outdir", str(outdir), *map(str, files)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=900)


def pdf_pages(pdf: Path) -> int:
    out = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    return int(re.search(r"Pages:\s+(\d+)", out).group(1))


def content_pages(pdf: Path) -> int:
    """Pages minus trailing pages whose only text is what every page repeats (header/footer)."""
    n = pdf_pages(pdf)
    if n <= 1:
        return n
    texts = []
    for i in range(1, n + 1):
        t = subprocess.run(["pdftotext", "-f", str(i), "-l", str(i), "-layout", str(pdf), "-"],
                           capture_output=True, text=True).stdout
        texts.append({ln.strip() for ln in t.splitlines() if ln.strip()})
    common = set.intersection(*texts)
    while n > 1 and not (texts[n - 1] - common):
        n -= 1
    return n


def render_pngs(pdf: Path, prefix: Path, dpi=60) -> list[Path]:
    subprocess.run(["pdftoppm", "-r", str(dpi), "-png", str(pdf), str(prefix)], check=True)
    return sorted(prefix.parent.glob(prefix.name + "-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))


def side_by_side(left: list[Path], right: list[Path], out: Path, title: str) -> None:
    from PIL import Image, ImageDraw

    L = [Image.open(p).convert("RGB") for p in left]
    R = [Image.open(p).convert("RGB") for p in right]
    colw = max([i.width for i in L + R] or [10])
    h = max(sum(i.height for i in L), sum(i.height for i in R)) + 24
    img = Image.new("RGB", (colw * 2 + 30, h), "white")
    d = ImageDraw.Draw(img)
    d.text((4, 4), f"ORIGINAL — {title}", fill="black")
    d.text((colw + 34, 4), "ȘABLON COMPLETAT (date de test)", fill="black")
    y = 24
    for i in L:
        img.paste(i, (0, y))
        d.rectangle([0, y, i.width - 1, y + i.height - 1], outline="#999")
        y += i.height
    y = 24
    for i in R:
        img.paste(i, (colw + 30, y))
        d.rectangle([colw + 30, y, colw + 30 + i.width - 1, y + i.height - 1], outline="#999")
        y += i.height
    img.save(out)


def sample_images(d: Path) -> None:
    from PIL import Image, ImageDraw

    d.mkdir(parents=True, exist_ok=True)
    logo = Image.new("RGB", (310, 160), "#1d4f91")
    ImageDraw.Draw(logo).text((20, 60), "SIGLA FIRMEI", fill="white")
    logo.save(d / "tenant_logo.png")
    dr = Image.new("RGB", (1120, 720), "white")
    g = ImageDraw.Draw(dr)
    g.rectangle([4, 4, 1115, 715], outline="black", width=3)
    g.line([60, 600, 1060, 120], fill="black", width=4)
    g.text((400, 340), "SCHIȚA LUCRĂRII (project_drawing)", fill="black")
    dr.save(d / "project_drawing.png")


# ───────────── main ─────────────

def main(argv):
    cfg = json.loads(Path(argv[1]).read_text())
    only = set(argv[argv.index("--only") + 1].split(",")) if "--only" in argv else None
    render = "--no-render" not in argv
    out_dir = ROOT / cfg["outDir"]
    src_dir = ROOT / cfg["sourceDir"]
    check = out_dir / "_check"
    work = check / "_work"
    work.mkdir(parents=True, exist_ok=True)
    known = known_names()
    members = [m for i, m in enumerate(cfg["members"]) if not only or m.get("id", str(i)) in only]

    sample_images(work / "img")
    filled = {}
    fill_args = []
    for m in members:
        f = work / f"filled-{m['id']}.docx"
        filled[m["id"]] = f
        fill_args += [str(out_dir / m["out"]), str(f)]
    proc = subprocess.run(["node", str(HERE / "templatize-v2/fill-sample.mjs"), str(HERE / "templatize-v2/sample-data.json"),
                           str(work / "img"), *fill_args], cwd=API, capture_output=True, text=True)
    fills = {}
    for line in proc.stdout.splitlines():
        r = json.loads(line)
        fills[r["file"]] = r
    if proc.returncode:
        print(proc.stderr)

    if render:
        soffice_pdf([f for f in filled.values() if f.exists()], work / "pdf")
        origs = []
        for m in members:
            target = work / "orig" / (Path(m["src"]).stem + ".pdf")
            if not target.exists():
                origs.append(src_dir / m["src"])
        if origs:
            soffice_pdf(origs, work / "orig")

    rows = []
    for m in members:
        z = zipfile.ZipFile(out_dir / m["out"])
        text = all_text(z)
        reds = red_count(z)
        deny = deny_hits(text, cfg.get("denyList", []))
        names = sorted(set(placeholders(text)))
        unknown = [n for n in names if n not in known]
        fr = fills.get(str(out_dir / m["out"]), {"ok": False, "error": "not filled"})
        wp = word_problems(z)
        row = {"id": m["id"], "out": m["out"], "red": reds, "deny": deny, "placeholders": names, "unknown": unknown,
               "parse": fr["ok"], "parseError": fr.get("error"), "word": wp}
        if render and fr["ok"]:
            fpdf = work / "pdf" / f"filled-{m['id']}.pdf"
            opdf = work / "orig" / (Path(m["src"]).stem + ".pdf")
            row["pagesOrig"], row["pagesOrigContent"] = pdf_pages(opdf), content_pages(opdf)
            row["pagesFilled"], row["pagesFilledContent"] = pdf_pages(fpdf), content_pages(fpdf)
            # Same number of pages with content as the original; a blank spill page the original
            # has (header/footer only) may disappear on A4 but never appear. `expectedPages`
            # overrides for sources whose LibreOffice render isn't the reference (spreadsheets).
            if "expectedPages" in m:
                row["pagesOk"] = row["pagesFilled"] == m["expectedPages"]
            else:
                row["pagesOk"] = (row["pagesFilledContent"] == row["pagesOrigContent"]
                                  and row["pagesFilled"] <= row["pagesOrig"])
            for old in work.glob(f"o{m['id']}-*.png"):
                old.unlink()
            for old in work.glob(f"f{m['id']}-*.png"):
                old.unlink()
            lp = render_pngs(opdf, work / f"o{m['id']}")
            rp = render_pngs(fpdf, work / f"f{m['id']}")
            side_by_side(lp, rp, check / f"{m['id']}.png", m["out"])
        ok = reds == 0 and not deny and not unknown and fr["ok"] and row.get("pagesOk", True) and not wp
        row["ok"] = ok
        rows.append(row)
        pg = f"pages {row.get('pagesOrig')}/{row.get('pagesOrigContent')} → {row.get('pagesFilled')}/{row.get('pagesFilledContent')}" if render else ""
        print(f"{'✓' if ok else '✗'} {m['id']} {m['out'][:60]:60} red={reds} deny={deny or '-'} unknown={unknown or '-'} "
              f"parse={'ok' if fr['ok'] else fr.get('error')} {pg}" + (f" WORD: {wp[:3]}" if wp else ""))
    (check / "verify.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
