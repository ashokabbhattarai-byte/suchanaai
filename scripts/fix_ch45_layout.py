"""Layout-only fixes for Chapter 4 & 5 of the Investigation Report.

Three fixes, no text content is touched:
  1. Section properties for the Ch4/5 section are made identical to the rest
     of the document (page size, header/footer and all four margins).
  2. Figure 38 (the full-height homepage screenshot) is scaled down so the
     image plus its caption fit inside the text area instead of bleeding off
     the bottom edge of the page.
  3. Ch4/5 tables are re-laid out to match the tables in Chapters 1-3:
     indented 708 twips from the left margin with a total width of 9059
     twips, so they align with the body text block instead of running out
     to both page edges.
"""

import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "ASHOK_BHATTARAI_MR_NP069811_NP3F2509IT_CE_IR_Updated.docx"

# Page setup used by every other chapter in the document.
STANDARD_SECT = (
    '<w:sectPr><w:pgSz w:w="11910" w:h="16840"/>'
    '<w:pgMar w:header="713" w:footer="0" w:top="960" w:bottom="280"'
    ' w:left="708" w:right="1417"/></w:sectPr>'
)
# The odd python-docx default section that opens Chapter 4.
CH45_OPEN_SECT = (
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"'
    ' w:header="708" w:footer="708" w:gutter="0"/>'
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>'
)
# The section that closes Chapter 5.
CH45_CLOSE_SECT = (
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
    '<w:pgMar w:top="960" w:right="1417" w:bottom="280" w:left="708"'
    ' w:header="708" w:footer="708" w:gutter="0"/>'
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>'
)

# Table geometry copied from the Chapter 1-3 tables.
TABLE_IND = 708
TABLE_WIDTH = 9059

# Figure 38: 2880x19810 px. Fit height so image + caption clear the page.
FIG38_NAME = "01_homepage.png"
FIG38_CY = 9072000  # 25.2 cm in EMU
FIG38_CX = round(FIG38_CY * 2880 / 19810)


def fix_sections(xml: str) -> str:
    assert xml.count(CH45_OPEN_SECT) == 1, "Ch4 opening section not found"
    assert xml.count(CH45_CLOSE_SECT) == 1, "Ch5 closing section not found"
    xml = xml.replace(CH45_OPEN_SECT, STANDARD_SECT)
    return xml.replace(CH45_CLOSE_SECT, STANDARD_SECT)


def fix_figure38(xml: str) -> str:
    """Shrink the one drawing whose blip points at 01_homepage.png."""
    drawings = list(re.finditer(r"<w:drawing>.*?</w:drawing>", xml, re.S))
    hits = [m for m in drawings if FIG38_NAME in m.group()]
    assert len(hits) == 1, f"expected 1 {FIG38_NAME} drawing, got {len(hits)}"
    m = hits[0]
    fixed = re.sub(
        r'<wp:extent cx="\d+" cy="\d+"/>',
        f'<wp:extent cx="{FIG38_CX}" cy="{FIG38_CY}"/>',
        m.group(),
    )
    fixed = re.sub(
        r'<a:ext cx="\d+" cy="\d+"/>',
        f'<a:ext cx="{FIG38_CX}" cy="{FIG38_CY}"/>',
        fixed,
    )
    return xml[: m.start()] + fixed + xml[m.end() :]


def fix_tables(xml: str, start: int, end: int) -> str:
    """Re-indent and re-scale every table between `start` and `end`."""
    region = xml[start:end]
    depth = max_depth = 0
    for tok in re.findall(r"<w:tbl>|</w:tbl>", region):
        depth += 1 if tok == "<w:tbl>" else -1
        max_depth = max(max_depth, depth)
    assert depth == 0 and max_depth == 1, "nested tables are not handled"
    out = []
    cursor = 0
    count = 0
    for m in re.finditer(r"<w:tbl>.*?</w:tbl>", region, re.S):
        tbl = m.group()
        cols = [int(c) for c in re.findall(r'<w:gridCol w:w="(\d+)"/>', tbl)]
        if not cols:
            out.append(region[cursor : m.end()])
            cursor = m.end()
            continue

        # Scale the grid to the body-text width, keeping column proportions
        # and making the widths sum exactly to TABLE_WIDTH.
        total = sum(cols)
        scaled, run = [], 0
        for i, c in enumerate(cols):
            if i == len(cols) - 1:
                scaled.append(TABLE_WIDTH - run)
            else:
                w = round(c * TABLE_WIDTH / total)
                scaled.append(w)
                run += w
        remap = dict(zip(cols, scaled))

        tbl = re.sub(
            r'<w:tblW w:w="5000" w:type="pct"/>',
            f'<w:tblW w:w="0" w:type="auto"/>'
            f'<w:tblInd w:w="{TABLE_IND}" w:type="dxa"/>',
            tbl,
        )
        tbl = tbl.replace('<w:jc w:val="center"/></w:tblPr>', "</w:tblPr>")
        tbl = re.sub(
            r'<w:gridCol w:w="(\d+)"/>',
            lambda g: f'<w:gridCol w:w="{remap[int(g.group(1))]}"/>',
            tbl,
        )
        tbl = re.sub(
            r'<w:tcW w:type="dxa" w:w="(\d+)"/>',
            lambda g: f'<w:tcW w:type="dxa" w:w="{remap[int(g.group(1))]}"/>',
            tbl,
        )
        out.append(region[cursor : m.start()])
        out.append(tbl)
        cursor = m.end()
        count += 1
    out.append(region[cursor:])
    print(f"  tables re-laid out: {count}")
    return xml[:start] + "".join(out) + xml[end:]


def main() -> None:
    with zipfile.ZipFile(DOCX) as zin:
        items = zin.infolist()
        blobs = {i.filename: zin.read(i.filename) for i in items}

    xml = blobs["word/document.xml"].decode("utf-8")

    # Chapter 4 & 5 span from the opening section break to the closing one.
    start = xml.index(CH45_OPEN_SECT)
    end = xml.index(CH45_CLOSE_SECT) + len(CH45_CLOSE_SECT)

    xml = fix_tables(xml, start, end)
    xml = fix_figure38(xml)
    xml = fix_sections(xml)

    blobs["word/document.xml"] = xml.encode("utf-8")

    tmp = DOCX.with_suffix(".fixed.docx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for i in items:
            zi = zipfile.ZipInfo(i.filename, date_time=i.date_time)
            zi.compress_type = i.compress_type
            zi.external_attr = i.external_attr
            zout.writestr(zi, blobs[i.filename])

    # Sanity check: the rewritten package must still open cleanly.
    with zipfile.ZipFile(tmp) as z:
        assert z.testzip() is None
        import xml.dom.minidom as md

        md.parseString(z.read("word/document.xml"))

    shutil.move(str(tmp), str(DOCX))
    print(f"  written: {DOCX.name}")


if __name__ == "__main__":
    main()
