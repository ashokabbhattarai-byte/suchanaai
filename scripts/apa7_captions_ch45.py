"""Reformat the Chapter 4 & 5 figure and table captions to APA 7 style.

APA 7 (https://apastyle.apa.org/style-grammar-guidelines/tables-figures):

    Figure number  -- bold, flush left, on its own line, above the image
    Figure title   -- italic title case, flush left, one line below the number
    Image          -- below the title
    (same ordering for tables: number, title, then the table body)

The document had figure captions as a single centred bold-italic line *below*
the image ("Figure 26: Wireframe of Login Page") and table captions as a
single bold line above the table. This script splits each caption at the
colon into the two required paragraphs and, for figures, moves them above the
picture. No caption wording is altered.
"""

import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "ASHOK_BHATTARAI_MR_NP069811_NP3F2509IT_CE_IR_Updated.docx"

CH45_START = "DESIGN &amp; IMPLEMENTATION"
CH45_END = "The testing plan demonstrates"

FONT = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>'
IND = 708  # left edge of the body-text block


def para(text: str, *, italic: bool, before: int, after: int, keep_next: bool) -> str:
    emph = "<w:i/>" if italic else "<w:b/>"
    kn = '<w:keepNext w:val="true"/>' if keep_next else ""
    return (
        "<w:p><w:pPr>"
        f'<w:ind w:left="{IND}" w:right="61" w:firstLine="0"/>'
        f'<w:spacing w:before="{before}" w:after="{after}" w:line="276" w:lineRule="auto"/>'
        '<w:jc w:val="left"/>'
        f'{kn}<w:keepLines w:val="true"/><w:widowControl w:val="true"/>'
        "</w:pPr><w:r><w:rPr>"
        f'{FONT}{emph}<w:color w:val="000000"/><w:sz w:val="24"/>'
        f"</w:rPr><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"
    )


def caption_block(number: str, title: str, *, after: int) -> str:
    """The two APA 7 caption paragraphs: bold number, then italic title."""
    return para(number, italic=False, before=240, after=0, keep_next=True) + para(
        title, italic=True, before=0, after=after, keep_next=True
    )


def enclosing_para(xml: str, pos: int) -> tuple[int, int]:
    start = xml.rindex("<w:p>", 0, pos)
    return start, xml.index("</w:p>", pos) + len("</w:p>")


def main() -> None:
    with zipfile.ZipFile(DOCX) as zin:
        items = zin.infolist()
        blobs = {i.filename: zin.read(i.filename) for i in items}

    xml = blobs["word/document.xml"].decode("utf-8")
    lo, hi = xml.index(CH45_START), xml.index(CH45_END)

    # Work back to front so earlier offsets stay valid.
    hits = [
        m
        for m in re.finditer(r"<w:t[^>]*>((Figure|Table) (\d+)): ([^<]+)</w:t>", xml)
        if lo < m.start() < hi
    ]
    figures = tables = 0

    for m in reversed(hits):
        number, kind, title = m.group(1), m.group(2), m.group(4).strip()
        cap_start, cap_end = enclosing_para(xml, m.start())

        if kind == "Table":
            # Caption already sits above the table; just split it in two.
            block = caption_block(number, title, after=60)
            xml = xml[:cap_start] + block + xml[cap_end:]
            tables += 1
            continue

        # Figure: the picture is the paragraph immediately before the caption.
        img_start = xml.rindex("<w:p>", 0, cap_start)
        img = xml[img_start:cap_start]
        assert "<w:drawing>" in img, f"no picture found above {number}"
        # The picture no longer needs to be kept with the paragraph after it.
        img = img.replace('<w:keepNext w:val="true"/>', "", 1)

        block = caption_block(number, title, after=60)
        xml = xml[:img_start] + block + img + xml[cap_end:]
        figures += 1

    print(f"  figures: {figures}, tables: {tables}")
    blobs["word/document.xml"] = xml.encode("utf-8")

    tmp = DOCX.with_suffix(".apa.docx")
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
