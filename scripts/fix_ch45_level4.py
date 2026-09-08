"""Set the Chapter 4 & 5 Level 4 headings flush left.

APA's Level 4 indent and trailing period exist because Level 4 is a run-in
heading: the body text continues on the same line. Every Level 4 heading in
these chapters is followed by a figure rather than a sentence, so it has to
stand on its own line -- and an indented, period-terminated heading floating
above a figure reads as a mistake rather than as APA style.

These headings are therefore aligned with the rest of the text block and the
period is removed, restoring the original wording.

Note: the document has been re-saved by Word since it was generated, so the
markup now carries rsid and w14 attributes on every element. Paragraphs are
matched as `<w:p ...>` accordingly.
"""

import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "ASHOK_BHATTARAI_MR_NP069811_NP3F2509IT_CE_IR_Updated.docx"

CH45_START = "DESIGN &amp; IMPLEMENTATION"
CH45_END = "The testing plan demonstrates"

BODY_LEFT = 708
IND = f'<w:ind w:left="{BODY_LEFT}" w:right="61" w:firstLine="0"/>'
PARA = re.compile(r"<w:p[ >].*?</w:p>", re.S)


def main() -> None:
    with zipfile.ZipFile(DOCX) as zin:
        items = zin.infolist()
        blobs = {i.filename: zin.read(i.filename) for i in items}

    xml = blobs["word/document.xml"].decode("utf-8")
    lo = xml.rindex("<w:p ", 0, xml.index(CH45_START))
    hi = xml.index(CH45_END)

    out, cursor, n = [], 0, 0
    for m in PARA.finditer(xml):
        if not (lo <= m.start() < hi):
            continue
        if '<w:pStyle w:val="Heading4"/>' not in m.group():
            continue

        p = m.group()
        if "<w:ind " in p:
            p = re.sub(r"<w:ind [^/]*/>", IND, p, count=1)
        else:
            p = p.replace('<w:pStyle w:val="Heading4"/>', '<w:pStyle w:val="Heading4"/>' + IND, 1)

        # Drop the trailing period from the last run of the heading.
        p = re.sub(r"(<w:t[^>]*>[^<]*?)\.(</w:t>)(?!.*<w:t)", r"\1\2", p, flags=re.S)

        out.append(xml[cursor : m.start()])
        out.append(p)
        cursor = m.end()
        n += 1

    out.append(xml[cursor:])
    print(f"  level 4 headings set flush left: {n}")
    blobs["word/document.xml"] = "".join(out).encode("utf-8")

    tmp = DOCX.with_suffix(".l4.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zi = zipfile.ZipInfo(i.filename, date_time=i.date_time)
            zi.compress_type = i.compress_type
            zi.external_attr = i.external_attr
            zout.writestr(zi, blobs[i.filename])

    with zipfile.ZipFile(tmp) as z:
        assert z.testzip() is None
        import xml.dom.minidom as md

        md.parseString(z.read("word/document.xml"))

    shutil.move(str(tmp), str(DOCX))
    print(f"  written: {DOCX.name}")


if __name__ == "__main__":
    main()
