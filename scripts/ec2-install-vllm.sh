#!/usr/bin/env bash
# ── Install vLLM (CPU-only) on EC2 services i-071d7b2debed5e3ed ────────────
# t3.large: 2 vCPU, 7.6 GiB RAM, NO GPU — must use --device cpu
# Model: Qwen/Qwen2.5-1.5B-Instruct (~3 GB, fits; 3B ~6 GB is tighter, 7B doesn't fit)
# Port: 8001 (8000 is reserved for Beanstalk AI; Ollama 11434 is NOW TOP PRIORITY)
# Endpoint: http://172.31.95.204:8001/v1/chat/completions  (public http://3.80.188.210:8001/v1/chat/completions)
# Run: chmod +x scripts/ec2-install-vllm.sh && SSH_KEY=~/.ssh/ssh-key-2026-07-23.key ./scripts/ec2-install-vllm.sh
#
# STATUS 2026-09-08: vLLM at 8001 is currently DOWN — health "Could not reach
# the provider. All connection attempts failed" at http://3.80.188.210:8001/v1/chat/completions.
# Ollama at http://3.80.188.210:11434 (qwen2.5:1.5b) is Responding 2127ms and is now TOP (-10).
# vLLM failure on /opt/vllm Python 3.11: "Failed to infer device type" + "vllm._C_AVX512 missing"
# Root cause: vLLM CPU has NO prebuilt wheels (docs.vllm.ai CPU page) — must BUILD FROM SOURCE
# with VLLM_TARGET_DEVICE=cpu at pip build time, gcc>=12, and AVX512 flags. The pip wheel
# for GPU (manylinux) on CPU-only t3.large fails to infer device. Even when built, vLLM CPU
# is GPU-optimized and SLOWER than Ollama llama.cpp on CPU (1.5B vLLM 3-7s vs Ollama 2-4s).
# This script now installs vLLM as SECONDARY (-9) with correct CPU build; Ollama stays TOP.
# If you want very very fast, keep Ollama TOP and use vLLM 0.5B (0.8GB 1-2s) as 2nd agent,
# or skip vLLM entirely and keep Ollama only — see FIX options below.
#
# FIX OPTIONS:
#  1) Keep Ollama TOP (recommended, proven): do nothing — Ollama 11434 is already healthy.
#     Disable vLLM: sudo systemctl stop vllm; sudo systemctl disable vllm; then in DB set
#     vllm-services enabled=false or delete row, keep ollama-services at -10. (No rebuild)
#  2) Fix vLLM as SECONDARY (-9) with smaller 0.5B model (faster, fits): MODEL=Qwen/Qwen2.5-0.5B-Instruct ./scripts/ec2-install-vllm.sh
#  3) Rebuild vLLM 1.5B as SECONDARY from source (30-60 min, needs 7.6GB + swap): ./scripts/ec2-install-vllm.sh
#     This script does (3) with proper VLLM_TARGET_DEVICE=cpu source build.
#
# See docs/EC2_VLLM_MIGRATION.md Troubleshooting + app/api/src/services/ai-providers.service.ts
# for DB swap logic (Ollama -10, vLLM -9).
set -euo pipefail

EC2_PUBLIC="3.80.188.210"
EC2_PRIVATE="172.31.95.204"
EC2_ID="i-071d7b2debed5e3ed"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ssh-key-2026-07-23.key}"
SSH_USER="${SSH_USER:-ubuntu}"
VLLM_PORT="${VLLM_PORT:-8001}"
MODEL="${MODEL:-Qwen/Qwen2.5-1.5B-Instruct}"  # very very fast; alt: Qwen/Qwen2.5-3B-Instruct
# For Nepali RAG quality vs speed:
#  - Qwen/Qwen2.5-1.5B-Instruct : ~3 GB, ~3-7s/token batch on 2 vCPU, fastest, good Nepali
#  - Qwen/Qwen2.5-3B-Instruct   : ~6 GB, ~8-15s, better Nepali, near RAM limit

echo "==> [1/7] Verify EC2"
aws ec2 describe-instances --instance-ids "$EC2_ID" --query "Reservations[0].Instances[0].{State:State.Name,Type:InstanceType,PublicIp:PublicIpAddress,PrivateIp:PrivateIpAddress}" --output table || true
echo "    Free RAM needed: ~4.5 GB for 1.5B (model 3GB + overhead 1.5GB). t3.large=7.6GB OK. 7B needs ~14GB → OOM, that's why Ollama qwen2.5:7b was replaced."

