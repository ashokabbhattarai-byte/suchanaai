"""Document text extraction: several extractors race, the best result wins.

Pipeline for a PDF:
1. Produce candidate texts — pypdf, then poppler's `pdftotext -layout`.
2. Score each candidate for linguistic plausibility (`_text_quality`).
3. If the best candidate is weak (scanned page, or a legacy Nepali font whose
   glyphs decode to Latin noise), OCR the rendered pages.
4. OCR language is chosen by *measuring*: page one is OCR'd with each available
   language set and the highest-scoring one is used for the whole document.
5. The highest-scoring candidate overall is returned, with its score and method.

Scoring rather than a single yes/no gate is what makes this reliable: a legacy
Preeti PDF extracts as confident-looking ASCII ("BXXYRCO ; WREVERE G.4q.959"),
which no structural check can distinguish from real text — but it contains
almost no real words in any language, so it scores near zero and loses to OCR.
"""

import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from app import config
from app.logger import get_logger

logger = get_logger(__name__)

_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")
_TESSERACT_AVAILABLE: bool | None = None
_TESSERACT_LANGS_CACHE: dict[str, list[str]] | None = None

# extract_text() runs in a worker thread (asyncio.to_thread) — from document
# uploads and from scraping's per-notice PDF extraction alike — so this must
# be a threading.Semaphore, not an asyncio one, to actually serialize access
# across those threads. See config.OCR_MAX_CONCURRENCY.
_OCR_SEMAPHORE = threading.Semaphore(config.OCR_MAX_CONCURRENCY)


def _check_tesseract() -> bool:
    """Check if Tesseract OCR is available on this system."""
    global _TESSERACT_AVAILABLE
    if _TESSERACT_AVAILABLE is None:
        _TESSERACT_AVAILABLE = shutil.which("tesseract") is not None
        if _TESSERACT_AVAILABLE:
            logger.info("Tesseract OCR available")
        else:
            logger.warning(
                "Tesseract OCR not found — install with: brew install tesseract tesseract-lang"
            )
    return _TESSERACT_AVAILABLE


_TESSERACT_LANGS_CACHE_TIME: float | None = None
_TESSERACT_LANGS_TTL_SECONDS = 300

