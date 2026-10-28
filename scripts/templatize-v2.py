#!/usr/bin/env python3
"""
Templatize v2 — rebuild a distributor's dossier DOCX templates from the CLIENT
ORIGINALS, keeping their formatting 1:1 and replacing the sample work's values
with docxtemplater placeholders.

  python3 scripts/templatize-v2.py scripts/templatize-v2/distrigaz.json [--only 12,13] [--keep-work]

Requires: lxml, openpyxl (xlsx-built members), LibreOffice `soffice` on PATH
(.doc/.xls → .docx/.xlsx conversion). Paths in the mapping are relative to the
monorepo root (the folder that holds operio-api/).

What it does per member (see the mapping file for the data):
 1. Converts the original (.doc/.DOC → .docx, .xls → .xlsx) into a work dir;
    .docx originals are read as-is. Originals are never written.
 2. Replaces literals at PARAGRAPH level but writes back into the existing
    runs: the placeholder goes into the first run of the matched span (that
    run's rPr, minus red/highlight), only the matched characters are removed
    from the following runs. Tabs, breaks, fields, drawings are barriers — a
    literal never spans them. Runs inside w:hyperlink / w:smartTag / w:fldSimple
    / w:ins / w:sdt are included; text boxes are processed as their own paragraphs.
 3. Removes red from every run (placeholders and fixed labels the client marked
    red only to show they vary) and the client's yellow "variable" highlight.
 4. Letter → A4 (orientation kept), margins ≥ 567 twips; when the A4 text width
    is narrower than the original's, the larger side margins give way first so
    line breaks/tab stops stay where they were; tables that still exceed the
    text width are scaled proportionally.
 5. Serializes with lxml, which keeps the root namespace declarations (incl.
    the ones only referenced by mc:Ignorable — Word refuses files without them).

The mapping file is JSON:
  {
    "sourceDir": "...", "outDir": "...", "workDir": "...",
    "roles": {"constructor": "sef_santier"},          # macros: "{@constructor_nume}" → "{sef_santier_nume}"
    "global": [ <rule>, ... ],                        # applied to every member after its own rules
    "members": [ {"out": "...docx", "src": "...doc", "rules": [...], "ops": [...],
                  "expectedPages": 1, "notes": "..."}, ... ]
  }
  rule = ["literal", "replacement"]                    # all occurrences, any paragraph
       | {"find": "...", "replace": "...", "whole": true,   # whole paragraph text must equal find (after strip)
          "ci": true, "regex": true, "parts": ["header"], "nth": 2, "required": true}
  File rules are `required` by default (a literal that matches nothing is an
  error → typos are caught); global rules are optional.
"""
from __future__ import annotations

import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
V_NS = "urn:schemas-microsoft-com:vml"
NS = {"w": W_NS, "r": R_NS, "mc": MC_NS, "wp": WP_NS, "a": A_NS, "v": V_NS}


def w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
ROOT = Path(__file__).resolve().parents[2]  # monorepo root (…/operio)

A4_W, A4_H = 11906, 16838
MIN_MARGIN = 567  # 10 mm


# ───────────────────────────── colors ─────────────────────────────

def is_red(val: str | None) -> bool:
    if not val:
        return False
    v = val.strip().lower()
    if v in ("red", "ff0000", "c00000", "e00000", "ee0000"):
        return True
    if re.fullmatch(r"[0-9a-f]{6}", v):
        r, g, b = int(v[:2], 16), int(v[2:4], 16), int(v[4:], 16)
        return r > 0xB0 and g < 0x60 and b < 0x60
    return False


def make_auto(c) -> None:
    """Red → automatic color. Set, not removed: a removed run color would reveal the paragraph
    style's color (some Distrigaz styles are blue), which the client never saw."""
    for a in list(c.attrib):
        if a != w("val"):
            del c.attrib[a]
    c.set(w("val"), "auto")


def strip_red(root) -> int:
    """Red w:color → auto everywhere (runs, paragraph marks, styles)."""
    n = 0
    for c in list(root.iter(w("color"))):
        if is_red(c.get(w("val"))):
            make_auto(c)
            n += 1
    return n


def strip_white_paragraph_shading(root) -> int:
    """Paragraphs shaded white (left by a .doc → .docx conversion) paint over the bottom border of
    the table right above them in Word — the table looks open. White on white paper: drop it."""
    n = 0
    for shd in list(root.iter(w("shd"))):
        if shd.getparent().tag == w("pPr") and (shd.get(w("fill")) or "").upper() in ("FFFFFF",) and shd.get(w("val")) in (None, "clear"):
            shd.getparent().remove(shd)
            n += 1
    return n


def relax_condensed_spaces(root) -> int:
    """Whitespace-only runs squeezed with negative character spacing (PDF → Word conversions use
    them to fake line breaks): with other values the line breaks elsewhere and the neighbouring
    words fuse („GIURGIURACORD”). Plain spaces again."""
    n = 0
    for r in root.iter(w("r")):
        t = "".join(x.text or "" for x in r.findall(w("t")))
        if not t or t.strip():
            continue
        sp = r.find(f"{w('rPr')}/{w('spacing')}")
        if sp is not None and int(sp.get(w("val"), "0")) <= -10:
            sp.getparent().remove(sp)
            n += 1
    return n


def strip_yellow_highlight(root) -> int:
    n = 0
    for h in list(root.iter(w("highlight"))):
        if (h.get(w("val")) or "").lower() == "yellow":
            h.getparent().remove(h)
            n += 1
    return n


def clean_run_props(run) -> None:
    rpr = run.find(w("rPr"))
    if rpr is None:
        return
    for c in list(rpr.findall(w("color"))):
        if is_red(c.get(w("val"))):
            make_auto(c)
    for h in list(rpr.findall(w("highlight"))):
        if (h.get(w("val")) or "").lower() != "black":  # black highlight = the form's checkbox squares
            rpr.remove(h)


# ───────────────────────────── paragraph text model ─────────────────────────────

BARRIER = "\x00"


@dataclass
class Atom:
    run: object
    t: object | None  # w:t element, or None for a barrier
    ch: str = ""  # barrier char

    @property
    def text(self) -> str:
        return (self.t.text or "") if self.t is not None else self.ch


SKIP_CONTAINERS = {w("pPr"), w("del"), w("moveFrom"), w("txbxContent"), w("p"), w("tbl")}


def para_atoms(p) -> list[Atom]:
    atoms: list[Atom] = []

    def walk(el):
        for ch in el:
            tag = ch.tag
            if not isinstance(tag, str) or tag in SKIP_CONTAINERS:
                continue
            if tag == w("r"):
                for rc in ch:
                    rt = rc.tag
                    if rt == w("t"):
                        atoms.append(Atom(ch, rc))
                    elif rt == w("rPr"):
                        continue
                    elif rt in (w("tab"), w("ptab")):
                        atoms.append(Atom(ch, None, "\t"))
                    elif rt in (w("br"), w("cr")):
                        atoms.append(Atom(ch, None, "\n"))
                    elif rt in (w("lastRenderedPageBreak"), w("proofErr")):
                        continue
                    else:  # drawing, pict, fldChar, instrText, sym, AlternateContent, …
                        atoms.append(Atom(ch, None, BARRIER))
            else:  # hyperlink, smartTag, fldSimple, ins, sdt/sdtContent, customXml, bookmark*, …
                walk(ch)

    walk(p)
    return atoms