echo "==> [2/7] SSH → $EC2_PUBLIC : install vLLM CPU"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${EC2_PUBLIC}" bash -s -- "$VLLM_PORT" "$MODEL" <<'EOSSH'
set -xeuo pipefail
PORT="$1"
MODEL="$2"
echo "--- host ---"
hostname; free -h; df -h | head -n 10; nproc; cat /etc/os-release | head -n 5

# ── deps ──
# vLLM 0.6.x-0.10.x CPU: "Failed to infer device type" happens when:
#  - VLLM_TARGET_DEVICE not set to cpu at BUILD time (pip install must see it), or
#  - using GPU manylinux wheel on CPU-only host (no CPU ops → vllm._C missing), or
#  - Python <3.11 or missing gcc12/libnuma/tcmalloc, or
#  - AVX512 mismatch: vLLM CPU builds AVX512 by default; t3 Xeon Platinum 8000 *does*
#    have AVX512 (check: lscpu | grep avx512), but if wheel was built without it, you get
#    "vllm._C_AVX512 missing" / "Illegal instruction". Fix: build from source on host OR
#    set VLLM_CPU_DISABLE_AVX512=0 and rebuild. See https://docs.vllm.ai/en/latest/getting_started/cpu-installation.html
#    and https://docs.vllm.ai/en/v0.10.1/getting_started/installation/cpu.html
#    IMPORTANT: vLLM CPU has NO prebuilt wheels — must build from source (30-60 min, 4GB+ RAM).
#    Ollama (llama.cpp) is 10x easier on CPU and FASTER (2-4s vs 3-7s), so keep it TOP.
# t3.large Ubuntu 22.04 defaults python3.10 — we force 3.11 for CPU build.
sudo apt-get update -y
sudo apt-get install -y python3-pip python3-venv python3-dev build-essential curl git htop software-properties-common gcc-12 g++-12 libnuma-dev libtcmalloc-minimal4 2>&1 | tail -n 20 || \
sudo apt-get install -y python3-pip python3-venv python3-dev build-essential curl git htop software-properties-common
# Ensure Python 3.11 (required for vLLM CPU wheel with --device cpu fix)
if ! command -v python3.11 >/dev/null 2>&1; then
  echo "Installing Python 3.11..."
  sudo add-apt-repository -y ppa:deadsnakes/ppa 2>&1 | tail -n 10 || true
  sudo apt-get update -y
  sudo apt-get install -y python3.11 python3.11-venv python3.11-dev 2>&1 | tail -n 20 || \
  sudo apt-get install -y python3.11-venv python3.11-dev 2>&1 | tail -n 20 || true
fi
PYTHON_BIN="$(command -v python3.11 || command -v python3.10 || command -v python3)"
echo "Using PYTHON_BIN=$PYTHON_BIN ($($PYTHON_BIN --version))"

# ── CPU flags check ──
echo "--- CPU flags (AVX512?) ---"
lscpu | grep -i avx || echo "no AVX flags"
lscpu | grep -i "avx512" && echo "AVX512 present — good for vLLM CPU" || echo "AVX512 NOT found — vLLM CPU will use AVX2 (slow, not recommended; consider Ollama TOP only)"
free -h; echo "Need ~4.5GB for 1.5B build + model; t3.large 7.6GB OK but tight — building vLLM from source needs 30-60 min and 4GB+ RAM + swap"


# ── python venv ──
if [ ! -d /opt/vllm ]; then
  sudo $PYTHON_BIN -m venv /opt/vllm
fi
sudo chown -R $USER:$USER /opt/vllm 2>/dev/null || true
source /opt/vllm/bin/activate
pip install -U pip wheel setuptools packaging ninja 2>&1 | tail -n 20 || pip install -U pip wheel setuptools
# Prefer gcc12 for AVX512 build
if command -v gcc-12 >/dev/null 2>&1; then
  export CC=gcc-12 CXX=g++-12
  echo "Using CC=$CC CXX=$CXX"
fi
# TCMalloc for vLLM CPU perf (recommended in docs)
if [ -f /usr/lib/x86_64-linux-gnu/libtcmalloc_minimal.so.4 ]; then
  export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libtcmalloc_minimal.so.4:$LD_PRELOAD
  echo "LD_PRELOAD tcmalloc enabled"
fi