def _get_tesseract_langs() -> list[str]:
    """Get list of available Tesseract languages on the system (cached 5m)."""
    global _TESSERACT_LANGS_CACHE, _TESSERACT_LANGS_CACHE_TIME
    import time
    now = time.time()
    if _TESSERACT_LANGS_CACHE is not None and _TESSERACT_LANGS_CACHE_TIME is not None:
        if now - _TESSERACT_LANGS_CACHE_TIME < _TESSERACT_LANGS_TTL_SECONDS:
            return _TESSERACT_LANGS_CACHE

    try:
        result = subprocess.run(
            ["tesseract", "--list-langs"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            # First line is header, rest are language codes
            lines = result.stdout.strip().split("\n")
            if len(lines) > 1:
                _TESSERACT_LANGS_CACHE = lines[1:]
                _TESSERACT_LANGS_CACHE_TIME = now
                return _TESSERACT_LANGS_CACHE
    except Exception as e:
        logger.warning("Failed to list Tesseract languages: %s", e)

    _TESSERACT_LANGS_CACHE = []
    _TESSERACT_LANGS_CACHE_TIME = now
    return _TESSERACT_LANGS_CACHE





# Function words that saturate any real English document. Legacy-font noise and
# wrong-language OCR essentially never produce them.
_EN_STOPWORDS = {
    "the", "of", "and", "to", "in", "for", "is", "on", "by", "with", "as", "at",
    "from", "this", "that", "shall", "be", "will", "has", "have", "are", "was",
    "were", "it", "its", "or", "an", "a", "not", "all", "may", "must", "which",
    "their", "there", "been", "such", "under", "within", "after", "before",
    "date", "notice", "office", "ministry", "government", "nepal", "department",
}
_WORD_RE = re.compile(r"[A-Za-z]{2,}")
_LATIN_ALPHA_RE = re.compile(r"[A-Za-z]")
_MIN_TOKENS_FOR_SCORE = 25

# Below this, a candidate is treated as unusable and OCR is attempted.
QUALITY_THRESHOLD = 0.55


def is_readable_text(text: str, threshold: float = QUALITY_THRESHOLD) -> bool:
    """Public wrapper for callers outside this module deciding whether stored
    text is safe to hand to an LLM/user (e.g. main.py excluding a garbled
    legacy-font extraction from a Q&A prompt).

    _text_quality() alone isn't strict enough here: its "too little running
    text to judge" branch deliberately gives short/sparse pages (forms,
    tables) the benefit of the doubt so they aren't needlessly OCR'd — but
    that same leniency lets pure symbol noise ("O:12(3.5A" style legacy-font
    garbage, which is short on real words but not actually sparse) through
    as "readable". A caller *displaying this to a human* needs a stricter
    bar, so Latin-dominant text must also be mostly letters.

    That letter-ratio test is deliberately NOT applied to Devanagari-dominant
    text: real Nepali reports are full of tables, Devanagari digits and
    punctuation, so a genuine 190-page progress report can sit at ~35%
    letters and would be wrongly rejected. Devanagari presence is itself
    strong evidence of real extracted text, which _text_quality already
    scores on directly.
    """
    if _text_quality(text) < threshold:
        return False

    sample = text[:2000]
    non_space = [c for c in sample if not c.isspace()]
    if len(non_space) < 20:
        return True  # too short for the letter-ratio check to mean anything

    devanagari = sum(1 for c in non_space if "ऀ" <= c <= "ॿ")
    if devanagari / len(non_space) >= 0.15:
        return True  # real Nepali script — tables/digits shouldn't disqualify it

    letters = sum(1 for c in non_space if c.isalpha())
    return (letters / len(non_space)) >= 0.5


def _text_quality(text: str) -> float:
    """Rate extracted text 0.0 (noise) → 1.0 (clean) for linguistic plausibility.

    Devanagari content scores on script share alone. Latin-dominant content is
    scored on how often real English function words appear: genuine prose runs
    20-35%, whereas legacy-font garbage and Devanagari-OCR'd-as-English sit near
    zero even though both look superficially like words.
    """
    if not text or len(text.strip()) < 40:
        return 0.0

    sample = text[:8000]
    non_space = re.sub(r"\s", "", sample)
    if not non_space:
        return 0.0

    devanagari_ratio = len(_DEVANAGARI_RE.findall(non_space)) / len(non_space)
    if devanagari_ratio >= 0.15:
        # Real Devanagari: the more of it, the better. Nepali notices routinely
        # mix in Latin digits/abbreviations, so this saturates early.
        score = min(1.0, 0.65 + devanagari_ratio)

        # In a document that is overwhelmingly Devanagari, stray Latin letters
        # are almost always OCR mis-reads — the English model winning on a
        # damaged glyph and turning "ने.सं." into "Aa:". Penalising them lets a
        # clean nep-only pass outrank a noisier nep+eng one. The 0.6 floor
        # keeps genuinely bilingual notices out of it.
        if devanagari_ratio >= 0.6:
            latin_ratio = len(_LATIN_ALPHA_RE.findall(non_space)) / len(non_space)
            score -= min(0.5, latin_ratio * 3.0)

        return max(0.0, score)

    tokens = [t.lower() for t in _WORD_RE.findall(sample)]
    if len(tokens) < _MIN_TOKENS_FOR_SCORE:
        # Too little running text to judge (forms, tables, mostly-numeric pages).
        # Neutral-but-passing so we don't OCR a perfectly good sparse page.
        return 0.6

    stopword_ratio = sum(1 for t in tokens if t in _EN_STOPWORDS) / len(tokens)
    # 12% stopwords ⇒ full marks; real prose clears this comfortably.
    score = min(1.0, stopword_ratio / 0.12)

    # Some PDFs' glyph/kerning tables make pypdf insert a space mid-word
    # ("P eople sta ying abr oad"), which shatters real words into short
    # fragments that still coincidentally hit the stopword list ("or", "at",
    # "as", "an") — that alone reaches the 12% stopword mark just as easily as
    # clean prose, so this and the stopword check are deliberately separate
    # signals. Genuine English naturally carries a fair share of 2-letter
    # words ("to", "of", "in", "is" are all stopwords), so the threshold sits
    # above that baseline rather than at zero: this fired at a 27% short-token
    # ratio on real corrupted output and stayed clear of a clean same-document
    # extraction sitting at 15%.
    short_tokens = sum(1 for t in tokens if len(t) <= 2)
    short_ratio = short_tokens / len(tokens)
    if short_ratio > 0.20:
        score -= min(0.6, (short_ratio - 0.20) * 3.0)

    # A little Devanagari present but below the threshold above still counts for
    # something — mixed-script documents shouldn't be judged on English alone.
    return max(0.0, max(score, min(0.6, devanagari_ratio * 4)))


def _scrub_latin_fragments(line: str) -> str:
    """Remove short non-word Latin tokens from a Devanagari line.

    Length 5 is the cut-off: it catches the debris seen in production ("Se",
    "eh", "eS", "aa", "Ste", "Bay", "fafa") while leaving real words like
    "Website", "Ministry" or "COVID" intact.
    """
    def replace(match: re.Match) -> str:
        token = match.group(0)
        if len(token) > 5 or token.lower() in _EN_STOPWORDS:
            return token
        # Acronyms are real content: COVID, WHO, PCR, SMS, IT.
        if token.isupper() and len(token) >= 2:
            return token
        # Attached to a number ("COVID-19", "Ward-5", "3M") — real content.
        start, end = match.span()
        before = match.string[max(0, start - 1) : start]
        after = match.string[end : end + 1]
        # NB: `"" in "-/"` is True, so the emptiness checks are load-bearing —
        # without them every token at a line boundary was treated as attached.
        if (before and (before in "-/" or before.isdigit())) or (
            after and (after in "-/" or after.isdigit())
        ):
            return token
        return ""

    cleaned = _WORD_RE.sub(replace, line)
    # Collapse the gaps and any punctuation left stranded by the removal.
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip(" |") if cleaned.strip(" |") else line


def _strip_ocr_noise(text: str) -> str:
    """Drop lines that are pure OCR debris from a Nepali scan.

    Stamps, seals, signatures and letterhead graphics make Tesseract emit short
    Latin fragments on their own lines ("Se eh eS", "arene", "Ste"). Only lines
    that have *no* Devanagari, *no* digits, no URL/email, and consist solely of
    short non-word Latin tokens are removed — so addresses, reference numbers
    and any real English sentence survive.
    """
    if len(_DEVANAGARI_RE.findall(text)) < 40:
        return text  # not a Devanagari document; leave it alone

    kept: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            kept.append(line)
            continue

        has_link = "@" in stripped or "http" in stripped.lower() or "www." in stripped.lower()

        if _DEVANAGARI_RE.search(stripped):
            # A Devanagari line: keep it, but scrub the short Latin fragments
            # OCR sprinkles in from stamps and seals ("… बोर्ड, aa |").
            kept.append(line if has_link else _scrub_latin_fragments(line))
            continue

        if any(ch.isdigit() for ch in stripped) or has_link:
            kept.append(line)
            continue

        tokens = _WORD_RE.findall(stripped)
        letters = _LATIN_ALPHA_RE.findall(stripped)
        if not letters:
            kept.append(line)  # punctuation-only separator lines
            continue

        # Junk = every Latin token is short and not a recognisable word.
        junk = all(len(t) <= 5 and t.lower() not in _EN_STOPWORDS for t in tokens)
        if tokens and junk:
            logger.debug("Dropping OCR noise line: %r", stripped[:60])
            continue
        kept.append(line)

    return "\n".join(kept)


_ZERO_WIDTH_RE = re.compile("[\u200B-\u200F\uFEFF]")


def _normalize_text(text: str) -> str:
    """Light normalization: fix common OCR artifacts and normalize whitespace."""
    text = text.replace("\x0c", "\n\n")
    # Zero-width space/ZWNJ/ZWJ/LRM/RLM + BOM — glyph-shaping artifacts from
    # legacy Devanagari PDF fonts that read as literal invisible characters
    # once extracted, breaking words apart visually (e.g. "सङ्‍घीय" showing
    # as "सङ्‍ घीय").
    text = _ZERO_WIDTH_RE.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_DEDUPE_MIN_LEN = 24


def _dedupe_paragraphs(text: str) -> str:
    """Drop paragraphs that are exact repeats of an earlier one.

    Multi-column government notices (letterhead/footer spanning the full page
    width, alongside two text columns) routinely make `pdftotext -layout` — and
    occasionally pypdf — re-emit the same boilerplate block once per column
    band it crosses ("Office of the Prime Minister and Council of Minister"
    showing up three times in a row is this, not a rendering bug downstream).
    Neither extractor does true reading-order reconstruction, so the fix is
    applied here rather than trying to out-guess column layout.

    Paragraph-level (not line-level) and exact-match only, so legitimately
    repeated short lines (a bullet, a bank name appearing in both a table and
    prose) survive — only accidental re-emission of a whole identical block
    is removed. Short paragraphs are left alone entirely: below
    `_DEDUPE_MIN_LEN` chars, a repeat is far more likely to be a real
    coincidence (a lone "2026" on its own line) than a rendering artifact.
    """
    paragraphs = text.split("\n\n")
    seen: set[str] = set()
    kept: list[str] = []
    for para in paragraphs:
        key = re.sub(r"\s+", " ", para).strip()
        if len(key) >= _DEDUPE_MIN_LEN and key in seen:
            logger.debug("Dropping duplicate paragraph: %r", key[:60])
            continue
        if len(key) >= _DEDUPE_MIN_LEN:
            seen.add(key)
        kept.append(para)
    return "\n\n".join(kept)


def _extract_tables(path: Path) -> list[str]:
    """Pull bordered/ruled tables out of a PDF as GFM markdown tables.

    A separate pass from the main text extraction (pdfplumber's table
    detection is geometry-based — ruled lines and cell alignment — which
    `pypdf`/`pdftotext`'s plain text streams throw away entirely). Tables are
    appended after the main text rather than spliced inline: precisely
    reproducing a table's position within a linear text stream isn't reliable
    across extractors, whereas appending them intact, clearly, is.
    """
    try:
        import pdfplumber
    except ImportError:
        return []

    tables_md: list[str] = []
    try:
        with pdfplumber.open(str(path)) as pdf:
            for page_num, page in enumerate(pdf.pages, start=1):
                try:
                    raw_tables = page.extract_tables()
                except Exception as e:
                    logger.debug("Table extraction failed on page %d: %s", page_num, e)
                    continue
                for table in raw_tables:
                    # Skip 1x1 "tables" — pdfplumber's ruled-line detector
                    # occasionally flags a bordered callout box as a table.
                    if len(table) < 2 or len(table[0]) < 2:
                        continue
                    rows = [[(cell or "").strip().replace("\n", " ") for cell in row] for row in table]
                    header, body = rows[0], rows[1:]
                    md = ["| " + " | ".join(header) + " |", "| " + " | ".join(["---"] * len(header)) + " |"]
                    md.extend("| " + " | ".join(row) + " |" for row in body)
                    tables_md.append(f"Table (page {page_num}):\n" + "\n".join(md))
    except Exception as e:
        logger.warning("Table extraction failed for %s: %s", path.name, e)
        return []

    return tables_md


# Hard cap so a pathological PDF (hundreds of small graphics that superficially
# resemble QR modules) can't turn a notice extraction into a long CPU-bound scan.
_MAX_QR_CODES = 20
_QR_RENDER_DPI = 200


def _extract_qr_codes(path: Path) -> list[dict]:
    """Detect and decode QR codes rendered on the page (payment QRs, links).

    Renders each page to an image (the same pdf2image path OCR uses, just at
    a lower DPI — QR detection needs the modules legible, not OCR-grade text)
    and runs OpenCV's built-in QR detector, which ships as pure pip wheels
    with no system `libzbar` dependency to install alongside poppler/tesseract.
    Each hit is returned as its decoded payload plus a cropped PNG of the code
    itself (small — typically a few KB — so it travels inline as base64
    rather than needing a separate storage round-trip).
    """
    try:
        import cv2
        import numpy as np
        from pdf2image import convert_from_path
    except ImportError:
        return []

    detector = cv2.QRCodeDetector()
    results: list[dict] = []

    # Batch render to avoid OOM on large PDFs (500-page doc at 200 DPI ~5 GiB if all resident)
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(path))
        total_pages = len(reader.pages)
    except Exception:
        total_pages = 200  # fallback cap
    total_pages = min(total_pages, 200)  # hard cap for QR scan
    batch_size = 5
    all_images: list = []
    for start in range(1, total_pages + 1, batch_size):
        end = min(start + batch_size - 1, total_pages)
        try:
            batch = convert_from_path(str(path), dpi=_QR_RENDER_DPI, first_page=start, last_page=end)
            all_images.extend(batch)
        except Exception as e:
            logger.debug("QR scan: could not render pages %d-%d of %s: %s", start, end, path.name, e)
            continue
        if len(results) >= _MAX_QR_CODES:
            break

    for page_num, pil_img in enumerate(all_images, start=1):
        if len(results) >= _MAX_QR_CODES:
            break
        try:
            arr = cv2.cvtColor(np.array(pil_img.convert("RGB")), cv2.COLOR_RGB2BGR)
            ok, decoded_info, points, _ = detector.detectAndDecodeMulti(arr)
        except Exception as e:
            logger.debug("QR scan failed on page %d of %s: %s", page_num, path.name, e)
            continue
        if not ok:
            continue

        for i, data in enumerate(decoded_info):
            if not data or len(results) >= _MAX_QR_CODES:
                continue
            try:
                import base64

                quad = points[i]
                xs, ys = quad[:, 0], quad[:, 1]
                pad = 10
                x0, x1 = max(0, int(xs.min()) - pad), min(arr.shape[1], int(xs.max()) + pad)
                y0, y1 = max(0, int(ys.min()) - pad), min(arr.shape[0], int(ys.max()) + pad)
                crop = arr[y0:y1, x0:x1]
                ok_enc, buf = cv2.imencode(".png", crop)
                image_b64 = base64.b64encode(buf.tobytes()).decode("ascii") if ok_enc else None
            except Exception as e:
                logger.debug("QR crop/encode failed on page %d: %s", page_num, e)
                image_b64 = None

            results.append({"page": page_num, "data": data, "image_base64": image_b64})

    if results:
        logger.info("Detected %d QR code(s) in %s", len(results), path.name)
    return results


def extract_text(file_path: str, mime_type: str, on_progress=None) -> dict:
    """Extract text from a document file.

    Returns dict with keys: text, is_ocr, page_count

    on_progress(done_pages, total_pages) is called during OCR, which is the
    slowest stage on a scanned PDF — without it the progress bar sits frozen
    for the whole run. Optional: every non-OCR path returns too fast to need it.
    """
    path = Path(file_path)
    logger.info("Extracting text from %s (mime=%s)", path.name, mime_type)

    if mime_type == "application/pdf":
        result = _extract_pdf(path, on_progress=on_progress)
    elif mime_type in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    ):
        result = _extract_docx(path)
    elif mime_type.startswith("image/"):
        result = _extract_image(path)
    else:
        result = _extract_text_file(path)

    result["text"] = _normalize_text(result["text"])
    if result.get("is_ocr"):
        result["text"] = _normalize_text(_strip_ocr_noise(result["text"]))
    result["text"] = _dedupe_paragraphs(result["text"])
    result.setdefault("method", "native")
    result.setdefault("quality", round(_text_quality(result["text"]), 3))
    result.setdefault("tables", [])
    result.setdefault("qr_codes", [])

    logger.info(
        "Extracted %d chars from %s (method=%s, ocr=%s, pages=%d, quality=%.2f)",
        len(result["text"]),
        path.name,
        result["method"],
        result["is_ocr"],
        result["page_count"],
        result["quality"],
    )
    if result["quality"] < QUALITY_THRESHOLD and result["text"].strip():
        logger.warning(
            "Low-quality extraction for %s (quality=%.2f, method=%s) — "
            "text may be unusable; consider re-running with OCR available",
            path.name,
            result["quality"],
            result["method"],
        )
    return result