def para_text(p) -> str:
    return "".join(a.text for a in para_atoms(p))


def visible_text(p) -> str:
    return para_text(p).replace(BARRIER, "")


def set_t(t, text: str) -> None:
    t.text = text
    if text != text.strip() or "  " in text:
        t.set(XML_SPACE, "preserve")


def remove_empty_runs(atoms: list[Atom], keep) -> None:
    seen = set()
    for a in atoms:
        r = a.run
        if id(r) in seen or r is keep:
            continue
        seen.add(id(r))
        kids = [k for k in r if k.tag != w("rPr")]
        if kids and all(k.tag == w("t") and not (k.text or "") for k in kids):
            parent = r.getparent()
            if parent is not None:
                parent.remove(r)


def split_run_around(run, piece: str):
    """Split a single-w:t run into before | piece | after runs (same rPr); return the piece run."""
    ts = run.findall(w("t"))
    others = [k for k in run if k.tag not in (w("rPr"), w("t"))]
    if len(ts) != 1 or others or piece not in (ts[0].text or ""):
        return None
    before, after = (ts[0].text or "").split(piece, 1)
    if before:
        r0 = copy.deepcopy(run)
        set_t(r0.find(w("t")), before)
        run.addprevious(r0)
    if after:
        r2 = copy.deepcopy(run)
        set_t(r2.find(w("t")), after)
        run.addnext(r2)
    set_t(ts[0], piece)
    return run


def add_caps_if_safe(run, placeholder_text: str) -> None:
    """The sample value was typed in capitals (e.g. „IVAN FLORIN MADALIN”): render the value the
    same way with w:caps — but only when the rest of the run has no lowercase letters."""
    t = "".join(x.text or "" for x in run.findall(w("t")))
    rest = re.sub(r"\{[^{}]*\}", "", t)
    if any(c.islower() for c in rest):
        run = split_run_around(run, placeholder_text)
        if run is None:
            return
    rpr = run.find(w("rPr"))
    if rpr is None:
        rpr = etree.Element(w("rPr"))
        run.insert(0, rpr)
    if rpr.find(w("caps")) is None:
        caps = etree.Element(w("caps"))
        # CT_RPr order: rStyle, rFonts, b, bCs, i, iCs, caps, …
        pos = 0
        for k, el in enumerate(rpr):
            if el.tag in (w("rStyle"), w("rFonts"), w("b"), w("bCs"), w("i"), w("iCs")):
                pos = k + 1
        rpr.insert(pos, caps)


def run_is_red(run) -> bool:
    rpr = run.find(w("rPr"))
    c = rpr.find(w("color")) if rpr is not None else None
    return c is not None and is_red(c.get(w("val")))


def replace_span(atoms: list[Atom], start: int, end: int, repl: str):
    """Replace characters [start, end) of the paragraph text (no barriers inside)."""
    # The placeholder goes into the run that carried the sample VALUE: the first red run of the
    # span (the client marks values red), else the first run. Labels around it keep their runs.
    pos = 0
    spans = []
    for a in atoms:
        L = len(a.text)
        a_s, a_e = pos, pos + L
        pos = a_e
        if a.t is None or a_e <= start or a_s >= end:
            if a.t is None and a_s < end and a_e > start:
                raise ValueError("span crosses a tab/break/field")
            continue
        spans.append((a, max(start, a_s) - a_s, min(end, a_e) - a_s))
    host = None
    for a, s_, e_ in spans:
        if e_ > s_ and run_is_red(a.run) and a.text[s_:e_].strip():
            host = a
            break
    first = None
    touched = []
    for a, s, e in spans:
        txt = a.text
        if host is None and first is None or a is host:
            first = a
            set_t(a.t, txt[:s] + repl + txt[e:])
        else:
            set_t(a.t, txt[:s] + txt[e:])
        touched.append(a)
    if first is None:
        # zero-length span (pure insertion) at `start`
        pos = 0
        for a in atoms:
            L = len(a.text)
            if a.t is not None and pos <= start <= pos + L:
                off = start - pos
                set_t(a.t, a.text[:off] + repl + a.text[off:])
                first = a
                break
            pos += L
        if first is None:
            raise ValueError("cannot place insertion")
    if repl:
        clean_run_props(first.run)
    remove_empty_runs(touched, keep=first.run if repl else None)
    return first


# ───────────────────────────── rules ─────────────────────────────

@dataclass
class Rule:
    find: str
    replace: str
    whole: bool = False
    ci: bool = False
    regex: bool = False
    parts: list[str] | None = None  # "document" / "header" / "footer"
    nth: int | None = None  # 1-based: only the n-th match in the member
    required: bool = True
    hits: int = 0
    seen: int = 0
    pattern: object = field(default=None, repr=False)

    def compile(self):
        flags = re.IGNORECASE if self.ci else 0
        src = self.find if self.regex else re.escape(self.find)
        if self.whole:
            src = r"^\s*(?:" + src + r")\s*$"
        self.pattern = re.compile(src, flags)
        return self


def expand_macros(s: str, roles: dict) -> str:
    def sub(m):
        name, rest = m.group(1), m.group(2)
        return "{" + roles.get(name, name) + rest + "}"

    return re.sub(r"\{@([a-z]+)(_[a-z_]+)?\}", lambda m: sub(m) if m.group(2) else "{" + roles.get(m.group(1), m.group(1)) + "}", s)


def parse_rule(r, roles, required_default) -> Rule:
    if isinstance(r, list):
        rule = Rule(r[0], expand_macros(r[1], roles), required=required_default)
    else:
        rule = Rule(
            r["find"], expand_macros(r.get("replace", ""), roles), r.get("whole", False), r.get("ci", False),
            r.get("regex", False), r.get("parts"), r.get("nth"), r.get("required", required_default),
        )
    return rule.compile()


def apply_rule_to_paragraph(p, rule: Rule, part_kind: str) -> int:
    if rule.parts and part_kind not in rule.parts:
        return 0
    atoms = para_atoms(p)
    text = "".join(a.text for a in atoms)
    todo = []
    for m in rule.pattern.finditer(text):
        s, e = m.span()
        if rule.whole:
            # keep surrounding whitespace untouched, replace the stripped content
            inner = text[s:e]
            s, e = s + len(inner) - len(inner.lstrip()), e - (len(inner) - len(inner.rstrip()))
        rule.seen += 1
        if rule.nth is not None and rule.seen != rule.nth:
            continue
        if any(c in text[s:e] for c in (BARRIER, "\t", "\n")):
            raise ValueError(f"rule {rule.find!r} spans a tab/break/field in {text!r}")
        # what the sample value looked like (groups copied back by \\1 are not part of the value)
        value = text[s:e]
        if rule.regex:
            for g in set(re.findall(r"\\(\d)", rule.replace)):
                value = value.replace(m.group(int(g)) or "", "", 1)
        repl = m.expand(rule.replace) if rule.regex else rule.replace
        if rule.regex and rule.replace.startswith("\\1") and m.group(1):
            # a kept prefix (e.g. „Punct de lucru ”) stays in its own runs untouched
            s, repl = m.end(1), repl[len(m.group(1)):]
        todo.append((s, e, repl, value))
    # right to left: earlier offsets stay valid while later text changes
    for s, e, repl, matched in reversed(todo):
        first = replace_span(atoms, s, e, repl)
        letters = [c for c in matched if c.isalpha()]
        if "{" in repl and len(letters) >= 3 and all(c.isupper() for c in letters):
            add_caps_if_safe(first.run, repl[repl.index("{"): repl.rindex("}") + 1])
        rule.hits += 1
    return len(todo)


