#!/usr/bin/env python3
"""
Normalize template placeholder keys across all Carte Bransament templates:

  1. Collapse `{project_street_type}. {project_street}, nr. {project_street_number}`
     (and minor whitespace variants) into a single `{project_address}` placeholder.
     Reason: project.address is a top-level DB column that's reliably populated,
     while the split fields read from project.metadata and default to empty
     strings — leaving generated docs with "Str. , nr. " when metadata is empty.

  2. Rename two non-standard keys to their standard team-role equivalents:
       {nume_instalator_autorizat} → {instalator_nume}
       {nume_rts}                  → {sudor_nume}

The replacement is XML-aware: it works on the concatenated visible text of each
<w:p>, finds the pattern, and then rewrites the run XML so the entire matched
span becomes a single <w:r><w:t>{project_address}</w:t></w:r> (preserving the
formatting of the first contributing run). This mirrors the placeholder-
consolidation pass from fix-docx-templates.py.

Usage:
  python3 scripts/fix-template-keys.py <file.docx> [file2.docx ...]
  Output: <input>-keysfixed.docx alongside each input.
"""
import sys, os, re, zipfile
from io import BytesIO
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NS = "http://www.w3.org/XML/1998/namespace"
W = f"{{{W_NS}}}"
XML = f"{{{XML_NS}}}"

# Patterns to collapse. Each tuple is (visible-text regex, replacement-text).
# Order matters — longest/most-specific first.
PATTERNS = [
    # Full sentence with {project_street_type} placeholder
    (
        re.compile(r"\{project_street_type\}\s*[.,]?\s*\{project_street\}\s*,?\s*nr\.?\s*\{project_street_number\}", re.IGNORECASE),
        "{project_address}",
    ),
    (
        re.compile(r"\{project_street_type\}\s*[.,]?\s*\{project_street\}\s*,?\s*\{project_street_number\}", re.IGNORECASE),
        "{project_address}",
    ),
    # Same patterns but with LITERAL "Str." / "str." prefix instead of {project_street_type}.
    # The default for project_street_type is "Str" anyway, so collapsing the literal
    # prefix into project_address loses nothing.
    (
        re.compile(r"(?i)\b(?:str|b-?dul|bd|bld|bdul|aleea|sos|șos|șoseaua|calea|piata|piața|intr|intrarea)\.?\s*\{project_street\}\s*,?\s*nr\.?\s*\{project_street_number\}", re.IGNORECASE),
        "{project_address}",
    ),
    (
        re.compile(r"(?i)\b(?:str|b-?dul|bd|bld|bdul|aleea|sos|șos|șoseaua|calea|piata|piața|intr|intrarea)\.?\s*\{project_street\}\s*,?\s*\{project_street_number\}", re.IGNORECASE),
        "{project_address}",
    ),
    # Two-field variant: street_type + street (no number) — kept last so it doesn't
    # eat the leading "Str. {project_street}" of the longer "Str. {project_street}, nr. ..." patterns above.
    (
        re.compile(r"\{project_street_type\}\s*[.,]?\s*\{project_street\}", re.IGNORECASE),
        "{project_address}",
    ),
    # Standalone typo renames
    (re.compile(r"\{nume_instalator_autorizat\}"), "{instalator_nume}"),
    (re.compile(r"\{nume_rts\}"), "{sudor_nume}"),
]

# ── Namespace setup for clean output ──
ET.register_namespace("", W_NS)
NAMESPACES = {
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
    "cx": "http://schemas.microsoft.com/office/drawing/2014/chartex",
    "aink": "http://schemas.microsoft.com/office/drawing/2016/ink",
    "am3d": "http://schemas.microsoft.com/office/drawing/2017/model3d",
}
for p, u in NAMESPACES.items():
    if p:
        ET.register_namespace(p, u)