# ── vLLM CPU install — MUST BUILD FROM SOURCE (no prebuilt CPU wheels) ──
# CRITICAL: VLLM_TARGET_DEVICE=cpu must be set at install time or vLLM infers CUDA and fails
# with "Failed to infer device type" on CPU-only t3.large. See https://docs.vllm.ai/en/latest/getting_started/cpu-installation.html
# t3.large has no GPU → CPU build. As of 2024-2026, vLLM CPU is pip-installable via extra index ONLY if you build.
export VLLM_TARGET_DEVICE=cpu
export HF_HUB_ENABLE_HF_TRANSFER=1
# Optional: control AVX512 (t3 Xeon Platinum has it; disable only if Illegal instruction)
# export VLLM_CPU_DISABLE_AVX512=false  # set true if you see Illegal instruction on non-AVX512 host
# export VLLM_CPU_AVX512BF16=1
# export VLLM_CPU_AVX512VNNI=1
# Install CPU torch first (small, avoids CUDA wheel) — MUST be CPU wheel
echo "--- pip install torch CPU ---"
pip install --extra-index-url https://download.pytorch.org/whl/cpu torch --no-cache-dir 2>&1 | tail -n 30 || true
# Try CPU-specific requirements first (recommended path per docs)
echo "--- pip install vLLM CPU requirements ---"
pip install -U "huggingface_hub[hf_transfer]" hf_transfer 2>&1 | tail -n 20 || true
# Attempt 1: pip wheel with VLLM_TARGET_DEVICE=cpu (may trigger source build, 30-60 min)
echo "--- pip install vLLM CPU (VLLM_TARGET_DEVICE=cpu) — may BUILD FROM SOURCE 30-60 min ---"
VLLM_TARGET_DEVICE=cpu pip install --extra-index-url https://download.pytorch.org/whl/cpu "vllm==0.6.3" --no-cache-dir 2>&1 | tail -n 100 || \
VLLM_TARGET_DEVICE=cpu pip install --extra-index-url https://download.pytorch.org/whl/cpu vllm --no-cache-dir 2>&1 | tail -n 100 || {
  echo "WARN: pip wheel install failed — trying BUILD FROM SOURCE (git clone + requirements-cpu.txt)..."
  # Build from source fallback (official docs: pip install -v -r requirements/cpu.txt then VLLM_TARGET_DEVICE=cpu pip install -e .)
  cd /tmp
  rm -rf vllm 2>/dev/null || true
  git clone https://github.com/vllm-project/vllm.git 2>&1 | tail -n 20 || echo "git clone failed"
  cd vllm
  # Pin to known-good CPU version that still supports --device cpu (0.5.3-0.6.3)
  # 0.7+ changed device detection and is more strict; 0.6.3 is proven on CPU in docs
  git checkout v0.6.3 2>&1 | tail -n 5 || true
  pip install -v -r requirements-cpu.txt --extra-index-url https://download.pytorch.org/whl/cpu 2>&1 | tail -n 50 || \
  pip install -v -r requirements/cpu.txt --extra-index-url https://download.pytorch.org/whl/cpu 2>&1 | tail -n 50 || true
  VLLM_TARGET_DEVICE=cpu pip install -e . --extra-index-url https://download.pytorch.org/whl/cpu 2>&1 | tail -n 100 || \
  VLLM_TARGET_DEVICE=cpu python setup.py install 2>&1 | tail -n 100 || echo "source build also failed — recommend Ollama fallback"
  cd -
}
# Verify device — check both vllm import and AVX512
python -c "import vllm; print('vLLM version', vllm.__version__)" 2>&1 | tail -n 20 || echo "vLLM import FAILED — see 'Failed to import from vllm._C' above; use Ollama TOP instead"
python -c "import torch; print('torch', torch.__version__, 'cuda?', torch.cuda.is_available(), 'avx512?', torch.cpu._is_avx512_supported() if hasattr(torch.cpu, '_is_avx512_supported') else 'unknown')" 2>&1 | tail -n 20 || true
python -c "import vllm; import torch; print('vLLM CPU check: device cpu should not need CUDA, torch.cuda.is_available()=', torch.cuda.is_available())" 2>&1 | tail -n 20 || true

# Already ensured huggingface_hub above
export HF_HUB_ENABLE_HF_TRANSFER=1