# ───────────────────────────── docx package ─────────────────────────────

class Docx:
    def __init__(self, path: Path):
        self.path = path
        with zipfile.ZipFile(path) as z:
            self.names = z.namelist()
            self.raw = {n: z.read(n) for n in self.names}
        self.xml: dict[str, object] = {}

    def part(self, name: str):
        if name not in self.xml:
            self.xml[name] = etree.fromstring(self.raw[name])
        return self.xml[name]

    def text_parts(self) -> list[tuple[str, str]]:
        out = []
        for n in self.names:
            if n == "word/document.xml":
                out.append((n, "document"))
            elif re.fullmatch(r"word/header\d*\.xml", n):
                out.append((n, "header"))
            elif re.fullmatch(r"word/footer\d*\.xml", n):
                out.append((n, "footer"))
        return out

    def rels(self, part: str):
        d, b = os.path.split(part)
        return f"{d}/_rels/{b}.rels"

    def save(self, out: Path):
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for n in self.names:
                if n in self.xml:
                    data = etree.tostring(self.xml[n], xml_declaration=True, encoding="UTF-8", standalone=True)
                else:
                    data = self.raw[n]
                z.writestr(n, data)
        tmp.replace(out)


# ───────────────────────────── page setup ─────────────────────────────

def twips(v) -> int:
    return int(round(float(v)))


def fix_page(doc: Docx, log: list[str]) -> list[int]:
    """Letter → A4, margins ≥ 10 mm. Returns the text widths (per section)."""
    root = doc.part("word/document.xml")
    widths = []
    for sp in root.iter(w("sectPr")):
        sz = sp.find(w("pgSz"))
        mar = sp.find(w("pgMar"))
        if sz is None or mar is None:
            continue
        pw, ph = twips(sz.get(w("w"))), twips(sz.get(w("h")))
        landscape = pw > ph
        L, R = twips(mar.get(w("left"), mar.get(w("start"), 1440))), twips(mar.get(w("right"), mar.get(w("end"), 1440)))
        old_tw = pw - L - R
        nw, nh = (A4_H, A4_W) if landscape else (A4_W, A4_H)
        if (pw, ph) != (nw, nh):
            log.append(f"page {pw}x{ph} → {nw}x{nh}")
        sz.set(w("w"), str(nw))
        sz.set(w("h"), str(nh))
        if sz.get(w("code")) is not None:
            sz.set(w("code"), "9")
        nL, nR = max(L, MIN_MARGIN), max(R, MIN_MARGIN)
        new_tw = nw - nL - nR
        if new_tw < old_tw:
            # Page got narrower (Letter → A4): give the width back from the RIGHT margin first, so
            # text keeps its distance from the left page edge — floating boxes/check squares
            # anchored to the page then still line up with the text — then from the left.
            need = old_tw - new_tw
            dR = min(need, nR - MIN_MARGIN)
            nR -= dR
            dL = min(need - dR, nL - MIN_MARGIN)
            nL -= dL
            new_tw = nw - nL - nR
        for key, val in (("left", nL), ("right", nR)):
            for k in (key, {"left": "start", "right": "end"}[key]):
                if mar.get(w(k)) is not None:
                    mar.set(w(k), str(val))
            if mar.get(w(key)) is None and mar.get(w({"left": "start", "right": "end"}[key])) is None:
                mar.set(w(key), str(val))
        has_header = sp.find(w("headerReference")) is not None
        header_dist = twips(mar.get(w("header"), 720))
        for key in ("top", "bottom"):
            v = twips(mar.get(w(key), 1440))
            # A page with a header (logo band) sitting ≥ 10 mm from the edge: the body starts below
            # the header whatever the top margin says — keep the client's value.
            if key == "top" and has_header and header_dist >= MIN_MARGIN and v >= 0:
                continue
            if abs(v) < MIN_MARGIN:
                mar.set(w(key), str(MIN_MARGIN if v >= 0 else -MIN_MARGIN))
        # header/footer distances are left as the client set them: the Distrigaz letterhead
        # (logo + footer picture) is designed around them and moving it pushes the body down.
        if (L, R) != (nL, nR):
            log.append(f"margins L/R {L}/{R} → {nL}/{nR} (text width {old_tw} → {new_tw})")
        widths.append((nw, nL, nR))
    return widths


def table_width(tbl) -> int:
    grid = tbl.find(w("tblGrid"))
    if grid is None:
        return 0
    return sum(twips(g.get(w("w"), 0)) for g in grid.findall(w("gridCol")))


