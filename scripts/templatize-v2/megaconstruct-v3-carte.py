"""MegaConstruct v3: Cartea Tehnică = șablonul v2 + datele PV-urilor („NR. x /data”, „ziua … luna … anul”),
robinetul și diametrele din facturi, „MONTAREA RACORD”. Rulare (din operio-api/scripts/templatize-v2):
  python megaconstruct-v3-carte.py "../../../documente/Bransament/Megaconstruct-v2/1. Carte Tehnica.docx" "../../../documente/Bransament/Megaconstruct-v3/1. Carte Tehnica.docx"
"""
import sys, re, zipfile
sys.path.insert(0, ".")
from runrep import para_replace, q, etree
src, dst = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src); x = etree.fromstring(z.read("word/document.xml"))
# PV-ul curent (după „Nr. {…_nr}”) → data lui.
DATE_OF = {"pv_lucrari_ascunse_nr": "pv_lucrari_ascunse_data", "pv_rt_br_nr": "data_pv_rt", "pv_pif_nr": "data_pif", "pv_rt_srm_nr": "data_pv_rt", "pv_pif_srm_nr": "data_pif"}
cur = None; log = []
ZLA = r"ziua (?:\. ?)+,? ?luna (?:\. ?)+,? ?anul (?:\. ?)+"
for p in x.iter(q("p")):
    full = "".join(t.text or "" for t in p.iter(q("t")))
    m = re.match(r"\s*Nr\. \{(pv_[a-z_]+_nr)\}", full)
    if m and m.group(1) in DATE_OF:
        cur = DATE_OF[m.group(1)]
        if para_replace(p, r"(\{" + m.group(1) + r"\} /)\s*(?:\. ?)+\s*$", r"\1 {" + cur + "}"): log.append(f"Nr {m.group(1)} → / {cur}")
        continue
    if cur and re.search(ZLA, full):
        k = cur
        if para_replace(p, ZLA, f"ziua {{{k}_ziua}}, luna {{{k}_luna}}, anul {{{k}_anul}}"): log.append(f"ziua/luna/anul → {k}")
        continue
    m = re.match(r"\s*PROCES VERBAL NR\. *\{pv_(predare|trasare|sapatura|asternere|montare)_nr\}\s*$", full)
    if m and para_replace(p, r"NR\. *(\{pv_" + m.group(1) + r"_nr\})", r"NR. \1 /{pv_" + m.group(1) + "_data}"):
        log.append(f"titlu PV {m.group(1)}"); continue
    for pat, rep, what in [
        (r"MONTAREA CONDUCTEI PEHD", "MONTAREA RACORD PEHD", "A) racord"),
        (r"(teava PE 100|dop PE100), Dn ?32 ?mm, Dn ?63 ?mm", r"\1, Dn {project_dn} mm", "factura dn"),
        (r"(mufe - PE100), Dn ?32 ?mm", r"\1, Dn {project_dn} mm", "factura mufe"),
        (r"Ø1’’", "Ø{robinet_diametru}", "robinet schema"),
    ]:
        if para_replace(p, pat, rep): log.append(what)
out = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for it in z.infolist():
    out.writestr(it, etree.tostring(x, xml_declaration=True, encoding="UTF-8", standalone=True) if it.filename == "word/document.xml" else z.read(it.filename))
out.close()
print("\n".join(log)); print(len(log), "modificări")
