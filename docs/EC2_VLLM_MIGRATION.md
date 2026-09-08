# EC2 services: Ollama → vLLM migration (i-071d7b2debed5e3ed)

**Instance:** `i-071d7b2debed5e3ed` · `t3.large` (2 vCPU, 7.6 GiB, no GPU) · private `172.31.95.204` · public `3.80.188.210`  
**Before:** Ollama `qwen2.5:7b` at `http://172.31.95.204:11434` (public `http://3.80.188.210:11434/v1/chat/completions`, ~25s, ~14 GB needed → OOM on 7.6 GiB)  
**After:** vLLM CPU `--device cpu` with `Qwen/Qwen2.5-1.5B-Instruct` at `http://172.31.95.204:8001/v1/chat/completions` (public `http://3.80.188.210:8001/v1/chat/completions`, ~3 GB, ~3-7s on CPU)

Why the switch: `qwen2.5:7b` in fp16 is ~14 GB; t3.large has 7.6 GiB → swap thrash/OOM. vLLM CPU with 1.5B fits (<4.5 GB) and is still faster than 7B on CPU. vLLM normally targets GPU, but `--device cpu` works for small models; see <https://docs.vllm.ai/en/latest/getting_started/cpu-installation.html>.

## 1) Remove Ollama (Agent 1)

**Code:** `apps/web/components/admin/provider-dialog.tsx:63-70` preset removed (commit `b377972` reverted). No DB built-in for Ollama — it was an admin-created row.

**On EC2 (`3.80.188.210`):**
```bash
SSH_KEY=~/.ssh/ssh-key-2026-07-23.key  # or ssh-key-suchana-ai.key
chmod +x scripts/ec2-remove-ollama.sh
./scripts/ec2-remove-ollama.sh
# Or manually: see scripts/ec2-remove-ollama.sh heredoc — ollama rm, systemctl stop/disable ollama, docker rm, rm -rf /usr/share/ollama ~/.ollama, df -h
```

Verify:
```bash
curl -v --connect-timeout 5 http://3.80.188.210:11434/api/tags  # should fail — closed ✓
ssh -i $SSH_KEY ubuntu@3.80.188.210 "ss -tlnp | grep 11434 || echo closed; free -h; df -h"
```

**DB cleanup (psql on `141.148.209.235`):**
```bash
# from any host with psql:
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "SELECT slug, label, baseUrl, model FROM ai_providers WHERE slug LIKE '%ollama%' OR baseUrl LIKE '%11434%';"
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "DELETE FROM ai_providers WHERE slug = 'ollama-services';"
# sweep preset-derived slug too:
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "DELETE FROM ai_providers WHERE slug IN ('ollama-qwen2-5-7b-ec2-services','ollama') OR baseUrl LIKE '%11434%';"
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "SELECT slug, label FROM ai_providers ORDER BY sort_order;"
```
`ai_providers` has unique `slug`; deleting the row is enough — `ai_config_sync` will stop syncing it within ~3 min (`apps/ai/app/ai_config_sync.py:1`, `apps/ai/app/llm.py:335`).

**Security group:** close 11434 if it was opened:
```bash
aws ec2 describe-security-groups --group-ids sg-xxxxxxxx --query "SecurityGroups[0].IpPermissions"
aws ec2 revoke-security-group-ingress --group-id sg-xxxxxxxx --protocol tcp --port 11434 --cidr 0.0.0.0/0
```

## 2) Install vLLM CPU (Agent 2)

**Model choice for Nepali RAG, t3.large 7.6 GiB:**
| Model | Size | RAM | CPU latency (1024 tok) | Nepali quality |
|-------|------|-----|------------------------|----------------|
| `Qwen/Qwen2.5-1.5B-Instruct` **(recommended, very very fast)** | 1.5B | ~3 GB + 1.5 GB overhead | ~3-7s | good, multilingual 29 langs incl Nepali |
| `Qwen/Qwen2.5-3B-Instruct` | 3B | ~6 GB + 1.5 GB | ~8-15s | better, near limit |
| `qwen2.5:7b` (old) | 7B | ~14 GB | ~25s + OOM | best but doesn't fit |

