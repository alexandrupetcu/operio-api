#!/usr/bin/env python3
"""
Restore the OOXML namespace declarations + mc:Ignorable consistency on
<w:document>, <w:hdr>, <w:ftr> roots. ElementTree drops unused-but-declared
namespaces during round-trip; Word then refuses to open the file because
`mc:Ignorable="w14 wp14 w15"` references undeclared namespaces (LibreOffice
tolerates it, so PDFs still render).

Strategy: for each root element with `mc:Ignorable`, ensure each prefix listed
there has a matching `xmlns:` declaration. Inserts the standard OOXML URIs.

Operates on every .docx under both MegaConstruct + the two NEOGAS folders
since the same pipeline ran on all of them.
"""
import zipfile, re, os, sys

TARGET_DIRS = [
    "/Users/alex/Work/operio/documente/Carte Bransament Megaconstruct",
    "/Users/alex/Work/operio/documente/Carte constructie bransament GN NEOGAS GRID S.A.",
    "/Users/alex/Work/operio/documente/Carte Conducta Neogas Grid",
    "/Users/alex/Work/operio/documente/Carte Conducta Distrigaz",
    "/Users/alex/Work/operio/documente/Carte Bransament Templates",
]

# Canonical URIs for the most common "ignorable" Word namespaces.
NS_URIS = {
    "w14":    "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15":    "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid":   "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16se":    "http://schemas.microsoft.com/office/word/2015/wordml/symex",
    "w16":      "http://schemas.microsoft.com/office/word/2018/wordml",
    "w16cex":   "http://schemas.microsoft.com/office/word/2018/wordml/cex",
    "w16sdtdh": "http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash",
    "w16sdtfl": "http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock",
    "w16du":    "http://schemas.microsoft.com/office/word/2023/wordml/word16du",
    "wp14":   "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "wne":    "http://schemas.microsoft.com/office/word/2006/wordml",
    "wpg":    "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    "wpi":    "http://schemas.microsoft.com/office/word/2010/wordprocessingInk",
    "wps":    "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "v":      "urn:schemas-microsoft-com:vml",
    "o":      "urn:schemas-microsoft-com:office:office",
    "m":      "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "w10":    "urn:schemas-microsoft-com:office:word",
}


def fix_root_namespaces(xml: str, root_tag: str) -> tuple[str, int]:
    """Find the root element (e.g. 'w:document'/'w:hdr'/'w:ftr') and ensure
       every prefix listed in mc:Ignorable has a corresponding xmlns: decl.
       Returns the patched XML + count of declarations added."""
    # Find the opening root tag (greedy until the closing '>' of the element)
    m = re.search(rf"<{re.escape(root_tag)}\b([^>]*)>", xml)
    if not m:
        return xml, 0
    attrs = m.group(1)

    # Find mc:Ignorable value if present
    ig_m = re.search(r'mc:Ignorable="([^"]+)"', attrs)
    if not ig_m:
        return xml, 0
    prefixes_to_ensure = ig_m.group(1).split()

    declared = set(re.findall(r'xmlns:(\w+)=', attrs))
    added = []
    for prefix in prefixes_to_ensure:
        if prefix in declared:
            continue
        uri = NS_URIS.get(prefix)
        if not uri:
            continue
        added.append(f'xmlns:{prefix}="{uri}"')

    if not added:
        return xml, 0

    # Inject the new xmlns: decls right before the first existing xmlns: decl
    # (keeps the alphabetical-ish ordering Word writes by default).
    new_attrs = attrs.rstrip()
    # Insert at the start of attrs for simplicity — Word doesn't care about order.
    new_attrs = " " + " ".join(added) + " " + new_attrs.lstrip()
    new_root = f"<{root_tag}{new_attrs}>"
    return xml[: m.start()] + new_root + xml[m.end():], len(added)


ROOT_FOR_PATH = {
    "word/document.xml": "w:document",
}
def root_for_path(path: str) -> str | None:
    if path in ROOT_FOR_PATH:
        return ROOT_FOR_PATH[path]
    if re.match(r"word/header\d+\.xml$", path):
        return "w:hdr"
    if re.match(r"word/footer\d+\.xml$", path):
        return "w:ftr"
    return None


def process_file(path: str) -> tuple[int, int]:
    """Returns (parts_changed, total_namespaces_added)."""
    with zipfile.ZipFile(path) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    parts_changed = 0
    total_added = 0
    for name in list(parts.keys()):
        root_tag = root_for_path(name)
        if not root_tag:
            continue
        try:
            xml = parts[name].decode("utf-8", errors="replace")
        except Exception:
            continue
        new_xml, added = fix_root_namespaces(xml, root_tag)
        if added > 0:
            parts[name] = new_xml.encode("utf-8")
            parts_changed += 1
            total_added += added

    if parts_changed == 0:
        return 0, 0

    tmp = path + ".tmp"
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, parts.get(item.filename, zin.read(item.filename)))
    os.replace(tmp, path)
    return parts_changed, total_added


def main():
    # Allow filtering to specific dirs from CLI
    dirs = sys.argv[1:] if len(sys.argv) > 1 else TARGET_DIRS
    grand_parts = 0
    grand_added = 0
    file_count = 0
    for d in dirs:
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".docx") or f.startswith("~$") or f.startswith("_"):
                continue
            path = os.path.join(d, f)
            try:
                p, a = process_file(path)
            except Exception as e:
                print(f"  ✗ {f}: {e}")
                continue
            if a > 0:
                rel = os.path.join(os.path.basename(d), f)
                print(f"  ~ {rel[:80]:<80} parts={p} added={a}")
                grand_parts += p
                grand_added += a
                file_count += 1
    print(f"\nDone: {file_count} file(s) patched. Parts touched: {grand_parts}, namespaces added: {grand_added}")


if __name__ == "__main__":
    main()