def scale_tables(doc: Docx, sections: list, log: list[str]) -> None:
    """Shrink top-level tables whose right edge would come closer than 10 mm to the A4 page edge.

    Tables that overhang the text area but still keep ≥ 10 mm to the paper edge are left as the
    client drew them (many Distrigaz forms do that on purpose)."""
    root = doc.part("word/document.xml")
    body = root.find(w("body"))
    # Each top-level table belongs to the section that ends after it (a paragraph's sectPr ends a
    # section; the body's sectPr is the last one) — sections can have different margins.
    sec = 0
    owner = {}
    for el in body:
        if el.tag == w("tbl"):
            owner[el] = min(sec, len(sections) - 1)
        elif el.tag == w("p") and el.find(f"{w('pPr')}/{w('sectPr')}") is not None:
            sec += 1
    for tbl in body.iter(w("tbl")):
        if tbl.getparent().tag != w("body"):
            continue  # nested tables scale with their cell
        page_w, left_margin, right_margin = sections[owner.get(tbl, len(sections) - 1)]
        limit = page_w - MIN_MARGIN
        tw = table_width(tbl)
        if not tw:
            continue
        tpr = tbl.find(w("tblPr"))
        ind = 0
        if tpr is not None and tpr.find(w("tblInd")) is not None and tpr.find(w("tblInd")).get(w("type"), "dxa") == "dxa":
            ind = twips(tpr.find(w("tblInd")).get(w("w"), 0))
        # Word draws the left border one cell margin left of tblInd (default 108 twips).
        cm = tpr.find(f"{w('tblCellMar')}/{w('left')}") if tpr is not None else None
        if cm is None and tpr is not None:
            cm = tpr.find(f"{w('tblCellMar')}/{w('start')}")
        cell_left = twips(cm.get(w("w"), 108)) if cm is not None else 108
        left = left_margin + ind - cell_left
        fp = tpr.find(w("tblpPr")) if tpr is not None else None
        if fp is not None:  # floating table: horizontal position from its own anchor
            spec, x = fp.get(w("tblpXSpec")), twips(fp.get(w("tblpX"), 0))
            area = (0, page_w) if fp.get(w("horzAnchor")) == "page" else (left_margin, page_w - right_margin)
            if spec == "center":
                left = area[0] + ((area[1] - area[0]) - tw) // 2
            elif spec == "right":
                left = area[1] - tw
            else:
                left = area[0] + x
        if left + tw <= limit + 20 and left >= MIN_MARGIN - 20:
            continue
        if fp is None and left < MIN_MARGIN - 20:  # table pulled into the left margin: keep 10 mm
            el = child_in_order(tpr, "tblInd", TBLPR_ORDER)
            el.set(w("type"), "dxa")
            el.set(w("w"), str(ind + MIN_MARGIN - left))
            log.append(f"table indent {ind} → {ind + MIN_MARGIN - left} (left edge {left} → {MIN_MARGIN})")
            left = MIN_MARGIN
        if fp is None and left + tw > limit + 20 and left > MIN_MARGIN:
            # first slide it left into the free margin (keeps every column width)
            shift = min(left + tw - limit, left - MIN_MARGIN)
            el = child_in_order(tpr, "tblInd", TBLPR_ORDER)
            el.set(w("type"), "dxa")
            el.set(w("w"), str(ind - shift))
            log.append(f"table indent {ind} → {ind - shift} (slid left, right edge {left + tw} → {left + tw - shift})")
            left -= shift
            if left + tw <= limit + 20:
                continue
        f = (limit - max(left, MIN_MARGIN)) / tw if fp is None or fp.get(w("tblpXSpec")) != "center" else (page_w - 2 * MIN_MARGIN) / tw
        f = min(f, 1.0)
        if f >= 0.999:
            continue
        if f < 0.98 and tpr is not None:
            # narrower columns: take the room from the cell padding first so short labels
            # („Nr. crt.”, „poanson”) don't start wrapping
            set_cell_padding(tpr, 45)
            log.append("table cell padding left/right → 45 twips")
        for el in tbl.iter():
            if el.tag == w("gridCol"):
                el.set(w("w"), str(int(twips(el.get(w("w"))) * f)))
            elif el.tag in (w("tcW"), w("tblW")) and el.get(w("type"), "dxa") == "dxa":
                el.set(w("w"), str(int(twips(el.get(w("w"), 0)) * f)))
        log.append(f"table {tw} at x={left} scaled ×{f:.3f} (right edge {left + tw} → {limit})")


TBLPR_ORDER = ["tblStyle", "tblpPr", "tblOverlap", "bidiVisual", "tblStyleRowBandSize", "tblStyleColBandSize", "tblW",
               "jc", "tblCellSpacing", "tblInd", "tblBorders", "shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption",
               "tblDescription", "tblPrChange"]
PPR_ORDER = ["pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr",
             "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap",
             "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid",
             "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection",
             "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"]
CELLMAR_ORDER = ["top", "start", "left", "bottom", "end", "right"]
TCPR_ORDER = ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders", "shd", "noWrap", "tcMar", "textDirection",
              "tcFitText", "vAlign", "hideMark", "headers", "cellIns", "cellDel", "cellMerge", "tcPrChange"]


def child_in_order(parent, tag: str, order: list[str]):
    """Get or create parent/w:tag at its schema position (Word rejects out-of-order children)."""
    el = parent.find(w(tag))
    if el is not None:
        return el
    el = etree.Element(w(tag))
    idx = order.index(tag)
    pos = 0
    for i, k in enumerate(parent):
        name = k.tag.split("}")[1] if isinstance(k.tag, str) and "}" in k.tag else ""
        if name in order and order.index(name) < idx:
            pos = i + 1
    parent.insert(pos, el)
    return el


def set_cell_padding(tpr, lr: int) -> None:
    """Table default left/right cell padding; keeps the start/end vs left/right naming in use."""
    mar = child_in_order(tpr, "tblCellMar", TBLPR_ORDER)
    names = ("start", "end") if (mar.find(w("start")) is not None or mar.find(w("end")) is not None) else ("left", "right")
    for side in names:
        el = child_in_order(mar, side, CELLMAR_ORDER)
        el.set(w("w"), str(lr))
        el.set(w("type"), "dxa")


# ───────────────────────────── ops ─────────────────────────────

def body_paragraphs(doc: Docx):
    return list(doc.part("word/document.xml").iter(w("p")))


def find_para(doc: Docx, text: str, part="word/document.xml", whole=True, nth=1):
    root = doc.part(part)
    k = 0
    for p in root.iter(w("p")):
        t = visible_text(p).strip()
        if (t == text.strip()) if whole else (text in t):
            k += 1
            if k == nth:
                return p
    raise KeyError(f"paragraph not found: {text!r} in {part}")


def op_collapse(doc: Docx, op, log):
    """Keep the first paragraph (its first run's formatting), set its text, delete up to `last`."""
    first = find_para(doc, op["first"], whole=op.get("whole", True))
    last = find_para(doc, op["last"], whole=op.get("whole", True))
    parent = first.getparent()
    sibs = list(parent)
    i, j = sibs.index(first), sibs.index(last)
    assert j >= i
    for el in sibs[i + 1 : j + 1]:
        parent.remove(el)
    atoms = para_atoms(first)
    text = "".join(a.text for a in atoms)
    replace_span(atoms, 0, len(text), op["text"])
    log.append(f"collapsed {j - i + 1} paragraphs into {op['text']!r}")


def op_delete_paragraph(doc: Docx, op, log):
    part = op.get("part", "word/document.xml")
    p = find_para(doc, op["text"], part=part, whole=op.get("whole", True), nth=op.get("nth", 1))
    p.getparent().remove(p)
    log.append(f"deleted paragraph {op['text']!r}")


def op_page_break_before(doc: Docx, op, log):
    """Start each listed part of a multi-document file on a new page. The client's file has no breaks:
    every form began on a new page only because the previous one filled a Letter page — on the taller
    A4 page the forms would run into each other. Targets: {"match": text, "whole"?, "nth"?} → the
    paragraph gets pageBreakBefore; {"table": n} → a 1 pt paragraph with pageBreakBefore goes before it."""
    root = doc.part("word/document.xml")
    tables = list(root.iter(w("tbl")))

    def drop_spacers_before(el):
        # empty paragraphs between the previous form and the new page would spill onto a page of their own
        prev = el.getprevious()
        while prev is not None and prev.tag == w("p") and not visible_text(prev).strip() \
                and prev.find(f".//{w('sectPr')}") is None and prev.find(f".//{w('drawing')}") is None \
                and prev.find(f".//{w('pict')}") is None and prev.find(f".//{w('br')}") is None:
            nxt = prev.getprevious()
            prev.getparent().remove(prev)
            prev = nxt

    for t in op["targets"]:
        if "table" in t:
            tbl = tables[t["table"] - 1]
            p = etree.Element(w("p"))
            ppr = etree.SubElement(p, w("pPr"))
            etree.SubElement(ppr, w("pageBreakBefore"))
            sp = etree.SubElement(ppr, w("spacing"))
            for k, v in (("before", "0"), ("after", "0"), ("line", "20"), ("lineRule", "exact")):
                sp.set(w(k), v)
            drop_spacers_before(tbl)
            tbl.addprevious(p)
            log.append(f"page break before table {t['table']}")
        else:
            p = find_para(doc, t["match"], whole=t.get("whole", True), nth=t.get("nth", 1))
            if p.getparent().tag == w("body"):
                drop_spacers_before(p)
            ppr = p.find(w("pPr"))
            if ppr is None:
                ppr = etree.Element(w("pPr"))
                p.insert(0, ppr)
            child_in_order(ppr, "pageBreakBefore", PPR_ORDER)
            log.append(f"page break before {t['match']!r}")


