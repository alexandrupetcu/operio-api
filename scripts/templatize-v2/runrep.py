"""Înlocuiri de text în paragrafe DOCX care trec peste granițele run-urilor, păstrând formatarea
run-ului în care începe potrivirea."""
import re, zipfile
from lxml import etree
W="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
q=lambda t:"{%s}%s"%(W,t)
def para_replace(p, pattern, repl, count=1):
    ts=[t for t in p.iter(q("t"))]
    full="".join(t.text or "" for t in ts)
    m=re.search(pattern, full)
    if not m: return 0
    new=m.expand(repl) if isinstance(repl,str) else repl(m)
    a,b=m.start(),m.end(); pos=0; placed=False
    for t in ts:
        s=t.text or ""; s0,s1=pos,pos+len(s); pos=s1
        if s1<=a or s0>=b: continue
        lo,hi=max(a,s0)-s0,min(b,s1)-s0
        if not placed:
            t.text=s[:lo]+new+s[hi:]; placed=True
        else:
            t.text=s[:lo]+s[hi:]
        t.set("{http://www.w3.org/XML/1998/namespace}space","preserve")
    return 1
def patch_docx(src,dst,rules):
    z=zipfile.ZipFile(src); x=etree.fromstring(z.read("word/document.xml"))
    hits={i:0 for i in range(len(rules))}
    for p in x.iter(q("p")):
        for i,(pat,rep,ctx) in enumerate(rules):
            full="".join(t.text or "" for t in p.iter(q("t")))
            if ctx and not re.search(ctx, full): continue
            hits[i]+=para_replace(p,pat,rep)
    out=zipfile.ZipFile(dst,"w",zipfile.ZIP_DEFLATED)
    for it in z.infolist():
        out.writestr(it, etree.tostring(x,xml_declaration=True,encoding="UTF-8",standalone=True) if it.filename=="word/document.xml" else z.read(it.filename))
    out.close(); return hits