def _pypdf_text(path: Path) -> tuple[str, int]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = [(page.extract_text() or "") for page in reader.pages]
    return "\n\n".join(pages), len(pages)


def _pdftotext(path: Path) -> str:
    """poppler's extractor. Often recovers text pypdf mangles (and vice versa),
    so both are scored and the better one wins. Ships with poppler-utils, which
    pdf2image already requires."""
    if not shutil.which("pdftotext"):
        return ""
    try:
        # 90 s to cover a 100 MB / ~500-page poster bundle at -layout; the
        # previous 60 s was tight and could abort a valid large-file extraction
        # back to the lower-quality pypdf text for no reason.
        result = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
            capture_output=True,
            text=True,
            timeout=90,
        )
        return result.stdout if result.returncode == 0 else ""
    except Exception as e:
        logger.warning("pdftotext failed: %s", e)
        return ""


def _extract_pdf(path: Path, on_progress=None) -> dict:
    """Score every extractor's output and return the best one."""
    # Geometry-based (tables) and render-based (QR codes) passes are
    # independent of which text extractor wins below, so run them once up
    # front and attach to whichever result path returns.
    tables = _extract_tables(path)
    qr_codes = _extract_qr_codes(path)

    try:
        native_text, page_count = _pypdf_text(path)
    except Exception as e:
        logger.warning("pypdf failed on %s: %s", path.name, e)
        native_text, page_count = "", 0

    candidates: list[tuple[float, str, str, bool]] = []  # (score, method, text, is_ocr)
    for method, text in (("pypdf", native_text), ("pdftotext", _pdftotext(path))):
        if text.strip():
            candidates.append((_text_quality(text), method, text, False))

    candidates.sort(key=lambda c: c[0], reverse=True)
    best = candidates[0] if candidates else (0.0, "none", "", False)

    # Too little text for the page count means a scanned document; a low score
    # means the bytes decoded into noise (legacy Nepali fonts). Both need OCR.
    sparse = page_count > 0 and len(best[2].strip()) < 100 * page_count
    if sparse or best[0] < QUALITY_THRESHOLD:
        logger.info(
            "Native extraction insufficient (best=%s score=%.2f sparse=%s) — running OCR",
            best[1],
            best[0],
            sparse,
        )
        # Non-blocking check if semaphore is exhausted (threading.Semaphore has no public peek)
        try:
            acquired = _OCR_SEMAPHORE.acquire(blocking=False)
            if acquired:
                _OCR_SEMAPHORE.release()
            else:
                logger.info("OCR queue full (max %d concurrent) — waiting for a slot", config.OCR_MAX_CONCURRENCY)
        except Exception:
            pass
        with _OCR_SEMAPHORE:
            ocr = _ocr_pdf(path, page_count or 1, on_progress=on_progress)
        if ocr["text"].strip():
            ocr_score = _text_quality(ocr["text"])
            logger.info("OCR scored %.2f vs native %.2f", ocr_score, best[0])
            if ocr_score >= best[0]:
                return {
                    "text": ocr["text"],
                    "is_ocr": True,
                    "page_count": ocr["page_count"],
                    "quality": round(ocr_score, 3),
                    "method": f"ocr:{ocr.get('langs', '?')}",
                    "tables": tables,
                    "qr_codes": qr_codes,
                }
        else:
            logger.warning("OCR produced no text; keeping native extraction")

    return {
        "text": best[2],
        "is_ocr": False,
        "page_count": page_count,
        "quality": round(best[0], 3),
        "method": best[1],
        "tables": tables,
        "qr_codes": qr_codes,
    }