# ── Ollama health check — keep TOP alive even if vLLM fails ──
echo "--- Ollama TOP health (should be Responding 2127ms) ---"
curl -s --connect-timeout 5 http://127.0.0.1:11434/api/tags 2>&1 | head -n 20 && echo "Ollama 11434 responding ✓ (TOP -10)" || echo "Ollama 11434 NOT responding — TOP will be down; consider: curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b && sudo systemctl enable --now ollama"
curl -s --connect-timeout 5 http://127.0.0.1:11434/v1/models 2>&1 | head -n 20 || true
curl -s --connect-timeout 5 http://3.80.188.210:11434/v1/models 2>&1 | head -n 20 || true

# ── pre-download model (optional, speeds first boot) ──
echo "--- pre-fetch $MODEL (hf download) ---"
hf download "$MODEL" --local-dir "/opt/vllm/models/$(echo $MODEL | tr '/' '_')" 2>&1 | tail -n 20 || \
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL', local_dir='/opt/vllm/models/test')" 2>&1 | tail -n 20 || echo "download via vLLM lazy will happen on first start"

# ── systemd service ──
# CPU flags: --device cpu --dtype auto --max-model-len 2048 --enforce-eager --swap-space 2
#  --max-model-len 2048 limits KV cache to fit 7.6GB; 4096 would OOM on 1.5B with concurrency.
#  --dtype auto uses bfloat16 on AVX512-BF16 (t3 Xeon Platinum has it, ~1.3x faster) else float32.
#  --enforce-eager saves ~1GB torch compile cache, critical on 7.6GB.
#  --max-num-seqs 8 = multiple agents in one host: 8 concurrent RAG summarizations without OOM (continuous batching).
#  VLLM_TARGET_DEVICE=cpu is MANDATORY in systemd env or service fails with "Failed to infer device type"
#  (the bug seen on t3.large with Python 3.9 + no env + GPU wheel). Also need HF_HOME.
#  NOTE: This vLLM is now SECONDARY (-9); Ollama 11434 is TOP (-10, proven 2-4s). See header.
sudo tee /etc/systemd/system/vllm.service >/dev/null <<EOF
[Unit]
Description=vLLM CPU (Qwen2.5-1.5B) on :$PORT — VLLM_TARGET_DEVICE=cpu — SECONDARY (-9) after Ollama TOP
After=network.target

[Service]
User=$USER
Environment=VLLM_TARGET_DEVICE=cpu
Environment=HF_HUB_ENABLE_HF_TRANSFER=1
Environment=HF_HOME=/opt/vllm/cache
Environment=HF_HUB_ENABLE_HF_TRANSFER=1
# Optional AVX512 tuning (only if Illegal instruction on non-AVX512 host):
# Environment=VLLM_CPU_DISABLE_AVX512=0
ExecStart=/opt/vllm/bin/python -m vllm.entrypoints.openai.api_server \\
  --model $MODEL \\
  --host 0.0.0.0 \\
  --port $PORT \\
  --device cpu \\
  --dtype auto \\
  --max-model-len 2048 \\
  --max-num-seqs 8 \\
  --enforce-eager \\
  --swap-space 2 \\
  --served-model-name $MODEL \\
  --disable-log-requests
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable vllm
sudo systemctl restart vllm
echo "--- vllm service started, waiting 30s for model load ---"
sleep 5
sudo systemctl status vllm --no-pager | head -n 50 || true
sudo journalctl -u vllm -n 80 --no-pager | tail -n 80 || true

# Wait for /health (model load takes 30-90s on CPU for 1.5B)
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "vLLM health ok on try $i"
    break
  fi
  if curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
    echo "vLLM /v1/models ok on try $i"
    break
  fi
  echo "waiting vLLM... $i/30"
  sleep 5
done

echo "--- local probes ---"
curl -s "http://127.0.0.1:${PORT}/health" | head -n 50 || echo "no /health"
curl -s "http://127.0.0.1:${PORT}/v1/models" | head -n 100 || echo "no /v1/models"
echo "--- private IP probe ---"
curl -s "http://${EC2_PRIVATE}:${PORT}/v1/models" 2>&1 | head -n 50 || echo "private IP not yet"
echo "--- CPU/RAM ---"
free -h; ps aux --sort=-%mem | head -n 10
ss -tlnp | grep "$PORT" || echo "port $PORT not listening yet"

EOSSH

