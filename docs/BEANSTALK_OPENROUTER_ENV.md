# Change OpenRouter env on Beanstalk (suchanaai-ai-prod)

All AI env vars for `suchanaai-ai-prod` are in **Beanstalk Environment Variables** (`aws:elasticbeanstalk:application:environment`) — not `Dockerrun.aws.json`. They are read at boot `apps/ai/app/config.py:74` (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_FREE_MODELS`) and as fallback for `apps/ai/app/llm.py:298` (`_env_fallback_providers`). The **admin UI** (`/admin/ai` → `ai_providers` table `apps/api/src/services/ai-providers.service.ts:44`) **overrides** them after `~3min` via `ai_config_sync` `apps/ai/app/ai_config_sync.py:1`.

## Option A — AWS Console (search)

1. Open **https://console.aws.amazon.com** → top search bar → type **`Elastic Beanstalk`** → open **Elastic Beanstalk**.
2. **Environments (3)** → click **`suchanaai-ai-prod`** (`e-cexvrgsfq3`, `us-east-1` `N. Virginia`).
3. Left menu → **Configuration** → scroll to **Software** → **Edit**.
4. **Environment properties** → find:
   - `OPENROUTER_API_KEY` (`sk-or-v1-...`)
   - `OPENROUTER_MODEL` (`liquid/lfm-2.5-2.6b:free` ultra-fast `<600ms`)
   - `OPENROUTER_FREE_MODELS` (`google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3.5-lightning:free`)
   - `OPENROUTER_BASE_URL` (`https://openrouter.ai/api/v1/chat/completions`)
5. **Edit** the value (keep `:free` suffix for free tier, check live IDs at **https://openrouter.ai/models?max_price=0**).
6. **Apply** → `Environment update is starting` → `Instance deployment completed` → `Health Green` `Ready` (takes `2-3m`, `t3.medium` single instance, no downtime).
7. Verify: **Configuration → Software → Environment properties** shows new value, and `aws elasticbeanstalk describe-configuration-settings --application-name suchanaai --environment-name suchanaai-ai-prod --region us-east-1 --query "ConfigurationSettings[0].OptionSettings[?OptionName=='OPENROUTER_MODEL']"` returns it.

## Option B — AWS CLI (current account `917909628524`)

```bash
# 1. Check current
aws elasticbeanstalk describe-configuration-settings --application-name suchanaai --environment-name suchanaai-ai-prod --region us-east-1 --query "ConfigurationSettings[0].OptionSettings[?OptionName=='OPENROUTER_MODEL' || OptionName=='OPENROUTER_FREE_MODELS'].[OptionName,Value]" --output table

# 2. Update (ultra-fast example)
cat > /tmp/opts.json <<'JSON'
[
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"OPENROUTER_MODEL","Value":"liquid/lfm-2.5-2.6b:free"},
  {"Namespace":"aws:elasticbeanstalk:application:environment","OptionName":"OPENROUTER_FREE_MODELS","Value":"google/gemma-4-26b-a4b-it:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3.5-lightning:free"}
]
JSON
aws elasticbeanstalk update-environment --environment-name suchanaai-ai-prod --region us-east-1 --option-settings file:///tmp/opts.json
# Poll
aws elasticbeanstalk describe-environments --region us-east-1 --environment-names suchanaai-ai-prod --query "Environments[0].{Status:Status,Health:Health}" --output table
```

**Note:** `OPENROUTER_FREE_MODELS` contains commas — must use `aws:elasticbeanstalk:application:environment` separate `OptionName` per var (not `aws:cloudformation:template:parameter` `EnvironmentVariables` which splits on commas). Free tier is **account-shared** `50/day` (`1000/day` after one `$10` purchase, `20 RPM`) `https://openrouter.ai/docs/api-reference/limits` — not per-model, so `FREE_MODELS` chain helps with `404`/`capacity`, not daily quota.

## Option C — App Admin UI (overrides Beanstalk)

1. Open `https://suchanaai.tech/admin/ai` (or `https://api.suchanaai.tech` → Admin).
2. **AI & Models** → **OpenRouter** row → **Edit** → change **Model** (pick from **Load** → live free list) → **Save**.
3. Becomes `ai_providers.model` `DB` (`api_key_enc` encrypted) and is pulled by `ai` in `~3min` (`RUNTIME_PROVIDERS` `apps/ai/app/llm.py:335`). **Beanstalk env stays as fallback** if `DB` key is empty or sync fails.

## Verify ultra-fast

- Beanstalk: `aws elasticbeanstalk describe-events --environment-name suchanaai-ai-prod --region us-east-1 --max-records 5`
- AI: `curl https://api.suchanaai.tech/health` → `{"status":"ok"}` and `POST /llm/health` via `x-internal-secret` shows `OPENROUTER` `liquid` `~600ms` vs old `minimax 404`/`nemotron 12924ms`.
