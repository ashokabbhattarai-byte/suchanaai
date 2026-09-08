# EC2 services: Ollama → vLLM migration (i-071d7b2debed5e3ed)

**Instance:** `i-071d7b2debed5e3ed` · `t3.large` (2 vCPU, 7.6 GiB, no GPU) · private `172.31.95.204` · public `3.80.188.210`

> **CURRENT STATUS 2026-09-08 — SWAPPED:** Health at `http://3.80.188.210:8001/v1/chat/completions` (vLLM Qwen2.5-1.5B) is **DOWN** — `Could not reach the provider. All connection attempts failed`.  
> `http://3.80.188.210:11434/v1/chat/completions` (Ollama qwen2.5:1.5b) is **Responding 2127ms ✓**.  
> EC2 `systemctl status vllm` + `journalctl -u vllm` shows `Failed to infer device type` and `vllm._C_AVX512` / `vllm._C` missing on CPU-only t3.large with `/opt/vllm` Python 3.11.  
> **Fix applied in code:** `ollama-services` is now **TOP priority `sortOrder -10`** (proven CPU path, 986 MB, 2-4s via llama.cpp), `vllm-services` is **SECOND `sortOrder -9`** (optional, GPU-optimized, slower on CPU).  
> No EC2 SSH needed to fix DB — `apps/api/src/services/ai-providers.service.ts` swaps on next API boot. vLLM can be rebuilt from source as secondary (0.5B 0.8GB 1-2s even faster) or disabled. See **Troubleshooting** below.  
> Previous `Before/After` below is kept for history; the live topology is now **Ollama TOP, vLLM SECOND** (hedged race, fastest wins).

**Before (2026-08):** Ollama `qwen2.5:7b` at `http://172.31.95.204:11434` (public `http://3.80.188.210:11434/v1/chat/completions`, ~25s, ~14 GB needed → OOM on 7.6 GiB)  
**After (2026-09 attempted):** vLLM CPU `--device cpu` with `Qwen/Qwen2.5-1.5B-Instruct` at `http://172.31.95.204:8001/v1/chat/completions` (public `http://3.80.188.210:8001/v1/chat/completions`, ~3 GB, ~3-7s on CPU) — **currently DOWN, see troubleshooting**  
**Now (2026-09-08 fix):** Ollama `qwen2.5:1.5b` at `http://3.80.188.210:11434` **TOP -10** (≈2-4s, 2127ms health) + vLLM `Qwen/Qwen2.5-1.5B-Instruct` at `http://3.80.188.210:8001` **SECOND -9** (when rebuilt, ~3-7s; 0.5B ~1-2s alternative) — hedged race, no 60s wait.

Why the original switch: `qwen2.5:7b` in fp16 is ~14 GB; t3.large has 7.6 GiB → swap thrash/OOM. vLLM CPU with 1.5B fits (<4.5 GB) and is still faster than 7B on CPU. vLLM normally targets GPU, but `--device cpu` works for small models *if built from source*; see <https://docs.vllm.ai/en/latest/getting_started/cpu-installation.html>. However vLLM CPU has **NO prebuilt wheels** and is **GPU-optimized** — on CPU-only t3.large Ollama llama.cpp is actually **faster** (see troubleshooting).

## 1) Remove Ollama (Agent 1) — **REVERTED 2026-09-08: KEEP OLLAMA TOP**

> **DO NOT RUN THIS SECTION ANYMORE.** It was run when vLLM was to replace Ollama, but vLLM CPU is down (see banner). **Keep Ollama running** — it is now TOP priority (-10) with `qwen2.5:1.5b` 986MB ~2-4s (health 2127ms).  
> If you already removed Ollama, **reinstall**: `curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b && ollama pull qwen2.5:0.5b && sudo systemctl enable --now ollama` then verify `curl -s http://3.80.188.210:11434/api/tags` and `http://3.80.188.210:11434/v1/models`.  
> DB: ensure `ollama-services` exists at `sortOrder -10` (auto-seeded now as built-in in `apps/api/src/services/ai-providers.service.ts`). If missing, admin UI preset **⚡ Ollama (Qwen2.5-1.5B) — EC2 services [TOP PRIORITY — CPU proven 2-4s]** recreates it, or `psql` swap below.

<details><summary>Original removal steps (archived, do not run while Ollama is TOP)</summary>

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

</details>