`1.5B` is `Qwen2.5-1.5B-Instruct` (`model: Qwen/Qwen2.5-1.5B-Instruct`, 32k context). For “very very fast” on CPU it is the only option <5s. **TOP PRIORITY** (`sort_order` -10) with hedged multi-agent race, so fastest healthy wins — not sequential fallback. OpenRouter liquid 0.6s and Groq 0.3s still beat it when they have quota because the race is concurrent (see `apps/ai/app/llm.py:_llm_chat` hedged impl). vLLM survives quota exhaustion.

**Install — FIX for "Failed to infer device type" (Python 3.9 vs 3.11 + CPU platform):**
```bash
SSH_KEY=~/.ssh/ssh-key-2026-07-23.key MODEL=Qwen/Qwen2.5-1.5B-Instruct ./scripts/ec2-install-vllm.sh
# Fix applied: VLLM_TARGET_DEVICE=cpu (both pip install env and systemd Environment), Python 3.11 venv
# (deadsnakes PPA if missing), torch CPU wheel first, then vllm --extra-index-url https://download.pytorch.org/whl/cpu
# Manual steps are in scripts/ec2-install-vllm.sh: apt, python3.11 venv /opt/vllm, VLLM_TARGET_DEVICE=cpu pip install, systemd /etc/systemd/system/vllm.service
```

Key flags (`/etc/systemd/system/vllm.service`):
```
Environment=VLLM_TARGET_DEVICE=cpu  # ← fix for "Failed to infer device type"
--model Qwen/Qwen2.5-1.5B-Instruct --host 0.0.0.0 --port 8001
--device cpu --dtype auto --max-model-len 2048 --max-num-seqs 8  # 8 = multiple agents via continuous batching
--enforce-eager --swap-space 2 --served-model-name Qwen/Qwen2.5-1.5B-Instruct
```
`--max-model-len 2048` caps KV cache for 7.6 GiB; `--enforce-eager` saves ~1 GB torch compile cache; `--dtype auto` (bfloat16 on AVX512-BF16, else float32) for widest CPU compat; `--max-num-seqs 8` is multiple agents in one host via continuous batching (8 concurrent RAG summarizations).

**Security group — open 8001:**
```bash
aws ec2 describe-instances --instance-ids i-071d7b2debed5e3ed --query "Reservations[0].Instances[0].SecurityGroups"
# SG=$(aws ec2 describe-instances --instance-ids i-071d7b2debed5e3ed --query "Reservations[0].Instances[0].SecurityGroups[0].GroupId" --output text)
aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 8001 --cidr 0.0.0.0/0
# tighter: --source-group <beanstalk-api-sg> instead of 0.0.0.0/0
```

**Probes:**
```bash
# local (on EC2):
curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/v1/models | jq
curl -s http://172.31.95.204:8001/v1/models | jq

# external (public IP is NAT of private):
curl -s http://3.80.188.210:8001/health
curl -s http://3.80.188.210:8001/v1/models | jq

# chat (Devanagari probe, same as llm.py:_PROBE_PROMPT):
curl -s -X POST http://3.80.188.210:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-1.5B-Instruct","messages":[{"role":"user","content":"Reply with exactly: २०७१"}],"max_tokens":16,"temperature":0}' | jq
```

**Allowlist (critical):**
`apps/api/src/services/ai-providers.service.ts:184` (`assertSafeEndpoint`, `AI_PROVIDER_ALLOWED_HOSTS`) rejects plain-http and private IPs unless allowlisted. Set:

```bash
# Beanstalk API env (suchanaai-api-prod):
aws elasticbeanstalk update-environment --environment-name suchanaai-api-prod --region us-east-1 \
  --option-settings Namespace=aws:elasticbeanstalk:application:environment,OptionName=AI_PROVIDER_ALLOWED_HOSTS,Value=3.80.188.210
# Or EB console → Configuration → Software → Environment properties → AI_PROVIDER_ALLOWED_HOSTS=3.80.188.210 → Apply (2-3 min, t3.medium single instance)
# Local / docker-compose: echo "AI_PROVIDER_ALLOWED_HOSTS=3.80.188.210" >> apps/api/.env
```

See `apps/api/.env.example:149` comment.

