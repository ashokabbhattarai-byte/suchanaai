#!/usr/bin/env bash
# ── Install vLLM (CPU-only) on EC2 services i-071d7b2debed5e3ed ────────────
# t3.large: 2 vCPU, 7.6 GiB RAM, NO GPU — must use --device cpu
# Model: Qwen/Qwen2.5-1.5B-Instruct (~3 GB, fits; 3B ~6 GB is tighter, 7B doesn't fit)
# Port: 8001 (8000 is reserved for Beanstalk AI; Ollama was 11434)
# Endpoint: http://172.31.95.204:8001/v1/chat/completions  (public http://3.80.188.210:8001/v1/chat/completions)
# Run: chmod +x scripts/ec2-install-vllm.sh && SSH_KEY=~/.ssh/ssh-key-2026-07-23.key ./scripts/ec2-install-vllm.sh
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
# vLLM 0.6.x requires Python ≥3.9 but CPU path ("Failed to infer device type") happens when:
#  - python is 3.9 on Ubuntu 20.04 without python3.11, or
#  - VLLM_TARGET_DEVICE not set to cpu at build/install time.
# t3.large Ubuntu 22.04 defaults python3.10 — we force 3.11 for supported CPU wheel.
sudo apt-get update -y
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

# ── python venv ──
if [ ! -d /opt/vllm ]; then
  sudo $PYTHON_BIN -m venv /opt/vllm
fi
sudo chown -R $USER:$USER /opt/vllm 2>/dev/null || true
source /opt/vllm/bin/activate
pip install -U pip wheel setuptools

# ── vLLM CPU wheel ──
# CRITICAL: VLLM_TARGET_DEVICE=cpu must be set at install time or vLLM infers CUDA and fails
# with "Failed to infer device type" on CPU-only t3.large. See https://docs.vllm.ai/en/latest/getting_started/cpu-installation.html
# t3.large has no GPU → CPU build. As of 2024-2026, vLLM CPU is pip-installable via extra index.
export VLLM_TARGET_DEVICE=cpu
export HF_HUB_ENABLE_HF_TRANSFER=1
# Install CPU torch first (small, avoids CUDA wheel)
echo "--- pip install torch CPU ---"
pip install --extra-index-url https://download.pytorch.org/whl/cpu torch --no-cache-dir 2>&1 | tail -n 30 || true
# Fallback: pip install vllm (will pull CPU if no CUDA). Pin to avoid breaking.
echo "--- pip install vLLM CPU (VLLM_TARGET_DEVICE=cpu) ---"
pip install --extra-index-url https://download.pytorch.org/whl/cpu "vllm==0.6.3" --no-cache-dir 2>&1 | tail -n 50 || \
pip install --extra-index-url https://download.pytorch.org/whl/cpu vllm --no-cache-dir 2>&1 | tail -n 50 || \
VLLM_TARGET_DEVICE=cpu pip install vllm --extra-index-url https://download.pytorch.org/whl/cpu --no-cache-dir 2>&1 | tail -n 50
# Verify device
python -c "import vllm; print('vLLM version', vllm.__version__)" 2>&1 | tail -n 5 || true
python -c "import torch; print('torch', torch.__version__, 'cuda?', torch.cuda.is_available())" 2>&1 | tail -n 5 || true

# Also ensure huggingface hub
pip install -U "huggingface_hub[hf_transfer]" hf_transfer 2>&1 | tail -n 10 || true
export HF_HUB_ENABLE_HF_TRANSFER=1

# ── pre-download model (optional, speeds first boot) ──
echo "--- pre-fetch $MODEL (hf download) ---"
hf download "$MODEL" --local-dir "/opt/vllm/models/$(echo $MODEL | tr '/' '_')" 2>&1 | tail -n 20 || \
python3 -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL', local_dir='/opt/vllm/models/test')" 2>&1 | tail -n 20 || echo "download via vLLM lazy will happen on first start"

