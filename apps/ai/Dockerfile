# syntax=docker/dockerfile:1

# ---------- Base ----------
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Runtime libraries needed by OCR/PDF processing.
#   libgomp1      — OpenMP runtime for torch / onnxruntime
#   poppler-utils — pdf2image's `pdftoppm` backend
#   tesseract-ocr — OCR engine; -nep is the Nepali traineddata, without which
#                   TESSERACT_LANG="nep+eng" silently degrades to English-only
#                   (see the availability filter in app/extractor.py).
# libgl1/libglib2.0-0 are deliberately absent: they exist only for opencv,
# which nothing in requirements.txt pulls in.
#
# The cache mounts persist apt's archive across rebuilds; the `rm -rf` still
# runs, so only the *build cache* grows, not the image.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        libgomp1 \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-nep \
    && rm -rf /var/lib/apt/lists/*

# Fixed, user-independent browser location. Playwright otherwise resolves it
# from $HOME (~/.cache/ms-playwright), so a browser downloaded as one user is
# invisible to the process that launches it — one of the ways scrape runs end
# up with "Executable doesn't exist".
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ---------- Dependencies ----------
FROM base AS deps

COPY apps/ai/requirements.txt ./requirements.txt

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip

# This server has no GPU.
# Install the CPU-only PyTorch build instead of pulling CUDA/NVIDIA packages
# (CUDA wheels are multiple GB; the CPU wheel is a fraction of that).
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install \
    torch \
    --index-url https://download.pytorch.org/whl/cpu

# Install the remaining AI dependencies.
#
# torch is pinned to the CPU build installed above via a constraints file
# rather than by adding the PyTorch index as an --extra-index-url: an extra
# index makes pip query both indexes for every package in the tree, which
# measurably dominates this step. If some dependency genuinely demands a
# different torch, pip now fails loudly here instead of silently replacing the
# CPU wheel with the multi-GB CUDA build from PyPI.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip freeze | grep -i '^torch==' > /tmp/torch-constraint.txt \
    && pip install \
    -r requirements.txt \
    -c /tmp/torch-constraint.txt

# ---------- Production ----------
FROM base AS runner

# 1 thread: with --workers 1, torch=2 starves the event loop and ALB health checks time out.
ENV OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    MALLOC_ARENA_MAX=2 \
    TOKENIZERS_PARALLELISM=false

# Point every model cache at /app/models, which docker-compose backs with the
# `ai-models` volume. Without this, HuggingFace caches under /root/.cache and
# the ~1 GB embedding model is re-downloaded on every container recreate.
ENV HF_HOME=/app/models \
    SENTENCE_TRANSFORMERS_HOME=/app/models \
    FASTEMBED_CACHE_PATH=/app/models/fastembed

# Copy installed Python packages and executables.
COPY --from=deps /usr/local/lib/python3.11/site-packages \
    /usr/local/lib/python3.11/site-packages

COPY --from=deps /usr/local/bin \
    /usr/local/bin

# The browser crawl4ai drives. Installed here, in the final stage, for two
# reasons: apt packages from `deps` are not copied forward (only site-packages
# and /usr/local/bin are), and `--with-deps` needs its shared libraries to land
# in the image that actually launches Chromium. Doing it at build time also
# keeps scrape runs off the network and turns a broken browser into a build
# failure rather than a failed run.
#
# Ordered before the app COPY so code changes don't re-download the browser.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Application code.
COPY apps/ai/app ./app

# Runtime directories.
RUN mkdir -p /app/data/uploads /app/models

EXPOSE 8000

# One worker is intentional:
# this server has only 2 vCPU / ~1 GB RAM and the embedding
# models are loaded into process memory.
#
# --timeout-keep-alive 75 sits above the ALB's 60s idle timeout so the load
# balancer never reuses a socket this process is closing — that race surfaces
# as an intermittent 502 that clears itself on the next request. The default
# is 5s.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "75"]