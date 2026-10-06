#!/usr/bin/env python3
"""
Comprehensive docx template repair tool for the Carte Bransament templates.
Fixes four classes of problems that prevent the documents from rendering /
substituting correctly in the Operio pipeline:

  1. **VML legacy images → DrawingML**
     Old Word headers reference images via <w:pict><v:shape><v:imagedata>.
     Modern renderers (Puppeteer/LibreOffice/docxtemplater previews) often
     strip or break on VML. We rewrite each such block as the equivalent
     <w:drawing><wp:inline>...<a:blip r:embed="..."/>...</wp:inline></w:drawing>,
     preserving the r:id (so word/_rels/*.rels doesn't change).

  2. **Strip <w:numPr> from body, headers, footers, styles**
     numPr in styles.xml turns Heading2 paragraphs into auto-numbered lists.
     numPr in the body adds "1./2./•" markers to table cells (e.g. Nr. crt
     columns auto-filling with 1, 2, 3 instead of staying empty).

  3. **Strip <w:proofErr> and <w:noProof>**
     Spell-check markers that Word inserts around unknown words (like our
     {placeholders}). Removing them helps a downstream pass merge runs.

  4. **Consolidate split placeholders into single runs** ← the critical one
     When a template author colored {placeholder} text red+bold to highlight
     it for editors, Word stored the placeholder across MULTIPLE <w:r> runs
     with different <w:rPr>. docxtemplater scans for {...} in single runs and
     can't see split tokens. We walk each <w:p>, find {placeholder} patterns
     in the concatenated visible text, and rewrite the involved runs so the
     placeholder lives in ONE run (the formatting of the first contributing
     run is kept; the placeholder name's red/bold styling is lost, but it
     would disappear on substitution anyway).

Usage:
  python3 scripts/fix-docx-templates.py <file1.docx> [file2.docx ...]
  python3 scripts/fix-docx-templates.py --in-place <file.docx>

Output (default): writes <input>-fixed.docx next to each original.
With --in-place: overwrites the original (use after verifying on a copy).
"""
import sys
import os
import re
import zipfile
import shutil
from io import BytesIO
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
W = f"{{{W_NS}}}"
XML = f"{{{XML_NS}}}"

PLACEHOLDER_RE = re.compile(r"\{[a-z_][a-zA-Z0-9_]*\}")

# ── Regex-based fixes (operate on raw XML strings) ────────────────────────

def pt_to_emu(pt: float) -> int:
    return round(pt * 12700)


def convert_vml_to_drawingml(xml: str) -> tuple[str, int]:
    """Rewrite <w:pict>...<v:imagedata>...</w:pict> as <w:drawing>.

    SAFETY: only converts picts that contain EXACTLY ONE <v:shape> AND that
    shape has an imagedata. Picts containing multiple shapes (e.g. a page
    border drawn via several v:shape/v:line/v:rect children, or v:group) are
    LEFT ALONE — replacing those would destroy layout vector graphics. The
    earlier version always replaced the entire <w:pict> block, killing 23+
    layout shapes on NEOGAS Pagina de capat and producing broken renders.
    """
    changed = 0

    def replace(match: re.Match) -> str:
        nonlocal changed
        inner = match.group(1)
        img_id = re.search(r'<v:imagedata\b[^>]*?r:id="([^"]+)"', inner)
        if not img_id:
            return match.group(0)
        # Guard: skip if there are multiple shapes (this <w:pict> isn't a pure
        # image — it's a composite drawing with layout). Conservative: count
        # both <v:shape>/<v:line>/<v:rect>/<v:group> markers.
        shape_count = (
            inner.count("<v:shape") + inner.count("<v:line")
            + inner.count("<v:rect") + inner.count("<v:group")
            + inner.count("<v:oval") + inner.count("<v:roundrect")
        )
        if shape_count > 1:
            return match.group(0)  # composite drawing — preserve as-is
        rid = img_id.group(1)

        style_match = re.search(r'<v:shape\b[^>]*?\sstyle="([^"]+)"', inner)
        w_pt, h_pt = 100.0, 50.0
        if style_match:
            style = style_match.group(1)
            wm = re.search(r"width:\s*([\d.]+)pt", style)
            hm = re.search(r"height:\s*([\d.]+)pt", style)
            if wm:
                w_pt = float(wm.group(1))
            if hm:
                h_pt = float(hm.group(1))
        cx = pt_to_emu(w_pt)
        cy = pt_to_emu(h_pt)
        changed += 1

        return (
            "<w:drawing>"
            f'<wp:inline distT="0" distB="0" distL="0" distR="0" '
            f'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
            f'<wp:extent cx="{cx}" cy="{cy}"/>'
            f'<wp:effectExtent l="0" t="0" r="0" b="0"/>'
            f'<wp:docPr id="1" name="Picture 1"/>'
            "<wp:cNvGraphicFramePr>"
            '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>'
            "</wp:cNvGraphicFramePr>"
            '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            '<pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            '<pic:spPr><a:xfrm><a:off x="0" y="0"/>'
            f'<a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            "</pic:pic></a:graphicData></a:graphic>"
            "</wp:inline></w:drawing>"
        )

    out = re.sub(r"<w:pict\b[^>]*>([\s\S]*?)</w:pict>", replace, xml)
    return out, changed