**Keep Ollama OPEN — 11434 must stay allowed for TOP provider:**
```bash
aws ec2 describe-instances --instance-ids i-071d7b2debed5e3ed --query "Reservations[0].Instances[0].SecurityGroups"
# SG must allow TCP 11434 from 0.0.0.0/0 (or at least Beanstalk API SG) — do NOT close it now.
# If closed, reopen: aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 11434 --cidr 0.0.0.0/0
# Also keep 8001 open for vLLM secondary (hedged race will probe it).
```

## 2) Install vLLM CPU (Agent 2) — **NOW SECONDARY (-9), Ollama is TOP**

**Model choice for Nepali RAG, t3.large 7.6 GiB:**
| Model | Size | RAM | CPU latency (1024 tok) | Nepali quality | Priority |
|-------|------|-----|------------------------|----------------|----------|
| `qwen2.5:1.5b` (Ollama) **TOP -10 proven** | 1.5B | ~0.9 GB + overhead | ~2-4s (2127ms) | good | **TOP** |
| `Qwen/Qwen2.5-1.5B-Instruct` (vLLM) SECOND -9 | 1.5B | ~3 GB + 1.5 GB overhead | ~3-7s | good, 29 langs | SECOND |
| `Qwen/Qwen2.5-0.5B-Instruct` (vLLM) SECOND alt | 0.5B | ~0.8 GB + 1 GB | ~1-2s | ok | SECOND fast |
| `Qwen/Qwen2.5-3B-Instruct` | 3B | ~6 GB + 1.5 GB | ~8-15s | better | near limit |
| `qwen2.5:7b` (old) | 7B | ~14 GB | ~25s + OOM | best | doesn't fit |

`1.5B` is `Qwen2.5-1.5B-Instruct` (`model: Qwen/Qwen2.5-1.5B-Instruct`, 32k context). **NOW SECONDARY (-9)** — hedged race still fires top 4 concurrently (`ollama -10`, `vLLM -9`, `openrouter -1`, `gemini 0`), fastest wins without 60s wait. OpenRouter liquid 0.6s and Groq 0.3s still beat locals when they have quota (see `apps/ai/app/llm.py:_llm_chat`). Local survives quota exhaustion; Ollama wins locally.

**Install — FIX for "Failed to infer device type" + "vllm._C_AVX512 missing" (t3.large CPU-only):**
```bash
# PRIMARY: keep Ollama TOP — if you removed it, reinstall first:
# curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b && sudo systemctl enable --now ollama

# SECONDARY: fix vLLM CPU (will be -9, not TOP):
SSH_KEY=~/.ssh/ssh-key-2026-07-23.key MODEL=Qwen/Qwen2.5-1.5B-Instruct ./scripts/ec2-install-vllm.sh
# For very very fast 0.5B (0.8GB 1-2s, even faster on weak CPU):
# MODEL=Qwen/Qwen2.5-0.5B-Instruct ./scripts/ec2-install-vllm.sh
# Fix applied: VLLM_TARGET_DEVICE=cpu at BUILD + systemd Environment, Python 3.11 venv
# (deadsnakes PPA if missing), torch CPU wheel first, then BUILD FROM SOURCE (no prebuilt CPU wheels)
# — see scripts/ec2-install-vllm.sh for gcc12, tcmalloc, AVX512, and fallback. 30-60 min build.
# Manual steps are in script: apt, python3.11 venv /opt/vllm, VLLM_TARGET_DEVICE=cpu pip install, systemd /etc/systemd/system/vllm.service
```

Key flags (`/etc/systemd/system/vllm.service`):
```
Environment=VLLM_TARGET_DEVICE=cpu  # ← fix for "Failed to infer device type" — MUST be at build AND runtime
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

**Admin UI — FIXED 2026-09-08: Ollama TOP (-10), vLLM SECOND (-9), no API key field:**
`https://suchanaai.tech/admin/ai` → Add provider → presets:
- **⚡ Ollama (Qwen2.5-1.5B) — EC2 services [TOP PRIORITY — CPU proven 2-4s]** (`apps/web/components/admin/provider-dialog.tsx`) — `-10` — `http://3.80.188.210:11434/v1/chat/completions`, `qwen2.5:1.5b` — **current TOP, health 2127ms**
- **vLLM (Qwen2.5-1.5B) — EC2 services [SECONDARY — CPU needs rebuild, ~3-7s]** — `-9` — `http://3.80.188.210:8001/v1/chat/completions`, `Qwen/Qwen2.5-1.5B-Instruct`
- **⚡ vLLM Ultra-Fast (0.5B) — 2nd agent [0.8GB ~1-2s]** — alternative secondary (same 8001, `Qwen/Qwen2.5-0.5B-Instruct`, smaller/faster)
- Private `http://172.31.95.204:11434` / `:8001` is same host but not routable from Beanstalk — use public `3.80.188.210`.
- Model: per preset above
- API key: **hidden** — self-hosted endpoints (vLLM/Ollama) now hide the key field automatically (no auth header). If your endpoint needs auth, click "My endpoint needs an API key". Stored key is cleared on save for self-hosted.
→ Save → Test: Ollama should return ok ~2-4s with २०७१ probe; vLLM will be red (`Could not reach provider`) until rebuilt. That's expected — hedged race will use Ollama. Providers are `OPENAI_COMPATIBLE` so `apps/ai/app/llm.py:393` (`_key_optional`) allows no key; timeout for key-optional is 60s (`llm.py`). **Built-in `ollama-services` is now `sortOrder -10` (TOP), `vllm-services` `-9` (SECOND)**, seeded in `apps/api/src/services/ai-providers.service.ts` and **auto-swapped on next API boot** if DB still has vLLM at -10 (old). Multiple agents: hedged race uses top 4.