def op_unfloat_table(doc: Docx, op, log):
    """Turn a floating table (w:tblpPr) into a normal one, like its siblings — a floating header table
    after a new page break pulls the following paragraph up beside it."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    pr = tbl.find(w("tblPr"))
    fl = pr.find(w("tblpPr")) if pr is not None else None
    if fl is not None:
        pr.remove(fl)
    ov = pr.find(w("tblOverlap")) if pr is not None else None
    if ov is not None:
        pr.remove(ov)
    log.append(f"table {op['table']} no longer floating")


def op_unwrap_hyperlinks(doc: Docx, op, log):
    parts = [n for n, _ in doc.text_parts()] if op.get("part") is None else [op["part"]]
    for n in parts:
        root = doc.part(n)
        for h in list(root.iter(w("hyperlink"))):
            parent = h.getparent()
            idx = parent.index(h)
            for k in list(h):
                parent.insert(idx, k)
                idx += 1
            parent.remove(h)
            for r in parent.iter(w("r")):
                rpr = r.find(w("rPr"))
                if rpr is not None:
                    st = rpr.find(w("rStyle"))
                    if st is not None and st.get(w("val"), "").lower().startswith("hyperlink"):
                        rpr.remove(st)
                    for c in rpr.findall(w("color")):
                        if c.get(w("val")) == "0000FF":
                            rpr.remove(c)
                    for u in rpr.findall(w("u")):
                        rpr.remove(u)
            log.append(f"unwrapped hyperlink in {n}")


def op_image_placeholder(doc: Docx, op, log):
    """Replace the n-th drawing/VML picture in a part with an inline `{%tag}` run.

    framePr (optional) turns the paragraph into a positioned frame so the inline
    image the generator produces floats where the original picture was."""
    part = op.get("part", "word/document.xml")
    root = doc.part(part)
    pics = [r for r in root.iter(w("r")) if r.find(w("drawing")) is not None or r.find(w("pict")) is not None
            or r.find(f"{{{MC_NS}}}AlternateContent") is not None]
    nth = op.get("nth", 1)
    run = pics[nth - 1]
    for k in list(run):
        if k.tag != w("rPr"):
            run.remove(k)
    p = run
    while p.tag != w("p"):
        p = p.getparent()
    if op.get("framePr"):
        # The picture floated next to the text; the generator's image is inline. Put the tag in a
        # new *framed* paragraph (positioned like the old picture, out of the text flow) and keep
        # the original paragraph as an empty line so everything below stays where it was.
        newp = etree.Element(w("p"))
        ppr0 = p.find(w("pPr"))
        if ppr0 is not None:
            newp.append(copy.deepcopy(ppr0))
        newrun = copy.deepcopy(run)
        newp.append(newrun)
        p.remove(run)
        p.addprevious(newp)
        p, run = newp, newrun
    t = etree.SubElement(run, w("t"))
    t.text = "{%" + op["tag"] + "}"
    if op.get("framePr"):
        ppr = p.find(w("pPr"))
        if ppr is None:
            ppr = etree.Element(w("pPr"))
            p.insert(0, ppr)
        fp = etree.Element(w("framePr"))
        for k, v in op["framePr"].items():
            fp.set(w(k), str(v))
        # framePr sits after pStyle/keepNext/keepLines/pageBreakBefore in CT_PPr order
        after = [w("pStyle"), w("keepNext"), w("keepLines"), w("pageBreakBefore")]
        pos = 0
        for i, k in enumerate(ppr):
            if k.tag in after:
                pos = i + 1
        ppr.insert(pos, fp)
    if op.get("jc"):
        ppr = p.find(w("pPr"))
        jc = ppr.find(w("jc")) if ppr is not None else None
        if jc is None and ppr is not None:
            jc = etree.SubElement(ppr, w("jc"))
        jc.set(w("val"), op["jc"])
    # drop the paragraph's other drawings when asked (sample sketch made of several shapes)
    log.append(f"picture #{nth} in {part} → {{%{op['tag']}}}")


def op_remove_drawings(doc: Docx, op, log):
    """Remove every drawing/VML/AlternateContent run in the given paragraphs range or whole body after `after`."""
    root = doc.part(op.get("part", "word/document.xml"))
    n = 0
    for r in list(root.iter(w("r"))):
        if r.find(w("drawing")) is not None or r.find(w("pict")) is not None or r.find(f"{{{MC_NS}}}AlternateContent") is not None:
            txt = "".join(x.text or "" for x in r.iter(w("t")))
            if op.get("keepIfText") and txt.strip():
                continue
            r.getparent().remove(r)
            n += 1
    log.append(f"removed {n} drawing runs")


def op_tab_signature(doc: Docx, op, log):
    """Replace leading spaces of the given paragraphs with one tab and set a tab stop."""
    for text in op["paragraphs"]:
        p = find_para(doc, text, whole=False)
        atoms = para_atoms(p)
        full = "".join(a.text for a in atoms)
        lead = len(full) - len(full.lstrip(" "))
        # remove leading spaces then insert a tab run before the first text run
        if lead:
            replace_span(atoms, 0, lead, "")
        atoms = para_atoms(p)
        first = next(a for a in atoms if a.t is not None and a.text)
        tab_run = etree.Element(w("r"))
        rpr = first.run.find(w("rPr"))
        if rpr is not None:
            tab_run.append(copy.deepcopy(rpr))
        etree.SubElement(tab_run, w("tab"))
        first.run.addprevious(tab_run)
        ppr = p.find(w("pPr"))
        if ppr is None:
            ppr = etree.Element(w("pPr"))
            p.insert(0, ppr)
        tabs = ppr.find(w("tabs"))
        if tabs is None:
            tabs = etree.Element(w("tabs"))
            # CT_PPr order: pStyle, keepNext, keepLines, pageBreakBefore, framePr, widowControl, numPr,
            # suppressLineNumbers, pBdr, shd, tabs, …
            before = {w(t) for t in ("pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl",
                                     "numPr", "suppressLineNumbers", "pBdr", "shd")}
            pos = 0
            for i, k in enumerate(ppr):
                if k.tag in before:
                    pos = i + 1
            ppr.insert(pos, tabs)
        for k in list(tabs):
            tabs.remove(k)
        tab = etree.SubElement(tabs, w("tab"))
        tab.set(w("val"), op.get("align", "right"))
        tab.set(w("pos"), str(op["pos"]))
    log.append(f"signature block on a {op.get('align', 'right')} tab at {op['pos']}")


def op_row_borders(doc: Docx, op, log):
    """Single borders all round on every cell of the given rows (1-based) — for a repeated block
    whose cells inherited the client's patchwork of nil/single borders around one sample value."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    rows = tbl.findall(w("tr"))
    for i in op["rows"]:
        for tc in rows[i - 1].findall(w("tc")):
            pr = tc.find(w("tcPr"))
            if pr is None:
                pr = etree.Element(w("tcPr"))
                tc.insert(0, pr)
            b = child_in_order(pr, "tcBorders", TCPR_ORDER)
            for k in list(b):
                b.remove(k)
            for side in ("top", "left", "bottom", "right"):
                e = etree.SubElement(b, w(side))
                e.set(w("val"), "single")
                e.set(w("sz"), str(op.get("sz", 4)))
                e.set(w("space"), "0")
                e.set(w("color"), "auto")
    log.append(f"uniform borders on table {op['table']} rows {op['rows']}")