# ── systemd service ──
# CPU flags: --device cpu --dtype float32 --max-model-len 2048 --enforce-eager --swap-space 2
#  --max-model-len 2048 limits KV cache to fit 7.6GB; 4096 would OOM on 1.5B with concurrency.
#  --dtype float32 is slower but most compatible; use bfloat16 if AVX512 available (t3 has it, ~1.3x faster).
#  --enforce-eager saves ~1GB compilation cache, critical on 7.6GB.
#  --max-num-seqs 8 = multiple agents in one host: 8 concurrent RAG summarizations without OOM (continuous batching).
#  VLLM_TARGET_DEVICE=cpu is mandatory in systemd env or service fails with "Failed to infer device type"
#  (the bug seen on t3.large with Python 3.9 + no env).
sudo tee /etc/systemd/system/vllm.service >/dev/null <<EOF
[Unit]
Description=vLLM CPU (Qwen2.5-1.5B) on :$PORT — VLLM_TARGET_DEVICE=cpu
After=network.target

[Service]
User=$USER
Environment=VLLM_TARGET_DEVICE=cpu
Environment=HF_HUB_ENABLE_HF_TRANSFER=1
Environment=HF_HOME=/opt/vllm/cache
Environment=HF_HUB_ENABLE_HF_TRANSFER=1
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

echo "==> [7/7] Admin UI: create vLLM provider — TOP PRIORITY (very very fast, multi-agent)"
cat <<EOPROVIDER
# Go to https://suchanaai.tech/admin/ai → Add provider → preset "⚡ vLLM (Qwen2.5-1.5B) — EC2 services [TOP PRIORITY]"
# Or manual:
Label: vLLM (Qwen2.5-1.5B) — EC2 services
Kind: OPENAI_COMPATIBLE
Endpoint: http://3.80.188.210:8001/v1/chat/completions
Model: $MODEL
API key: (HIDDEN — self-hosted needs no key; UI hides the field automatically. If your endpoint has auth, click "My endpoint needs an API key")
# Save, then Test → should return ok ~3-7s (CPU) with २०७१ probe. Now TOP priority (sortOrder -10).

# Verify fallback chain: ai logs — hedged multi-agent race, fastest wins:
# ssh to ai host: curl -s http://localhost:8000/llm/health | jq
# Should list vllm-services with ok=true at top, activeProvider = vllm-services when it is healthy,
# otherwise liquid/groq. Race: vLLM 3s vs liquid 0.6s vs groq 0.3s — fastest healthy wins, not sequential 60s wait.
# Logs: "Hedged race won by ... — cancelling N other agent(s)"

# Speed: t3.large CPU is ~10× slower than GPU. 1.5B does ~3-7s for 1024 tokens, 0.5B ~1-2s (~0.8GB),
# 3B does ~8-15s, 7B would be ~25s (measured) and OOMs at 7.6GB. TOP priority + hedged race means:
#  - Cache hit: <5ms (5-min LRU)
#  - OpenRouter liquid primary: <600ms
#  - Groq: 0.3s
#  - vLLM 1.5B local: 3-7s but no quota/ratelimit — survives when free tiers 429
# For "very very fast" keep vLLM TOP, continuous batching (--max-num-seqs 8) handles 8 concurrent RAG
# summaries as multiple agents on one host without extra RAM.

# ── Multiple agents: add a 2nd row for same host, different model (optional) ──
# Preset "⚡ vLLM Ultra-Fast (Qwen2.5-0.5B) — 2nd agent" (same :8001, model Qwen/Qwen2.5-0.5B-Instruct)
# requires either: (a) second vLLM on :8002 (MODEL=Qwen/Qwen2.5-0.5B-Instruct VLLM_PORT=8002 ./scripts/ec2-install-vllm.sh)
# or (b) switch that host to 0.5B. Hedged race will then have 2 local agents (1.5B quality + 0.5B speed).

# ── Ollama fallback (proven CPU path, if vLLM fails to boot) ──
# If vLLM still "Failed to infer device type" after VLLM_TARGET_DEVICE=cpu fix, revert to Ollama:
#   curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b  # 986MB, ~2-4s, fits easily
#   # ollama serve on :11434, then preset "Ollama (Qwen2.5-1.5B) — EC2 self-hosted fallback"
#   # Enable it at sortOrder -9, Test → ~2-4s. Ollama proved stable on same t3.large (7b was 5.1GB but OOM on long ctx).
#   # See docs/EC2_VLLM_MIGRATION.md "Rollback"
EOPROVIDER

echo ""
echo "Done. vLLM on :$VLLM_PORT with $MODEL"
echo "Check: sudo systemctl status vllm; sudo journalctl -u vllm -f; curl http://${EC2_PUBLIC}:${VLLM_PORT}/v1/models"