def collapse_pattern_in_paragraph(p_elem, pattern, replacement):
    """Walk a <w:p>; for each match of `pattern` in the concatenated visible
       text, rewrite the involved <w:r>/<w:t> elements so the match becomes a
       single <w:t> containing `replacement`. Returns count of replacements."""
    replaced = 0
    while True:
        # (run_index, t_element) pairs in document order. Skip runs without
        # a <w:t> (drawings, fldChar, etc) — we never expect to replace text
        # that spans those.
        runs_with_t = []
        for r in list(p_elem):
            if r.tag != f"{W}r":
                continue
            t = r.find(f"{W}t")
            if t is not None:
                runs_with_t.append((r, t))

        if not runs_with_t:
            return replaced

        cum_ends = []
        for _, t in runs_with_t:
            cum_ends.append((cum_ends[-1] if cum_ends else 0) + len(t.text or ""))
        full_text = "".join((t.text or "") for _, t in runs_with_t)

        m = pattern.search(full_text)
        if not m:
            return replaced

        def char_to_run(pos):
            for i, end in enumerate(cum_ends):
                if pos < end:
                    return i
            return len(cum_ends) - 1

        first_idx = char_to_run(m.start())
        last_idx = char_to_run(m.end() - 1)

        first_t = runs_with_t[first_idx][1]
        last_t = runs_with_t[last_idx][1]
        first_run_start = cum_ends[first_idx - 1] if first_idx > 0 else 0
        last_run_start = cum_ends[last_idx - 1] if last_idx > 0 else 0
        offset_in_first = m.start() - first_run_start
        offset_after_in_last = m.end() - last_run_start

        first_text = first_t.text or ""
        last_text = last_t.text or ""

        if first_idx == last_idx:
            # Within a single run — simple slice replacement
            first_t.text = first_text[:offset_in_first] + replacement + first_text[offset_after_in_last:]
        else:
            first_t.text = first_text[:offset_in_first] + replacement
            for mid in range(first_idx + 1, last_idx):
                runs_with_t[mid][1].text = ""
            last_t.text = last_text[offset_after_in_last:]

        if first_t.text != first_t.text.strip():
            first_t.set(f"{XML}space", "preserve")

        replaced += 1
        # Loop restarts to find the next occurrence.


def fix_xml(xml: str) -> tuple[str, int]:
    # Cheap skip: bail out only if none of our placeholder NAMES appear at all.
    # We can't use a flat-text whole-doc search because XML paragraph boundaries
    # get collapsed and word-boundary anchors like `\bstr` then fail at run joins
    # ("NATURALEStr." vs "...NATURALE\nStr." across two <w:p>'s).
    NEEDLE_TOKENS = ("project_street", "nume_instalator_autorizat", "nume_rts")
    if not any(t in xml for t in NEEDLE_TOKENS):
        return xml, 0
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        print(f"    ! XML parse error: {e}")
        return xml, 0

    total = 0
    for p_elem in root.iter(f"{W}p"):
        for pattern, replacement in PATTERNS:
            total += collapse_pattern_in_paragraph(p_elem, pattern, replacement)

    if total == 0:
        return xml, 0

    out = ET.tostring(root, encoding="utf-8").decode("utf-8")
    if xml.lstrip().startswith("<?xml") and not out.startswith("<?xml"):
        out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + out
    # See templatize-conducta.py for why this is needed — ET drops xmlns: decls
    # for unused namespaces, breaking Word's mc:Ignorable resolution.
    out = _restore_ignorable_namespaces(out)
    return out, total


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
        out_path = base + "-keysfixed" + ext

    with open(out_path, "wb") as f:
        f.write(out_buf.getvalue())
    stats["output"] = out_path
    return stats


def main():
    args = sys.argv[1:]
    in_place = "--in-place" in args
    args = [a for a in args if a != "--in-place"]
    if not args:
        print("Usage: python3 fix-template-keys.py [--in-place] <file.docx> ...")
        sys.exit(1)

    grand = 0
    touched_files = 0
    for path in args:
        if not os.path.exists(path):
            print(f"  ✗ {path}: not found")
            continue
        try:
            stats = fix_one(path, in_place)
        except Exception as e:
            print(f"  ✗ {os.path.basename(path)}: {e}")
            continue
        if stats["replacements"] > 0:
            print(f"  ~ {os.path.basename(path)}  ({stats['replacements']} replacement(s))")
            touched_files += 1
            grand += stats["replacements"]
        else:
            print(f"  · {os.path.basename(path)}  (no changes)")
    print(f"\nDone: {grand} total replacement(s) across {touched_files} file(s).")


if __name__ == "__main__":
    main()