def op_table_float_y(doc: Docx, op, log):
    """Move a floating table down (tblpY, twips from its anchor) — e.g. to leave room above it for
    the generated sketch, which is larger than the client's picture."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    fp = tbl.find(f"{w('tblPr')}/{w('tblpPr')}")
    old = fp.get(w("tblpY"))
    fp.set(w("tblpY"), str(op["y"]))
    log.append(f"floating table {op['table']} tblpY {old} → {op['y']}")


def op_columns_line(doc: Docx, op, log):
    """A signature line whose names were lined up under their roles with spaces (fits only the
    sample names): rewrite it as `cells` separated by tabs, on centered tab stops at `positions`
    (twips from the left margin), keeping the first run's formatting. Use it on the role line and
    on the names line with the same positions."""
    p = find_para(doc, op["match"], whole=op.get("whole", False), nth=op.get("nth", 1))
    runs = [r for r in p.iter(w("r")) if r.find(w("t")) is not None]
    keep = runs[0]
    for r in list(p.iter(w("r"))):
        if r is not keep:
            r.getparent().remove(r)
    for k in list(keep):
        if k.tag != w("rPr"):
            keep.remove(k)
    rpr = keep.find(w("rPr"))
    for i, text in enumerate(op["cells"]):
        tab = etree.SubElement(keep, w("tab"))
        t = etree.SubElement(keep, w("t"))
        t.text = text
        t.set(XML_SPACE, "preserve")
    if rpr is not None:
        clean_run_props(keep)
    ppr = p.find(w("pPr"))
    if ppr is None:
        ppr = etree.Element(w("pPr"))
        p.insert(0, ppr)
    for tag in ("tabs", "ind", "jc"):
        el = ppr.find(w(tag))
        if el is not None:
            ppr.remove(el)
    tabs = child_in_order(ppr, "tabs", PPR_ORDER)
    for pos in op["positions"]:
        t = etree.SubElement(tabs, w("tab"))
        t.set(w("val"), "center")
        t.set(w("pos"), str(pos))
    log.append(f"columns line {op['cells']} on centered tabs {op['positions']}")


def op_table_row_loop(doc: Docx, op, log):
    """Turn a table row into a docxtemplater row loop: cells[i] ← texts[i] (first paragraph of each
    cell keeps its first run's formatting; other paragraphs of the cell are emptied)."""
    root = doc.part("word/document.xml")
    tbls = list(root.iter(w("tbl")))
    tbl = tbls[op["table"] - 1]
    rows = tbl.findall(w("tr"))
    tr = rows[op["row"] - 1]
    cells = tr.findall(w("tc"))
    texts = op["cells"]
    assert len(cells) == len(texts), f"row has {len(cells)} cells, mapping gives {len(texts)}"
    # a cell's text goes into its first paragraph that has text in the client's row (the others —
    # spacers around the sample value — are removed, so the repeated row isn't taller than one line)
    for tc, txt in zip(cells, texts):
        ps = tc.findall(w("p"))
        keep = next((p for p in ps if visible_text(p).strip()), ps[0])
        put_paragraph_text(keep, txt)
        for p in ps:
            if p is not keep:
                tc.remove(p)
    for target, source in op.get("formatFrom", []):  # 1-based cells: copy paragraph + run formatting
        src_p = cells[source - 1].find(w("p"))
        dst_p = cells[target - 1].find(w("p"))
        for tag in ("pPr",):
            old = dst_p.find(w(tag))
            if old is not None:
                dst_p.remove(old)
            if src_p.find(w(tag)) is not None:
                dst_p.insert(0, copy.deepcopy(src_p.find(w(tag))))
        src_r = src_p.find(f"{w('r')}/{w('rPr')}")
        for r in dst_p.findall(w("r")):
            old = r.find(w("rPr"))
            if old is not None:
                r.remove(old)
            if src_r is not None:
                r.insert(0, copy.deepcopy(src_r))
    # The repeated row must close the table: when the original last row goes, its bottom
    # border moves to the loop row (cells that only drew a top border would leave the
    # last repetition open).
    if len(rows) in op.get("deleteRows", []):
        last_cells = rows[-1].findall(w("tc"))
        for i, tc in enumerate(cells):
            src = last_cells[min(i, len(last_cells) - 1)].find(f"{w('tcPr')}/{w('tcBorders')}/{w('bottom')}") if last_cells else None
            if src is None:
                continue
            tcpr = tc.find(w("tcPr"))
            if tcpr is None:
                tcpr = etree.Element(w("tcPr"))
                tc.insert(0, tcpr)
            borders = child_in_order(tcpr, "tcBorders", TCPR_ORDER)
            old_b = borders.find(w("bottom"))
            if old_b is not None:
                borders.remove(old_b)
            # CT_TcBorders order: top, start/left, bottom, end/right, insideH, insideV, tl2br, tr2bl
            after = [k for k in borders if k.tag in (w("top"), w("start"), w("left"))]
            borders.insert(len(after), copy.deepcopy(src))
        log.append(f"loop row in table {op['table']} takes the bottom border of the deleted last row")
    for idx in op.get("deleteRows", []):
        rows[idx - 1].getparent().remove(rows[idx - 1])
    log.append(f"row loop in table {op['table']} row {op['row']}: {' | '.join(texts)}")


def put_paragraph_text(p, text: str, rpr_from=None) -> None:
    """Set a paragraph's whole text (drops tabs/breaks too) keeping its first run's formatting."""
    runs = [r for r in p.iter(w("r"))]
    keep = None
    for r in runs:
        if r.find(w("t")) is not None:
            keep = r
            break
    if keep is None:
        keep = etree.SubElement(p, w("r"))
        ppr = p.find(w("pPr"))
        mark = ppr.find(w("rPr")) if ppr is not None else None
        if mark is not None:
            keep.append(copy.deepcopy(mark))
            keep[0].tag = w("rPr")
    for r in runs:
        if r is not keep and r.find(w("drawing")) is None and r.find(w("pict")) is None:
            r.getparent().remove(r)
    for k in list(keep):
        if k.tag != w("rPr"):
            keep.remove(k)
    if text:
        t = etree.SubElement(keep, w("t"))
        set_t(t, text)
        clean_run_props(keep)
    else:
        if len(keep) == 0 or all(k.tag == w("rPr") for k in keep):
            keep.getparent().remove(keep)


def op_set_cell(doc: Docx, op, log):
    root = doc.part("word/document.xml")
    tbl = list(root.iter(w("tbl")))[op["table"] - 1]
    tr = tbl.findall(w("tr"))[op["row"] - 1]
    tc = tr.findall(w("tc"))[op["cell"] - 1]
    ps = tc.findall(w("p"))
    put_paragraph_text(ps[0], op["text"])
    for p in ps[1:]:
        put_paragraph_text(p, "")
    log.append(f"cell t{op['table']} r{op['row']} c{op['cell']} ← {op['text']!r}")


def op_set_paragraph(doc: Docx, op, log):
    p = find_para(doc, op["match"], part=op.get("part", "word/document.xml"), whole=op.get("whole", True),
                  nth=op.get("nth", 1))
    put_paragraph_text(p, op["text"])
    log.append(f"paragraph {op['match']!r} ← {op['text']!r}")


def cell_at_grid(tr, col: int):
    """The w:tc of a row that covers grid column `col` (0-based)."""
    g = 0
    for tc in tr.findall(w("tc")):
        pr = tc.find(w("tcPr"))
        span = int(pr.find(w("gridSpan")).get(w("val"))) if pr is not None and pr.find(w("gridSpan")) is not None else 1
        if g <= col < g + span:
            return tc
        g += span
    raise IndexError(f"no cell at grid column {col}")


def op_vmerge(doc: Docx, op, log):
    """Merge one column's cells over rows [first, last] (1-based) so a value that used to be split
    over several rows (one welder authorization per row) flows in one tall cell."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    rows = tbl.findall(w("tr"))
    first, last = op["rows"]
    for i in range(first, last + 1):
        tc = cell_at_grid(rows[i - 1], op["col"])
        pr = tc.find(w("tcPr"))
        if pr is None:
            pr = etree.Element(w("tcPr"))
            tc.insert(0, pr)
        for old in pr.findall(w("vMerge")):
            pr.remove(old)
        vm = etree.Element(w("vMerge"))
        if i == first:
            vm.set(w("val"), "restart")
        # CT_TcPr order: cnfStyle, tcW, gridSpan, hMerge, vMerge, tcBorders, …
        pos = 0
        for k, el in enumerate(pr):
            if el.tag in (w("cnfStyle"), w("tcW"), w("gridSpan"), w("hMerge")):
                pos = k + 1
        pr.insert(pos, vm)
        if i != first:
            ps = tc.findall(w("p"))
            for p in ps[1:]:
                tc.remove(p)
            put_paragraph_text(ps[0], "")
        if op.get("vAlign"):
            child_in_order(pr, "vAlign", TCPR_ORDER).set(w("val"), op["vAlign"])
    log.append(f"merged grid column {op['col']} over rows {first}–{last}")


def op_break_before(doc: Docx, op, log):
    """Insert a line break before each word of `before` in the paragraph containing `match` — for
    boxes whose lines only broke because the sample values happened to wrap there."""
    p = find_para(doc, op["match"], part=op.get("part", "word/document.xml"), whole=False)
    for word in op["before"]:
        atoms = para_atoms(p)
        text = "".join(a.text for a in atoms)
        idx = text.index(word)
        pos = 0
        for a in atoms:
            L = len(a.text)
            if a.t is not None and pos <= idx < pos + L:
                off = idx - pos
                run = a.run
                if off:
                    head = copy.deepcopy(run)
                    for k in list(head):
                        if k.tag not in (w("rPr"),) and k is not None and k.tag != w("t"):
                            head.remove(k)
                    set_t(head.find(w("t")), a.text[:off].rstrip(" ") + " ")
                    set_t(a.t, a.text[off:])
                    run.addprevious(head)
                br = etree.Element(w("r"))
                rpr = run.find(w("rPr"))
                if rpr is not None:
                    br.append(copy.deepcopy(rpr))
                etree.SubElement(br, w("br"))
                run.addprevious(br)
                break
            pos += L
    log.append(f"line breaks before {op['before']}")


def op_set_ind(doc: Docx, op, log):
    p = find_para(doc, op["match"], part=op.get("part", "word/document.xml"), whole=False)
    ppr = p.find(w("pPr"))
    ind = ppr.find(w("ind"))
    for k, v in op["ind"].items():
        ind.set(w(k), str(v))
    log.append(f"indent of {op['match']!r} → {op['ind']}")


def op_drop_grid_col(doc: Docx, op, log):
    """Remove an empty, borderless grid column (e.g. a spacer the client left at the right edge
    that only pushed the table off an A4 page)."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    col = op["col"]
    grid = tbl.find(w("tblGrid"))
    gc = grid.findall(w("gridCol"))
    width = twips(gc[col].get(w("w")))
    for tr in tbl.findall(w("tr")):
        try:
            tc = cell_at_grid(tr, col)
        except IndexError:
            continue  # the row stops before this column
        pr = tc.find(w("tcPr"))
        span_el = pr.find(w("gridSpan")) if pr is not None else None
        if span_el is None or int(span_el.get(w("val"))) == 1:
            if "".join(x.text or "" for x in tc.iter(w("t"))).strip():
                raise ValueError(f"grid column {col} is not empty")
            tr.remove(tc)
        else:
            n = int(span_el.get(w("val"))) - 1
            if n == 1:
                pr.remove(span_el)
            else:
                span_el.set(w("val"), str(n))
            tcw = pr.find(w("tcW"))
            if tcw is not None and tcw.get(w("type"), "dxa") == "dxa":
                tcw.set(w("w"), str(twips(tcw.get(w("w"))) - width))
    grid.remove(gc[col])
    tpr = tbl.find(w("tblPr"))
    tw = tpr.find(w("tblW")) if tpr is not None else None
    if tw is not None and tw.get(w("type"), "dxa") == "dxa":
        tw.set(w("w"), str(twips(tw.get(w("w"))) - width))
    log.append(f"dropped empty grid column {col} ({width} twips) of table {op['table']}")


def op_cell_padding(doc: Docx, op, log):
    """Set a table's default left/right cell padding (twips) — for LibreOffice's .doc→.docx
    conversion artefacts where a tight column label („Ziua”) starts wrapping."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    tpr = tbl.find(w("tblPr"))
    set_cell_padding(tpr, op["lr"])
    log.append(f"table {op['table']} cell padding left/right → {op['lr']} twips")


def op_shrink_trailing_empty(doc: Docx, op, log):
    """Make the empty paragraphs at the very end of the body 1 pt tall (invisible either way):
    the room lets a longer weld list or a two-line value stay on the page."""
    body = doc.part("word/document.xml").find(w("body"))
    kids = [k for k in body if k.tag != w("sectPr")]
    n = 0
    for p in reversed(kids):
        if p.tag != w("p") or visible_text(p).strip() or p.find(f".//{w('drawing')}") is not None \
                or p.find(f".//{w('pict')}") is not None or p.find(f".//{w('sectPr')}") is not None:
            break
        ppr = p.find(w("pPr"))
        if ppr is None:
            ppr = etree.Element(w("pPr"))
            p.insert(0, ppr)
        sp = child_in_order(ppr, "spacing", PPR_ORDER)
        for k in list(sp.attrib):
            del sp.attrib[k]
        sp.set(w("before"), "0")
        sp.set(w("after"), "0")
        sp.set(w("line"), "20")
        sp.set(w("lineRule"), "exact")
        n += 1
    log.append(f"{n} trailing empty paragraphs → 1 pt")


def op_drop_trailing_empty_rows(doc: Docx, op, log):
    """Remove the text-less rows at the bottom of a table (the client's invisible spacer rows under
    the signature block) so an extra welder block still fits on the page."""
    tbl = list(doc.part("word/document.xml").iter(w("tbl")))[op["table"] - 1]
    rows = tbl.findall(w("tr"))
    n = 0
    for tr in reversed(rows):
        if n >= op.get("max", 99) or "".join(x.text or "" for x in tr.iter(w("t"))).strip() \
                or tr.find(f".//{w('drawing')}") is not None:
            break
        tbl.remove(tr)
        n += 1
    log.append(f"dropped {n} empty rows at the bottom of table {op['table']}")


def op_python(doc: Docx, op, log, member, ctx):
    fn = HOOKS[op["hook"]]
    fn(doc, op, log, member, ctx)


OPS = {
    "collapse": op_collapse,
    "delete_paragraph": op_delete_paragraph,
    "unwrap_hyperlinks": op_unwrap_hyperlinks,
    "page_break_before": op_page_break_before,
    "unfloat_table": op_unfloat_table,
    "columns_line": op_columns_line,
    "table_float_y": op_table_float_y,
    "row_borders": op_row_borders,
    "image_placeholder": op_image_placeholder,
    "remove_drawings": op_remove_drawings,
    "tab_signature": op_tab_signature,
    "table_row_loop": op_table_row_loop,
    "set_cell": op_set_cell,
    "set_paragraph": op_set_paragraph,
    "vmerge": op_vmerge,
    "drop_trailing_empty_rows": op_drop_trailing_empty_rows,
    "shrink_trailing_empty": op_shrink_trailing_empty,
    "cell_padding": op_cell_padding,
    "drop_grid_col": op_drop_grid_col,
    "break_before": op_break_before,
    "set_ind": op_set_ind,
}

HOOKS: dict = {}


def hook(name):
    def deco(fn):
        HOOKS[name] = fn
        return fn

    return deco


# ───────────────────────────── xlsx → docx (FD-691 style inspection tables) ─────────────────────────────

@hook("xlsx_table_document")
def build_from_xlsx(doc_unused, op, log, member, ctx):
    """Implemented in templatize_v2_xlsx.py (kept separate: it writes a whole package)."""
    raise RuntimeError("handled by build_member")


# ───────────────────────────── conversion ─────────────────────────────

def soffice_convert(src: Path, fmt: str, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    target = outdir / (src.stem + "." + fmt)
    if target.exists() and target.stat().st_mtime >= src.stat().st_mtime:
        return target
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            ["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", fmt,
             "--outdir", str(outdir), str(src)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    if not target.exists():
        raise RuntimeError(f"soffice did not produce {target}")
    return target


def source_docx(src: Path, work: Path) -> Path:
    ext = src.suffix.lower()
    if ext == ".docx":
        return src
    if ext in (".doc", ".rtf", ".odt"):
        return soffice_convert(src, "docx", work)
    if ext in (".xls", ".xlsx"):
        return soffice_convert(src, "xlsx", work) if ext == ".xls" else src
    raise ValueError(f"unsupported source {src}")


# ───────────────────────────── member build ─────────────────────────────

def build_member(member: dict, cfg: dict, global_rules: list, roles: dict, work: Path, out_dir: Path) -> dict:
    src = ROOT / cfg["sourceDir"] / member["src"]
    out = out_dir / member["out"]
    log: list[str] = []
    converted = source_docx(src, work)
    if converted.suffix == ".xlsx":
        sys.path.insert(0, str(Path(__file__).parent))
        from templatize_v2_xlsx import build_xlsx_member  # noqa: E402

        build_xlsx_member(converted, out, member, roles, log)
        return {"out": member["out"], "log": log}

    doc = Docx(converted)
    rules = [parse_rule(r, roles, True) for r in member.get("rules", [])]
    grules = [parse_rule(r, roles, False) for r in global_rules]

    # ops that must run before text rules (structure changes)
    for op in member.get("preOps", []):
        OPS[op["op"]](doc, op, log)

    for name, kind in doc.text_parts():
        root = doc.part(name)
        paras = list(root.iter(w("p")))
        for rule in rules + grules:
            for p in paras:
                apply_rule_to_paragraph(p, rule, kind)

    for op in member.get("ops", []):
        if op["op"] == "python":
            op_python(doc, op, log, member, {"roles": roles})
        else:
            OPS[op["op"]](doc, op, log)

    missing = [r.find for r in rules if r.required and r.hits == 0]
    if missing:
        raise RuntimeError(f"{member['out']}: rules matched nothing: {missing}")
    for r in rules:
        log.append(f"rule {r.find!r} → {r.replace!r} ×{r.hits}")
    for r in grules:
        if r.hits:
            log.append(f"global {r.find!r} → {r.replace!r} ×{r.hits}")

    reds = 0
    for name, _ in doc.text_parts():
        reds += strip_red(doc.part(name))
        shd = strip_white_paragraph_shading(doc.part(name))
        cond = relax_condensed_spaces(doc.part(name))
        if shd or cond:
            log.append(f"{name}: white paragraph shading removed ×{shd}, condensed spaces relaxed ×{cond}")
        if not member.get("keepYellow"):
            strip_yellow_highlight(doc.part(name))
    if "word/styles.xml" in doc.names:
        reds += strip_red(doc.part("word/styles.xml"))
    log.append(f"red color removed from {reds} elements")

    sections = fix_page(doc, log)
    for k, v in member.get("pageOverride", {}).items():  # documented per-member fit tweaks
        for mar in doc.part("word/document.xml").iter(w("pgMar")):
            log.append(f"pgMar {k} {mar.get(w(k))} → {v} (override)")
            mar.set(w(k), str(v))
    if sections and not member.get("noTableScale"):
        scale_tables(doc, sections, log)

    doc.save(out)
    return {"out": member["out"], "log": log}


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    cfg_path = Path(argv[1])
    cfg = json.loads(cfg_path.read_text())
    only = None
    if "--only" in argv:
        only = set(argv[argv.index("--only") + 1].split(","))
    roles = cfg.get("roles", {})
    out_dir = ROOT / cfg["outDir"]
    work = ROOT / cfg.get("workDir", cfg["outDir"] + "/_src")
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    ok = True
    for i, member in enumerate(cfg["members"]):
        key = member.get("id", str(i))
        if only and key not in only:
            continue
        try:
            res = build_member(member, cfg, cfg.get("global", []), roles, work, out_dir)
            results.append(res)
            print(f"✓ {member['out']}")
            for line in res["log"]:
                print("   ", line)
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f"✗ {member['out']}: {e}")
    (out_dir / "_check").mkdir(exist_ok=True)
    (out_dir / "_check" / "build-log.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