echo "==> [3/7] Security group: open TCP $VLLM_PORT"
echo "    Current SGs for $EC2_ID:"
aws ec2 describe-instances --instance-ids "$EC2_ID" --query "Reservations[0].Instances[0].SecurityGroups" --output table || true
SG_ID=$(aws ec2 describe-instances --instance-ids "$EC2_ID" --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "")
if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
  echo "    SG $SG_ID — checking if $VLLM_PORT already open:"
  aws ec2 describe-security-groups --group-ids "$SG_ID" --query "SecurityGroups[0].IpPermissions[?FromPort==\`$VLLM_PORT\`]" --output table || true
  echo "    To open (if not already):"
  echo "    aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port $VLLM_PORT --cidr 0.0.0.0/0"
  # Uncomment to auto-open:
  # aws ec2 authorize-security-group-ingress --group-id "$SG_ID" --protocol tcp --port "$VLLM_PORT" --cidr 0.0.0.0/0 2>&1 | head -n 5 || echo "already open or failed"
  echo "    (For tighter security, restrict to Beanstalk API SG instead of 0.0.0.0/0)"
fi

echo "==> [4/7] External probes (public IP)"
echo "    curl http://${EC2_PUBLIC}:${VLLM_PORT}/health"
curl -s --connect-timeout 10 "http://${EC2_PUBLIC}:${VLLM_PORT}/health" | head -n 50 || echo "health not yet (model still loading?)"
curl -s --connect-timeout 10 "http://${EC2_PUBLIC}:${VLLM_PORT}/v1/models" | head -n 100 || echo "models not yet"
echo "    --- chat completion smoke test (very very fast needs small max_tokens) ---"
curl -s --connect-timeout 60 -X POST "http://${EC2_PUBLIC}:${VLLM_PORT}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: २०७१\"}],\"max_tokens\":16,\"temperature\":0}" \
  | head -n 100 || echo "chat not yet ready"

echo "==> [5/7] Internal probe via private IP (from same host, shown above) is canonical: http://${EC2_PRIVATE}:${VLLM_PORT}/v1/chat/completions"
echo "    External callers (api, ai) must use public http://${EC2_PUBLIC}:${VLLM_PORT}/v1/chat/completions (172.31.95.204 not routable outside VPC)"

echo "==> [6/7] Configure AI_PROVIDER_ALLOWED_HOSTS on API (Beanstalk) to allow http + private host"
cat <<'EONEXT'
# On Beanstalk (suchanaai-api) env vars OR /opt/config/pnm/api.env:
AI_PROVIDER_ALLOWED_HOSTS=3.80.188.210

# Set via EB console: Configuration → Software → Environment properties → AI_PROVIDER_ALLOWED_HOSTS=3.80.188.210 → Apply
# Or via CLI:
aws elasticbeanstalk update-environment --environment-name suchanaai-api-prod --region us-east-1 \
  --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=AI_PROVIDER_ALLOWED_HOSTS,Value=3.80.188.210

# Also needed if AI service calls vLLM directly (ai_config_sync not involved):
# apps/ai env: no allowlist there, but api must allow it when admin saves provider.

# After setting, test via API:
# curl -X POST https://api.suchanaai.tech/ai-providers/models -H "Authorization: Bearer <admin-jwt>" -d '{"kind":"OPENAI_COMPATIBLE","baseUrl":"http://3.80.188.210:8001/v1/chat/completions"}'
EONEXT

echo "==> [7/7] Admin UI: provider order — FIXED 2026-09-08 (Ollama TOP -10, vLLM SECOND -9)"
cat <<EOPROVIDER
# CURRENT HEALTH 2026-09-08:
#  - Ollama http://3.80.188.210:11434  → Responding 2127ms ✓ TOP (-10) qwen2.5:1.5b 986MB 2-4s (proven CPU)
#  - vLLM   http://3.80.188.210:8001    → "Could not reach provider" ✗ SECOND (-9) — Failed to infer device type / vllm._C_AVX512 missing
# FIX: DB swapped on next API boot (see apps/api/src/services/ai-providers.service.ts):
#  ollama-services sortOrder -10 (TOP), vllm-services -9 (SECOND). No manual DB edit needed — just restart API.
# Manual DB swap if needed:
#  PGPASSWORD="..." psql -h 141.148.209.235 -U postgres -d public_notice_management -c "UPDATE ai_providers SET sort_order=-10 WHERE slug='ollama-services'; UPDATE ai_providers SET sort_order=-9 WHERE slug='vllm-services'; SELECT slug, sort_order, baseUrl, enabled FROM ai_providers ORDER BY sort_order;"