def _candidate_lang_sets() -> list[str]:
    """Tesseract language sets to try, best-supported first.

    The configured default (nep+eng) leads: these are Nepali government
    notices, and running the English model over Devanagari is precisely what
    produced pages of "BXXYRCO ; WREVERE" noise.
    """
    available = set(_get_tesseract_langs())
    if not available:
        return [config.TESSERACT_LANG]

    # Single-language sets first: on a degraded Nepali scan, adding `eng` lets
    # the English model win damaged glyphs ("ने.सं." → "Aa:"), so nep-only must
    # get a fair hearing. Ties go to the earlier — i.e. the more specific — set.
    ordered = ["nep", "eng", config.TESSERACT_LANG, "nep+eng", "hin+eng"]
    candidates: list[str] = []
    for spec in ordered:
        langs = spec.split("+")
        if all(lang in available for lang in langs) and spec not in candidates:
            candidates.append(spec)
    return candidates or [config.TESSERACT_LANG]


def _choose_ocr_langs(first_page, pytesseract) -> str:
    """Pick the language set by OCR'ing page one with each and scoring the text.

    Measuring beats guessing: the previous implementation inferred the language
    from a probe that silently crashed, defaulted to English, and then OCR'd
    Nepali documents with the English model.
    """
    candidates = _candidate_lang_sets()
    if len(candidates) == 1:
        return candidates[0]

    best_lang, best_score = candidates[0], -1.0
    for lang in candidates:
        try:
            text = _ocr_image(first_page, pytesseract, lang)
        except Exception as e:
            logger.warning("OCR probe failed for lang=%s: %s", lang, e)
            continue
        score = _text_quality(text)
        logger.info("OCR probe lang=%s score=%.2f chars=%d", lang, score, len(text))
        # Strictly greater, so an equal-scoring later candidate never displaces
        # the more specific one. Every candidate is probed: the differences
        # between them only show up on the noisy pages that matter.
        if score > best_score:
            best_lang, best_score = lang, score

    logger.info("Selected OCR languages: %s (score=%.2f)", best_lang, best_score)
    return best_lang