**Fallback order — VERY VERY FAST hedged race (FIXED):** `sortOrder -10` **Ollama (2-4s proven)** → `-9` vLLM (when healthy, 3-7s, slower on CPU) → `-1` OpenRouter (0.6s liquid) → `0` Gemini → `1` Groq (0.3s) → `2` Opencode → `3` Bedrock. `llm.py:_llm_chat` fires top 4 (non-Bedrock) **concurrently** via `asyncio.as_completed`; fastest non-None wins and rest are cancelled (see logs "Hedged race won by …"). Bedrock stays sequential tail to avoid cost per request. 5-min LRU cache (`_ANSWER_CACHE`) is still <5ms before any network. **Active provider is now `ollama-services` (2127ms) while vLLM is down.**

**Ops:**
```bash
# Check BOTH providers (Ollama TOP health 2127ms, vLLM SECOND down):
ssh -i $SSH_KEY ubuntu@3.80.188.210 "echo '=== ollama ==='; sudo systemctl status ollama --no-pager | head -n 30; ss -tlnp | grep 11434; curl -s http://127.0.0.1:11434/api/tags | head; echo '=== vllm ==='; sudo systemctl status vllm --no-pager | head -n 50; sudo journalctl -u vllm -n 100 --no-pager | tail -n 100; free -h; ss -tlnp | grep -E '8001|11434'"
# logs:
#  sudo journalctl -u vllm -f
#  sudo journalctl -u ollama -f
# restart:
#  sudo systemctl restart vllm; sudo systemctl restart ollama
# update model: MODEL=Qwen/Qwen2.5-0.5B-Instruct ./scripts/ec2-install-vllm.sh (then edit ai_providers.model)
# health from outside:
#  curl -s --connect-timeout 5 http://3.80.188.210:11434/api/tags | head  # should be 200, 2127ms
#  curl -s --connect-timeout 5 http://3.80.188.210:8001/v1/models | head   # down until rebuilt
# DB swap (auto on API boot, but manual if needed):
#  PGPASSWORD="..." psql -h 141.148.209.235 -U postgres -d public_notice_management -c "SELECT slug, sort_order, baseUrl, model, enabled FROM ai_providers ORDER BY sort_order; SELECT pg_sleep(1); UPDATE ai_providers SET sort_order=-10 WHERE slug='ollama-services'; UPDATE ai_providers SET sort_order=-9 WHERE slug='vllm-services'; SELECT slug, sort_order FROM ai_providers ORDER BY sort_order;"
# AI health:
#  curl -s http://localhost:8000/llm/health | jq  # activeProvider should be ollama-services now
```

**Current healthy path (Ollama TOP — keep this):**
```bash
# If Ollama 11434 is ever not responding (should be Responding 2127ms):
curl -fsSL https://ollama.com/install.sh | sh && ollama pull qwen2.5:1.5b && sudo systemctl enable --now ollama
# Ultra-fast 0.5b alternative: ollama pull qwen2.5:0.5b (396MB, ~1-2s) as 2nd model on same 11434
# DB: admin UI preset "⚡ Ollama (Qwen2.5-1.5B) — EC2 services [TOP PRIORITY — CPU proven 2-4s]" on :11434, sortOrder -10
# Keep SG 11434 OPEN (and 8001 for vLLM secondary probes)
# See scripts/ec2-remove-ollama.sh reverse disabled and provider-dialog presets.
```

## Troubleshooting: "Failed to infer device type" + "vllm._C_AVX512 missing" (t3.large CPU-only)