# Go to https://suchanaai.tech/admin/ai → Add provider → preset:
#  "⚡ Ollama (Qwen2.5-1.5B) — EC2 services [TOP PRIORITY — CPU proven 2-4s]" (11434, qwen2.5:1.5b, -10)
#  "vLLM (Qwen2.5-1.5B) — EC2 services [SECONDARY — CPU needs rebuild]" (8001, Qwen/Qwen2.5-1.5B-Instruct, -9)
# Or manual:
Label: Ollama (Qwen2.5-1.5B) — EC2 services  # TOP
Kind: OPENAI_COMPATIBLE
Endpoint: http://3.80.188.210:11434/v1/chat/completions
Model: qwen2.5:1.5b
API key: (HIDDEN — self-hosted needs no key; UI hides the field automatically)
# Save, then Test → should return ok ~2-4s with २०७१ probe. Now TOP priority (sortOrder -10).
# vLLM row stays -9; Test will be red until EC2 vLLM is rebuilt (see steps 2 above). That's OK — hedged race uses Ollama.

# Verify fallback chain: ai logs — hedged multi-agent race, fastest wins:
# ssh to ai host: curl -s http://localhost:8000/llm/health | jq
# Should list ollama-services with ok=true at top, activeProvider = ollama-services when it is healthy,
# otherwise openrouter/groq. Race: Ollama 2s vs liquid 0.6s vs groq 0.3s — fastest healthy wins, not sequential 60s wait.
# Logs: "Hedged race won by ... — cancelling N other agent(s)"

# Speed: t3.large CPU is ~10× slower than GPU. Ollama 1.5b 2-4s, vLLM 1.5B 3-7s (GPU-optimized, slower on CPU),
# 0.5B vLLM 1-2s (~0.8GB) but needs same CPU build, 3B 8-15s, 7B 25s + OOMs at 7.6GB. Hedged race means:
#  - Cache hit: <5ms (5-min LRU)
#  - OpenRouter liquid: <600ms
#  - Groq: 0.3s
#  - Ollama 1.5B local: 2-4s no quota/ratelimit — survives when free tiers 429
#  - vLLM 1.5B local: 3-7s (when fixed) — also no quota, but slower than Ollama on CPU
# For "very very fast" keep Ollama TOP, continuous batching (--max-num-seqs 8) on vLLM handles 8 concurrent
# summaries as multiple agents on one host without extra RAM when it is healthy.

# ── Multiple agents: add a 2nd row for same host, different model (optional) ──
# Preset "⚡ vLLM Ultra-Fast (Qwen2.5-0.5B) — 2nd agent" (same :8001, model Qwen/Qwen2.5-0.5B-Instruct)
# requires either: (a) second vLLM on :8002 (MODEL=Qwen/Qwen2.5-0.5B-Instruct VLLM_PORT=8002 ./scripts/ec2-install-vllm.sh)
# or (b) switch that host to 0.5B. Hedged race will then have 2 local agents (Ollama 1.5b quality + vLLM 0.5b speed).

# ── Ollama TOP — keep it running (proven) ──
# If Ollama 11434 ever goes down: curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b && sudo systemctl enable --now ollama
# Check: sudo systemctl status ollama; ss -tlnp | grep 11434; curl -s http://127.0.0.1:11434/api/tags | jq
# Ollama 0.5b ultra-fast alternative: ollama pull qwen2.5:0.5b (396MB, ~1-2s) as 2nd agent on same 11434 (just change model)

# ── vLLM SECOND — fix or disable ──
# If vLLM still "Failed to infer device type" after rebuild, either:
#  (a) Keep it SECOND (-9) red — hedged race will ignore it until fixed (safe), or
#  (b) Disable it in admin UI (enabled=false) or DB: UPDATE ai_providers SET enabled=false WHERE slug='vllm-services';
#  (c) Remove row: DELETE FROM ai_providers WHERE slug='vllm-services'; — Ollama alone is enough.
# See docs/EC2_VLLM_MIGRATION.md "Troubleshooting: Failed to infer device type / vllm._C_AVX512"
EOPROVIDER

echo ""
echo "Done. vLLM on :$VLLM_PORT with $MODEL"
echo "Check: sudo systemctl status vllm; sudo journalctl -u vllm -f; curl http://${EC2_PUBLIC}:${VLLM_PORT}/v1/models"
