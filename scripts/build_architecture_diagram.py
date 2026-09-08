#!/usr/bin/env python3
"""Render the layered system architecture diagram (as-built stack).

Usage:  python3 scripts/build_architecture_diagram.py
Output: Chapter4&5/diagrams/system_architecture.png (+ .svg)
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

OUT_DIR = Path(__file__).resolve().parents[1] / "Chapter4&5" / "diagrams"

# (title, band fill, title colour, [box labels])
LAYERS = [
    (
        "Data Sources",
        "#dce7f5",
        "#2b5f8e",
        [
            "Nepal Government Websites\n(Gazette, PSC, Ministries, Universities)",
            "Public Notices\nHTML, PDF, Image",
        ],
    ),
    (
        "Data Collection",
        "#d6ebe7",
        "#1f7a6b",
        [
            "Crawl4AI\n(Playwright headless)",
            "Sitemap / Direct-URL Crawl",
            "BeautifulSoup4 Parsing",
            "NestJS Cron Scheduler",
        ],
    ),
    (
        "Processing",
        "#dcecd8",
        "#3d7a34",
        [
            "Text Extraction\npypdf · pdfplumber · python-docx",
            "OCR\nTesseract + Gemini Vision",
            "Cleaning & Nepali Date\nNormalisation (BS ⇄ AD)",
        ],
    ),
    (
        "AI Intelligence",
        "#f0e7cf",
        "#8a6d1f",
        [
            "Classification",
            "LLM Summarisation\n(Groq)",
            "Category Tagging",
            "Duplicate Detection",
        ],
    ),
    (
        "Data Storage",
        "#f6e2d8",
        "#a85632",
        [
            "PostgreSQL (Supabase) via Prisma 6\nUsers · Notices · Categories · Sources · Documents",
            "AWS S3\nFile Storage",
        ],
    ),
    (
        "RAG / Intelligent Retrieval",
        "#e6e0f2",
        "#5b46a3",
        [
            "Document Upload",
            "Chunking",
            "Embeddings\nmultilingual-e5-base",
            "Qdrant\nVector DB",
            "Semantic Retrieval",
            "LLM Answer\nGroq / Gemini",
        ],
    ),
    (
        "Backend Services",
        "#dfe4ec",
        "#3c5878",
        [
            "NestJS 11 API",
            "Auth\nJWT + Google OAuth",
            "Search & Filter API",
            "Notice Management",
            "Alerts\nWhatsApp · Email",
            "Admin Controls",
        ],
    ),
    (
        "Frontend Application",
        "#dce7f5",
        "#2b5f8e",
        [
            "Next.js 16 / React 19\nTailwind v4 · shadcn/ui",
            "Search & Filter",
            "View Notices",
            "View AI Summary",
            "Upload Document",
            "Ask Questions (RAG)",
        ],
    ),
    (
        "End Users",
        "#f4ead9",
        "#8a6d1f",
        [
            "Users\nStudents, Job Seekers, Citizens, Professionals",
            "Admin",
        ],
    ),
]

FIG_W, FIG_H = 9.2, 13.0
MARGIN_X = 0.30
BAND_W = FIG_W - 2 * MARGIN_X
TITLE_H = 0.34
BOX_H = 0.62
PAD = 0.16
GAP = 0.40  # vertical gap between bands (arrow lives here)


def band_height(_labels: list[str]) -> float:
    return TITLE_H + BOX_H + 2 * PAD


def rounded(ax, x, y, w, h, *, fc, ec, lw=1.0, radius=0.08, z=1):
    ax.add_patch(
        FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle=f"round,pad=0,rounding_size={radius}",
            facecolor=fc,
            edgecolor=ec,
            linewidth=lw,
            zorder=z,
        )
    )


def main() -> None:
    total = sum(band_height(l[3]) for l in LAYERS) + GAP * (len(LAYERS) - 1)
    top_pad, bottom_pad = 0.95, 0.35
    fig_h = total + top_pad + bottom_pad

    fig = plt.figure(figsize=(FIG_W, fig_h), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, FIG_W)
    ax.set_ylim(0, fig_h)
    ax.axis("off")
    fig.patch.set_facecolor("white")

    ax.text(
        FIG_W / 2,
        fig_h - 0.45,
        "System Architecture Diagram",
        ha="center",
        va="center",
        fontsize=15,
        fontweight="bold",
        color="#1b1b1b",
    )
    ax.plot(
        [MARGIN_X, FIG_W - MARGIN_X],
        [fig_h - 0.75, fig_h - 0.75],
        color="#cccccc",
        lw=0.8,
    )

    y = fig_h - top_pad
    for idx, (title, band_fc, title_c, labels) in enumerate(LAYERS):
        h = band_height(labels)
        y -= h
        rounded(ax, MARGIN_X, y, BAND_W, h, fc=band_fc, ec="#00000000", radius=0.12)

        ax.text(
            FIG_W / 2,
            y + h - PAD - TITLE_H / 2,
            title,
            ha="center",
            va="center",
            fontsize=10.5,
            fontweight="bold",
            color=title_c,
        )

        n = len(labels)
        inner_w = BAND_W - 2 * PAD
        gap_x = 0.12
        bw = (inner_w - gap_x * (n - 1)) / n
        bx = MARGIN_X + PAD
        by = y + PAD
        for label in labels:
            rounded(ax, bx, by, bw, BOX_H, fc="white", ec="#c9c9c9", lw=0.9, z=2)
            ax.text(
                bx + bw / 2,
                by + BOX_H / 2,
                label,
                ha="center",
                va="center",
                fontsize=6.6,
                fontweight="bold",
                color="#333333",
                linespacing=1.45,
                zorder=3,
            )
            bx += bw + gap_x

        if idx < len(LAYERS) - 1:
            ax.add_patch(
                FancyArrowPatch(
                    (FIG_W / 2, y - 0.06),
                    (FIG_W / 2, y - GAP + 0.06),
                    arrowstyle="-|>",
                    mutation_scale=11,
                    color="#8a8a8a",
                    lw=1.1,
                )
            )
        y -= GAP

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    png = OUT_DIR / "system_architecture.png"
    fig.savefig(png, dpi=200, facecolor="white")
    fig.savefig(OUT_DIR / "system_architecture.svg", facecolor="white")
    plt.close(fig)
    print(f"wrote {png}")


if __name__ == "__main__":
    main()