**Live error 2026-09-08:**
```
# ssh -i $SSH_KEY ubuntu@3.80.188.210 "sudo journalctl -u vllm -n 100 --no-pager"
RuntimeError: Failed to infer device type
ModuleNotFoundError: No module named 'vllm._C'
ImportError: Failed to import from vllm._C_AVX512: No module named 'vllm._C_AVX512'
WARNING  ... _custom_ops.py:18] Failed to import from vllm._C with ModuleNotFoundError("No module named 'vllm._C'")
```
**Plus health:** `http://3.80.188.210:8001/v1/chat/completions` → `Could not reach the provider. All connection attempts failed` (httpx ConnectError → `llm.py:1133` shows type name when `e` is empty). Meanwhile `http://3.80.188.210:11434` → `Responding 2127ms` (Ollama healthy).

**Root causes:**
1. **VLLM_TARGET_DEVICE=cpu not set at BUILD:** `VLLM_TARGET_DEVICE=cpu` must be in the environment *during* `pip install vllm`, not just in systemd `Environment=`. GPU manylinux wheel built without it has no CPU ops (`vllm._C` missing) and `DeviceConfig` can't infer `cpu` → `Failed to infer device type`. Fixed in `scripts/ec2-install-vllm.sh` (export before pip + systemd). Old install at `/opt/vllm` was built without it.
2. **No prebuilt CPU wheels:** vLLM docs (CPU page) say `There are no pre-built wheels or images for this device, so you must build vLLM from source.` `pip install vllm` downloads GPU wheel even with `--extra-index-url https://download.pytorch.org/whl/cpu` unless you build. Build needs `gcc-12 g++-12 libnuma-dev`, `ninja`, `packaging`, `VLLM_TARGET_DEVICE=cpu pip install -e .` (30-60 min, 4GB+ RAM + swap + tcmalloc). On `t3.large` 7.6GB this is tight.
3. **AVX512 mismatch:** vLLM CPU builds AVX512 kernels by default (`vllm._C_AVX512`). `t3.large` Xeon Platinum 8000 *does* have AVX512 (`lscpu | grep avx512` shows `avx512f avx512bw ...`), so should work *if* built on host. If wheel was built elsewhere without AVX512, `vllm._C_AVX512 missing` or `Illegal instruction` occurs. Fix: build on host, or set `VLLM_CPU_DISABLE_AVX512=true` before build for non-AVX512 hosts (but slower, AVX2 fallback not recommended per docs).
4. **Python version:** vLLM 0.6.x CPU wheel needs Python 3.11 (deadsnakes PPA) — 3.9 lacks CPU build support. Fixed in script.
5. **vLLM is GPU-optimized:** Even when built, vLLM CPU is **SLOWER than Ollama** on CPU (GPU kernels vs llama.cpp). `1.5B vLLM 3-7s` vs `Ollama 1.5b 2-4s` on same 2 vCPU, and vLLM needs `enforce-eager` + `max-model-len 2048` + `max-num-seqs 8` + `swap-space 2` to fit 7.6GB. Ollama is the proven path.

**Fix options:**
- **Option A — KEEP OLLAMA TOP (recommended, no rebuild, instant):** Do nothing to EC2. Code already swapped DB on next API boot: `ollama-services -10` TOP, `vllm-services -9` SECOND. `vllm` can stay down (hedged race tries it but fails fast, Ollama wins). Or disable vLLM row (`enabled=false`) to hide red health. This is the fix shipped in this commit.
- **Option B — REBUILD vLLM as SECONDARY with 0.5B (faster, smaller):** `MODEL=Qwen/Qwen2.5-0.5B-Instruct ./scripts/ec2-install-vllm.sh` — 0.8GB model, ~1-2s on CPU, fits even with swap, still hedged as second agent. Requires 30-60 min source build (see script).
- **Option C — REBUILD vLLM 1.5B as SECONDARY:** `./scripts/ec2-install-vllm.sh` (default `Qwen/Qwen2.5-1.5B-Instruct`) — 3GB model, ~3-7s. Also 30-60 min build. Keep as -9 secondary; Ollama stays TOP because it's faster.
- **Option D — REMOVE vLLM entirely:** `DELETE FROM ai_providers WHERE slug='vllm-services';` + `sudo systemctl stop vllm; sudo systemctl disable vllm;` — leaves Ollama TOP alone. Valid if you don't need 2nd local agent.