**Admin UI — TOP PRIORITY, no API key field:**
`https://suchanaai.tech/admin/ai` → Add provider → preset **⚡ vLLM (Qwen2.5-1.5B) — EC2 services [TOP PRIORITY]** (`apps/web/components/admin/provider-dialog.tsx`):
- Label: `vLLM (Qwen2.5-1.5B) — EC2 services`
- Kind: `OPENAI_COMPATIBLE`
- Endpoint: `http://3.80.188.210:8001/v1/chat/completions` (private `http://172.31.95.204:8001/v1/chat/completions` is same host but not routable from Beanstalk)
- Model: `Qwen/Qwen2.5-1.5B-Instruct`
- API key: **hidden** — self-hosted endpoints (vLLM/Ollama) now hide the key field automatically (no auth header). If your endpoint needs auth, click "My endpoint needs an API key". Stored key is cleared on save for self-hosted.
→ Save → Test (expect ok, ~3-7s). The provider is `OPENAI_COMPATIBLE` so `apps/ai/app/llm.py:393` (`_key_optional`) allows no key; timeout for key-optional is 60s (`llm.py`). **Built-in `vllm-services` is now `sortOrder -10` (TOP)**, seeded in `apps/api/src/services/ai-providers.service.ts:1` and promoted on boot if a custom row already exists at -1. Multiple agents: preset **⚡ vLLM Ultra-Fast (0.5B)** and **Ollama (1.5B) fallback** are available via same dialog for hedged 2nd agent.

**Fallback order — VERY VERY FAST hedged race:** `sortOrder -10` vLLM → `-1` OpenRouter → `0` Gemini → `1` Groq → `2` Opencode → `3` Bedrock. `llm.py:_llm_chat` fires top 4 (non-Bedrock) **concurrently** via `asyncio.as_completed`; fastest non-None wins and rest are cancelled (see logs "Hedged race won by …"). Bedrock stays sequential tail to avoid cost per request. 5-min LRU cache (`_ANSWER_CACHE`) is still <5ms before any network.

**Ops:**
```bash
ssh -i $SSH_KEY ubuntu@3.80.188.210 "sudo systemctl status vllm --no-pager; sudo journalctl -u vllm -n 100 --no-pager; free -h; ss -tlnp | grep 8001"
# logs: sudo journalctl -u vllm -f
# restart: sudo systemctl restart vllm
# update model: MODEL=Qwen/Qwen2.5-3B-Instruct ./scripts/ec2-install-vllm.sh (then edit ai_providers.model)
```

**Rollback (to Ollama — proven very fast CPU fallback, qwen2.5:1.5b ~986MB ~2-4s):**
```bash
# reinstall: curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b && sudo systemctl enable --now ollama
# Alternative very very fast: ollama pull qwen2.5:0.5b (396MB, ~1-2s) as 2nd agent
# DB: admin UI preset "Ollama (Qwen2.5-1.5B) — EC2 self-hosted fallback" on :11434, or enable existing row sortOrder -9
# See scripts/ec2-remove-ollama.sh reverse and provider-dialog presets.
```

**Fix applied for "Failed to infer device type":**
- `VLLM_TARGET_DEVICE=cpu` set at pip install time and in systemd `Environment=` (required for CPU infer)
- Python 3.11 venv (`python3.11 -m venv /opt/vllm`, deadsnakes PPA if missing; 3.9 lacks CPU wheel support)
- Torch CPU wheel installed first via `https://download.pytorch.org/whl/cpu`
- Verified via `python -c "import vllm; import torch; print(torch.cuda.is_available())"` in install script

## Files changed
- `apps/web/components/admin/provider-dialog.tsx:63-70` — Ollama preset → vLLM preset (`3.80.188.210:8001`, `Qwen/Qwen2.5-1.5B-Instruct`)
- `apps/api/.env.example:148-152` — documented `AI_PROVIDER_ALLOWED_HOSTS=3.80.188.210`
- `scripts/ec2-remove-ollama.sh` — removal runbook (systemd/docker, disk, DB `DELETE ai_providers WHERE slug='ollama-services'`)
- `scripts/ec2-install-vllm.sh` — CPU install runbook (venv, vllm `--device cpu`, systemd, SG 8001, probes)
- `docs/EC2_VLLM_MIGRATION.md` — this doc
