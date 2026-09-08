"""Trim the empty white margins from the Chapter 4 & 5 figures.

The wireframe exports in particular were rendered onto a fixed 1800x1400
canvas, so most of them carried several hundred pixels of blank space below
the drawing. Word scaled that whitespace along with the picture, which left a
large gap between each figure and its caption.

For every figure in Chapters 4 and 5 this script:
  * finds the bounding box of the non-white pixels and crops to it, keeping a
    small uniform padding so the content is not flush against the edge;
  * recomputes the on-page extent from the new aspect ratio, keeping the
    figure's current display width and capping the height so a figure plus its
    caption still fits inside the text area.

Only the picture geometry changes; no text is touched.
"""

import io
import re
import shutil
import zipfile
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "ASHOK_BHATTARAI_MR_NP069811_NP3F2509IT_CE_IR_Updated.docx"

# Chapter 4 & 5 figures are word/media/image52.png .. image86.png.
FIRST, LAST = 52, 86
PAD = 10  # px of breathing room kept around the cropped content

EMU_PER_CM = 914400 / 2.54
MAX_H_CM = 20.0
# Figure 38 is the one deliberately full-height page capture.
TALL_FIGURES = {"word/media/image76.png": 25.2}


def autocrop(data: bytes) -> tuple[bytes, tuple[int, int], tuple[int, int]]:
    im = Image.open(io.BytesIO(data))
    flat = Image.new("RGB", im.size, (255, 255, 255))
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        flat.paste(rgba, mask=rgba.split()[3])
    else:
        flat.paste(im.convert("RGB"))

    bbox = ImageChops.difference(flat, Image.new("RGB", flat.size, (255, 255, 255))).getbbox()
    if bbox is None:
        return data, im.size, im.size

    w, h = im.size
    box = (
        max(0, bbox[0] - PAD),
        max(0, bbox[1] - PAD),
        min(w, bbox[2] + PAD),
        min(h, bbox[3] + PAD),
    )
    if box == (0, 0, w, h):
        return data, im.size, im.size

    buf = io.BytesIO()
    flat.crop(box).save(buf, format="PNG", optimize=True)
    return buf.getvalue(), im.size, (box[2] - box[0], box[3] - box[1])


def main() -> None:
    with zipfile.ZipFile(DOCX) as zin:
        items = zin.infolist()
        blobs = {i.filename: zin.read(i.filename) for i in items}

    rels = dict(
        re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', blobs["word/_rels/document.xml.rels"].decode())
    )
    targets = {f"word/media/image{n}.png" for n in range(FIRST, LAST + 1)}

    new_ar: dict[str, float] = {}
    for part in sorted(targets):
        cropped, old, new = autocrop(blobs[part])
        if cropped is not blobs[part]:
            blobs[part] = cropped
        new_ar[part] = new[0] / new[1]
        if old != new:
            print(f"  {part.split('/')[-1]:14} {old[0]}x{old[1]} -> {new[0]}x{new[1]}")

    xml = blobs["word/document.xml"].decode("utf-8")
    out, cursor, resized = [], 0, 0
    for m in re.finditer(r"<w:drawing>.*?</w:drawing>", xml, re.S):
        g = m.group()
        rid = re.search(r'r:embed="([^"]+)"', g)
        ext = re.search(r'<wp:extent cx="(\d+)" cy="(\d+)"/>', g)
        part = "word/" + rels.get(rid.group(1), "") if rid else ""
        if not ext or part not in targets:
            continue

        cur_w = int(ext.group(1)) / EMU_PER_CM
        ar = new_ar[part]
        max_h = TALL_FIGURES.get(part, MAX_H_CM)

        w_cm, h_cm = cur_w, cur_w / ar
        if h_cm > max_h:
            h_cm, w_cm = max_h, max_h * ar
        cx, cy = round(w_cm * EMU_PER_CM), round(h_cm * EMU_PER_CM)

        fixed = re.sub(r'<wp:extent cx="\d+" cy="\d+"/>', f'<wp:extent cx="{cx}" cy="{cy}"/>', g)
        fixed = re.sub(r'<a:ext cx="\d+" cy="\d+"/>', f'<a:ext cx="{cx}" cy="{cy}"/>', fixed)
        out.append(xml[cursor : m.start()])
        out.append(fixed)
        cursor = m.end()
        resized += 1
    out.append(xml[cursor:])
    print(f"  figures re-fitted: {resized}")
    blobs["word/document.xml"] = "".join(out).encode("utf-8")

    tmp = DOCX.with_suffix(".cropped.docx")
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
        for part in sorted(targets):
            Image.open(io.BytesIO(z.read(part))).verify()

    shutil.move(str(tmp), str(DOCX))
    print(f"  written: {DOCX.name}")


if __name__ == "__main__":
    main()