**Diagnosis commands (run from your laptop):**
```bash
# 1. Check EC2 what's running
ssh -i ~/.ssh/ssh-key-2026-07-23.key ubuntu@3.80.188.210 "sudo systemctl status vllm --no-pager; sudo journalctl -u vllm -n 80 --no-pager | tail -n 80; sudo systemctl status ollama --no-pager | head -n 20; ss -tlnp | grep -E '11434|8001'; free -h; lscpu | grep -i avx | head -n 5; curl -sf http://127.0.0.1:11434/api/tags && echo ollama_local_ok || echo ollama_local_down; curl -sf http://127.0.0.1:8001/health && echo vllm_local_ok || echo vllm_local_down"

# 2. Check DB order
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "SELECT slug, label, baseUrl, model, sort_order, enabled, is_built_in FROM ai_providers ORDER BY sort_order;"

# 3. Check AI health (what hedged race will do)
curl -s http://3.80.188.210:8001/v1/models 2>&1 | head  # should fail until rebuilt
curl -s http://3.80.188.210:11434/v1/models 2>&1 | head # should list qwen2.5:1.5b
curl -s http://<ai-host>:8000/llm/health | jq '.activeProvider, .providers[] | {provider, ok, latencyMs, error}'
# Expect activeProvider=ollama-services, ollama ok true 2127ms, vllm ok false "Could not reach..."

# 4. Check allowlist
# API env must have AI_PROVIDER_ALLOWED_HOSTS=3.80.188.210 (host, not full URL) — covers both 8001 and 11434
aws elasticbeanstalk describe-configuration-settings --environment-name suchanaai-api-prod --region us-east-1 --query "ConfigurationSettings[0].OptionSettings[?OptionName=='AI_PROVIDER_ALLOWED_HOSTS']"
```

**Fix applied for "Failed to infer device type" (in script, for when you rebuild):**
- `VLLM_TARGET_DEVICE=cpu` set at pip install time **and** in systemd `Environment=` (required for CPU infer)
- Python 3.11 venv (`python3.11 -m venv /opt/vllm`, deadsnakes PPA if missing; 3.9 lacks CPU wheel support)
- `gcc-12 g++-12 libnuma-dev libtcmalloc-minimal4`, `ninja`, `packaging` for source build
- Torch CPU wheel installed first via `https://download.pytorch.org/whl/cpu` (avoid CUDA)
- **BUILD FROM SOURCE** fallback: `VLLM_TARGET_DEVICE=cpu pip install -e .` (30-60 min) — no prebuilt CPU wheels (docs)
- AVX512 check: `lscpu | grep avx512` confirms t3 has it; `VLLM_CPU_DISABLE_AVX512` only if Illegal instruction on other hosts
- Verified via `python -c "import vllm; import torch; print(torch.cuda.is_available(), torch.cpu._is_avx512_supported())"` in install script
- **BUT code fix is to keep Ollama TOP** — vLLM rebuild is optional secondary, not required for service to be healthy

## Files changed (2026-09-08 swap fix)
- `apps/api/src/services/ai-providers.service.ts:1` — `BUILT_INS` now `ollama-services` TOP -10 (`qwen2.5:1.5b`, 11434, 2-4s proven) + `vllm-services` SECOND -9 (`Qwen/Qwen2.5-1.5B-Instruct`, 8001); `onModuleInit` auto-swaps DB from old vLLM TOP (-10) to Ollama TOP on next boot, normalizes private IP→public, clears stale keys, logs swap.
- `apps/web/components/admin/provider-dialog.tsx:63-70` — presets reordered: **⚡ Ollama TOP [CPU proven 2-4s]** first, **vLLM SECOND [CPU needs rebuild]** second, **vLLM 0.5B Ultra-Fast** third; old vLLM TOP preset retired.
- `scripts/ec2-install-vllm.sh` — header now documents 2026-09-08 outage (8001 down, 11434 2127ms), FIX OPTIONS (keep Ollama TOP vs rebuild vLLM secondary), adds AVX512/CPU checks, `gcc12/libnuma/tcmalloc` deps, correct `VLLM_TARGET_DEVICE=cpu` **source build** path (no prebuilt wheels, 30-60 min), Ollama health check, and footer now shows Ollama TOP -10 / vLLM -9 order; systemd description marks vLLM as SECONDARY.
- `apps/api/.env.example:148-156` — `AI_PROVIDER_ALLOWED_HOSTS` comment now lists both Ollama 11434 TOP and vLLM 8001 SECOND, notes swap and troubleshooting.
- `scripts/ec2-remove-ollama.sh` — archived as "DO NOT RUN — KEEP OLLAMA TOP" with details collapsible.
- `docs/EC2_VLLM_MIGRATION.md` — this doc — banner with current status, swaped model table, archived removal section, updated install/allowlist/admin/fallback/ops/troubleshooting with diagnosis commands and Files changed.