def strip_numPr(xml: str) -> tuple[str, int]:
    changed = 0
    def count(m):
        nonlocal changed
        changed += 1
        return ""
    out = re.sub(r"<w:numPr\b[^>]*>[\s\S]*?</w:numPr>", count, xml)
    out = re.sub(r"<w:numPr\b[^/]*?/>", count, out)
    return out, changed


def strip_proof_markers(xml: str) -> tuple[str, int]:
    """Spell-check decorations that fragment placeholders into separate runs."""
    changed = 0
    def count(m):
        nonlocal changed
        changed += 1
        return ""
    out = re.sub(r"<w:proofErr\b[^/]*/>", count, xml)
    out = re.sub(r"<w:noProof\b[^/]*/>", count, out)
    return out, changed


# ── Placeholder normalization (ElementTree-based) ─────────────────────────

# Register the most common namespaces so the round-tripped XML keeps the
# expected prefixes (`w:`, `r:`, etc.) instead of ns0/ns1.
ET.register_namespace("", W_NS)  # default
NAMESPACES = {
    "w": W_NS,
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
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
    "cx": "http://schemas.microsoft.com/office/drawing/2014/chartex",
    "aink": "http://schemas.microsoft.com/office/drawing/2016/ink",
    "am3d": "http://schemas.microsoft.com/office/drawing/2017/model3d",
}
for prefix, uri in NAMESPACES.items():
    if prefix:
        ET.register_namespace(prefix, uri)


def consolidate_paragraph_placeholders(p_elem: ET.Element) -> int:
    """For one <w:p>, find {placeholder} tokens that span multiple <w:r> runs
       and rewrite the runs so each placeholder ends up in a single run."""
    fixed_count = 0

    while True:
        # Collect (run, t_element) pairs in document order. We only care about
        # direct <w:r><w:t> pairs; runs containing fldChar, drawing, br, etc.
        # are skipped — placeholders never legitimately span those.
        runs_with_t: list[tuple[ET.Element, ET.Element]] = []
        for r in list(p_elem):
            if r.tag != f"{W}r":
                continue
            for t in r.findall(f"{W}t"):
                runs_with_t.append((r, t))
                break  # at most one <w:t> per run we care about

        if len(runs_with_t) < 2:
            return fixed_count

        # Build cumulative offsets and concatenated text.
        cum_ends: list[int] = []
        full_text_parts: list[str] = []
        for _, t in runs_with_t:
            txt = t.text or ""
            full_text_parts.append(txt)
            cum_ends.append((cum_ends[-1] if cum_ends else 0) + len(txt))
        full_text = "".join(full_text_parts)

        def char_to_run(pos: int) -> int:
            for i, end in enumerate(cum_ends):
                if pos < end:
                    return i
            return len(cum_ends) - 1

        # Find the first split placeholder; fix it; restart loop.
        target = None
        for m in PLACEHOLDER_RE.finditer(full_text):
            first = char_to_run(m.start())
            last = char_to_run(m.end() - 1)
            if first != last:
                target = (m, first, last)
                break

        if not target:
            return fixed_count

        m, first_idx, last_idx = target
        placeholder = m.group(0)
        ph_start, ph_end = m.start(), m.end()

        first_run_start = cum_ends[first_idx - 1] if first_idx > 0 else 0
        last_run_start = cum_ends[last_idx - 1] if last_idx > 0 else 0
        offset_in_first = ph_start - first_run_start
        offset_after_close_in_last = ph_end - last_run_start

        first_t = runs_with_t[first_idx][1]
        last_t = runs_with_t[last_idx][1]
        first_text = first_t.text or ""
        last_text = last_t.text or ""

        # New first-run text: prefix before { + the entire placeholder.
        first_t.text = first_text[:offset_in_first] + placeholder
        # Preserve trailing/leading whitespace correctly.
        if first_t.text != first_t.text.strip():
            first_t.set(f"{XML}space", "preserve")

        # Clear middle runs' text (we keep the empty <w:t> elements; harmless).
        for mid in range(first_idx + 1, last_idx):
            runs_with_t[mid][1].text = ""

        # New last-run text: the part AFTER the closing }.
        last_t.text = last_text[offset_after_close_in_last:]
        if last_t.text and last_t.text != last_t.text.strip():
            last_t.set(f"{XML}space", "preserve")

        fixed_count += 1
        # Loop restarts to find the next split placeholder.


