"""Dosar ISC: diametrul și lungimea unice → dimensiunile conductei (mai multe diametre)."""
import sys, re, zipfile, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from runrep import para_replace, q, etree
RULES = [
    (r"Dn \{project_dn\} mm, *L *= *\{project_length\} ml", "{isc_dn_l_text}"),
    (r"DN \{project_dn\} mm", "DN {isc_dn_text} mm"),
    (r"tronson de \{project_length\} (ml|m)", r"tronson de {isc_lungime} \1"),
]
def patch(src, dst):
    z = zipfile.ZipFile(src); x = etree.fromstring(z.read("word/document.xml")); n = 0
    for p in x.iter(q("p")):
        for pat, rep in RULES:
            while para_replace(p, pat, rep): n += 1
    out = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
    for it in z.infolist():
        out.writestr(it, etree.tostring(x, xml_declaration=True, encoding="UTF-8", standalone=True) if it.filename == "word/document.xml" else z.read(it.filename))
    out.close(); return n
for src in sys.argv[2:]:
    print(patch(src, os.path.join(sys.argv[1], os.path.basename(src))), os.path.basename(src))