def _ocr_pdf(path: Path, page_count: int, on_progress=None) -> dict:
    """OCR a PDF by rendering pages to images and running Tesseract.

    Processes pages in small batches to avoid loading hundreds of full-res
    images into memory simultaneously. Uses temp files for Tesseract input
    to avoid stdin/pipe issues with certain pytesseract + Leptonica combos.
    """
    if not _check_tesseract():
        logger.error("Cannot OCR: Tesseract is not installed")
        return {"text": "", "is_ocr": False, "page_count": page_count}

    from pdf2image import convert_from_path
    import pytesseract

    batch_size = 5
    # If pypdf failed to read the page count (page_count==0 → caller fell back to 1),
    # a 100 MB / 500-page doc would only OCR its first page. Re-probe directly so
    # the batch loop below covers the whole file without OOM-ing on a single giant
    # convert_from_path(..., first_page=1, last_page=500) call.
    if page_count <= 1:
        try:
            from pypdf import PdfReader as _FallbackReader

            detected = len(_FallbackReader(str(path)).pages)
            if detected > page_count:
                logger.info("Corrected OCR page_count %d -> %d via fallback PdfReader", page_count, detected)
                page_count = detected
        except Exception as e:
            logger.debug("Fallback page count detection failed: %s", e)
    dpi = 250 if page_count > 50 else 300
    texts: list[str] = []

    logger.info("Starting OCR: %d pages at %d DPI (batch=%d)", page_count, dpi, batch_size)

    ocr_langs = config.TESSERACT_LANG
    try:
        first = convert_from_path(str(path), dpi=dpi, first_page=1, last_page=1)
        if first:
            ocr_langs = _choose_ocr_langs(first[0], pytesseract)
    except Exception as e:
        logger.warning("Language probe failed (%s); using configured %s", e, ocr_langs)

    for start in range(1, page_count + 1, batch_size):
        end = min(start + batch_size - 1, page_count)
        try:
            images = convert_from_path(
                str(path), dpi=dpi, first_page=start, last_page=end
            )
        except Exception as e:
            logger.error("pdf2image failed on pages %d-%d: %s", start, end, e)
            continue

        for img in images:
            text = _ocr_image(img, pytesseract, ocr_langs)
            texts.append(text)
            if on_progress:
                try:
                    on_progress(len(texts), page_count)
                except Exception:
                    # Progress is best-effort; never fail an OCR run over it.
                    logger.exception("OCR on_progress failed at page %d", len(texts))

        if end % 20 == 0 or end == page_count:
            logger.info("OCR progress: %d/%d pages", end, page_count)

    logger.info("OCR complete: %d pages processed", len(texts))
    return {
        "text": "\n\n".join(texts),
        "is_ocr": True,
        "page_count": page_count,
        "langs": ocr_langs,
    }