def normalize_placeholders(xml: str) -> tuple[str, int]:
    """Parse, fix, re-serialize. Preserves the XML declaration."""
    if "{" not in xml:
        return xml, 0
    # ElementTree mangles the XML declaration; keep it ourselves.
    has_decl = xml.lstrip().startswith("<?xml")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        print(f"    ! XML parse error, skipping placeholder pass: {e}")
        return xml, 0

    fixed_total = 0
    for p in root.iter(f"{W}p"):
        fixed_total += consolidate_paragraph_placeholders(p)

    if fixed_total == 0:
        return xml, 0

    out_bytes = ET.tostring(root, encoding="utf-8")
    out = out_bytes.decode("utf-8")
    if has_decl and not out.startswith("<?xml"):
        out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + out
    # Word requires every prefix in mc:Ignorable to have a matching xmlns:
    # declaration on the root. ET drops unused-but-declared namespaces during
    # serialization; restore them so Word doesn't refuse the file.
    out = _restore_ignorable_namespaces(out)
    return out, fixed_total


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


# ── Driver ────────────────────────────────────────────────────────────────

XML_PATHS_PATTERN = re.compile(r"^word/(document|header\d*|footer\d*|styles)\.xml$")
PLACEHOLDER_TARGETS = re.compile(r"^word/(document|header\d*|footer\d*)\.xml$")


def fix_one(in_path: str, in_place: bool) -> dict:
    with open(in_path, "rb") as f:
        buf = f.read()

    # Re-pack via a fresh zip so we can rewrite specific parts.
    out_buf = BytesIO()
    stats = {"vml": 0, "numPr": 0, "proof": 0, "placeholders": 0, "files_touched": 0}

    with zipfile.ZipFile(BytesIO(buf), "r") as zin:
        with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                touched = False
                if XML_PATHS_PATTERN.match(item.filename):
                    xml = data.decode("utf-8", errors="replace")
                    before = xml

                    if item.filename != "word/styles.xml":
                        xml, n = convert_vml_to_drawingml(xml)
                        stats["vml"] += n

                    xml, n = strip_numPr(xml)
                    stats["numPr"] += n

                    if PLACEHOLDER_TARGETS.match(item.filename):
                        xml, n = strip_proof_markers(xml)
                        stats["proof"] += n
                        xml, n = normalize_placeholders(xml)
                        stats["placeholders"] += n

                    if xml != before:
                        data = xml.encode("utf-8")
                        touched = True
                        stats["files_touched"] += 1

                # Preserve original ZipInfo (compression, datetime, etc.)
                zout.writestr(item, data)

    out_bytes = out_buf.getvalue()
    if in_place:
        out_path = in_path
    else:
        base, ext = os.path.splitext(in_path)
        out_path = base + "-fixed" + ext

    with open(out_path, "wb") as f:
        f.write(out_bytes)

    stats["output"] = out_path
    return stats


def main():
    args = sys.argv[1:]
    in_place = False
    if "--in-place" in args:
        in_place = True
        args = [a for a in args if a != "--in-place"]
    if not args:
        print("Usage: python3 fix-docx-templates.py [--in-place] <file.docx> ...")
        sys.exit(1)

    print(f"Processing {len(args)} file(s); mode: {'in-place' if in_place else 'side-by-side'}")
    print()
    grand = {"vml": 0, "numPr": 0, "proof": 0, "placeholders": 0, "files_touched": 0}
    for path in args:
        if not os.path.exists(path):
            print(f"  ✗ {path}: not found")
            continue
        try:
            stats = fix_one(path, in_place)
        except Exception as e:
            print(f"  ✗ {path}: {e}")
            continue
        any_change = stats["files_touched"] > 0
        marker = "~" if any_change else "·"
        print(f"  {marker} {os.path.basename(path)}")
        if any_change:
            print(f"      VML→DrawingML: {stats['vml']}, "
                  f"numPr stripped: {stats['numPr']}, "
                  f"proof tags stripped: {stats['proof']}, "
                  f"placeholders consolidated: {stats['placeholders']}")
            print(f"      → {stats['output']}")
        for k in grand:
            if k in stats and isinstance(stats[k], int):
                grand[k] += stats[k]
    print()
    print(f"Totals: VML→DrawingML: {grand['vml']}, numPr stripped: {grand['numPr']}, "
          f"proof tags stripped: {grand['proof']}, placeholders consolidated: {grand['placeholders']}")


if __name__ == "__main__":
    main()
