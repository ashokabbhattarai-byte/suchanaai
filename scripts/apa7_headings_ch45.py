"""Apply APA 7 heading formatting to the Chapter 4 & 5 headings.

APA 7 (https://apastyle.apa.org/style-grammar-guidelines/paper-format/headings):

    Level 1  Centered, Bold, Title Case
    Level 2  Flush Left, Bold, Title Case
    Level 3  Flush Left, Bold Italic, Title Case
    Level 4  Indented, Bold, Title Case, Ending With a Period.
    Level 5  Indented, Bold Italic, Title Case, Ending With a Period.

The document's Heading2 style carries <w:i/>, which Heading3 and Heading4
inherit, so every subheading in the document currently renders bold *italic*
regardless of level. This script writes explicit paragraph and run properties
onto the Chapter 4 & 5 headings only, so Chapters 1-3 are left alone. The
pStyle is kept intact so the outline and any table of contents still work.

Heading wording is not changed apart from the period APA requires on Level 4.
"""

import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "ASHOK_BHATTARAI_MR_NP069811_NP3F2509IT_CE_IR_Updated.docx"

CH45_START = "DESIGN &amp; IMPLEMENTATION"
CH45_END = "The testing plan demonstrates"

BODY_LEFT = 708  # left edge of the body-text block
APA_INDENT = 720  # 0.5 in, the Level 4/5 indent

LEVELS = {
    # style      -> (justification, left indent, italic, trailing period)
    "Heading1": ("center", BODY_LEFT, False, False),
    "Heading2": ("left", BODY_LEFT, False, False),
    "Heading3": ("left", BODY_LEFT, True, False),
    "Heading4": ("left", BODY_LEFT + APA_INDENT, False, True),
}


def main() -> None:
    with zipfile.ZipFile(DOCX) as zin:
        items = zin.infolist()
        blobs = {i.filename: zin.read(i.filename) for i in items}

    xml = blobs["word/document.xml"].decode("utf-8")
    lo = xml.rindex("<w:p>", 0, xml.index(CH45_START))
    hi = xml.index(CH45_END)

    out, cursor, counts = [], 0, {k: 0 for k in LEVELS}
    for m in re.finditer(r"<w:p>.*?</w:p>", xml, re.S):
        if not (lo <= m.start() < hi):
            continue
        style = re.search(r'<w:pStyle w:val="(Heading\d)"/>', m.group())
        if not style or style.group(1) not in LEVELS:
            continue

        level = style.group(1)
        jc, indent, italic, period = LEVELS[level]
        p = m.group()

        # Paragraph properties: explicit alignment and indent, replacing the
        # style's own indent (Heading2 carries a hanging indent).
        p = p.replace(
            f'<w:pStyle w:val="{level}"/>',
            f'<w:pStyle w:val="{level}"/>'
            f'<w:ind w:left="{indent}" w:right="61" w:firstLine="0" w:hanging="0"/>'
            f'<w:jc w:val="{jc}"/>'
            '<w:spacing w:before="240" w:after="0"/>'
            '<w:keepNext w:val="true"/><w:keepLines w:val="true"/>',
            1,
        )

        # Run properties: bold always, italic only on Level 3. The explicit
        # off-switch is required because Heading2 makes its children italic.
        emph = "<w:b/><w:i/>" if italic else '<w:b/><w:i w:val="0"/>'
        p = re.sub(r"<w:b/>(<w:i/>)?", emph, p)

        if period:
            p = re.sub(
                r"(<w:t[^>]*>)([^<]*?)\.?(</w:t>)(?!.*<w:t)",
                lambda g: f"{g.group(1)}{g.group(2)}.{g.group(3)}",
                p,
                flags=re.S,
            )

        out.append(xml[cursor : m.start()])
        out.append(p)
        cursor = m.end()
        counts[level] += 1

    out.append(xml[cursor:])
    print("  " + ", ".join(f"{k}: {v}" for k, v in counts.items()))
    blobs["word/document.xml"] = "".join(out).encode("utf-8")

    tmp = DOCX.with_suffix(".head.docx")
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