# --oem 1: LSTM engine only (far better on Devanagari than the legacy engine).
# --psm 3: full automatic page segmentation, right for whole scanned pages.
# preserve_interword_spaces keeps word boundaries in Devanagari intact.
_TESSERACT_CONFIG = "--oem 1 --psm 3 -c preserve_interword_spaces=1"


def _preprocess_for_ocr(img):
    """Grayscale + autocontrast, and upscale small renders.

    Nepali scans are often faint photocopies; Tesseract's Devanagari model is
    noticeably more accurate on a normalized, sufficiently large image.
    """
    try:
        from PIL import ImageOps

        img = ImageOps.grayscale(img)
        img = ImageOps.autocontrast(img)
        if min(img.size) < 1000:
            factor = max(2, 1000 // max(1, min(img.size)))
            img = img.resize((img.width * factor, img.height * factor))
    except Exception as e:
        logger.warning("OCR preprocessing skipped: %s", e)
    return img


def _ocr_image(img, pytesseract, lang: str | None = None) -> str:
    """Run Tesseract on a PIL image via a temp file (avoids stdin/pipe bugs)."""
    if lang is None:
        lang = config.TESSERACT_LANG

    img = _preprocess_for_ocr(img)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        img.save(f, format="PNG")
        tmp_path = f.name

    try:
        text = pytesseract.image_to_string(tmp_path, lang=lang, config=_TESSERACT_CONFIG)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return text


def _extract_docx(path: Path) -> dict:
    """Extract text from DOCX files."""
    from docx import Document

    doc = Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return {"text": "\n\n".join(paragraphs), "is_ocr": False, "page_count": 1}


def _extract_image(path: Path) -> dict:
    """OCR an image file, choosing the language set by measured quality."""
    if not _check_tesseract():
        logger.error("Cannot OCR image: Tesseract is not installed")
        return {"text": "", "is_ocr": False, "page_count": 1}

    import pytesseract
    from PIL import Image

    with Image.open(str(path)) as img:
        img.load()
        ocr_langs = _choose_ocr_langs(img, pytesseract)
        text = _ocr_image(img, pytesseract, ocr_langs)

    return {
        "text": text,
        "is_ocr": True,
        "page_count": 1,
        "quality": round(_text_quality(text), 3),
        "method": f"ocr:{ocr_langs}",
    }


def _extract_text_file(path: Path) -> dict:
    """Extract from plain text files."""
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="latin-1")
    return {"text": content, "is_ocr": False, "page_count": 1}
