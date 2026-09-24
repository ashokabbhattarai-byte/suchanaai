# Domain & Health Fix — `ap-southeast-2` Migration

**Account:** `919744496312` **Region:** `ap-southeast-2` **EB Application:** `suchanaai`

This doc fixes the two screenshots you sent.

---

## 1. EB Environment Health — Image 1 (`suchanaai-ai-prod`)

**Current:**
```
suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com (e-5ebwdykycu)
Running version: ai-prod-20260923184847-c7b4195f
Health: Warning — 1 of 1 impacted (18:51:59 UTC+5:45)
Events: Environment update completed successfully → New version deployed →
        Warning 30s later
```

**Cause:** AI downloads `intfloat/multilingual-e5-base` (~1 GB) to `/app/models` on cold start. For ~30–90s `/health` returns `{"status":"warming"}` then `ready`. With no grace period EB marks `Warning`.

**Check:**
`Elastic Beanstalk > Environments > suchanaai-ai-prod > Health & monitoring` — see instance `i-05006286002494f6a` `Causes`. `Logs > Request logs > Tail` or SSM `cat /var/log/eb-engine.log`.

**Fix (optional, not blocking):**
`Configuration > Capacity > Health check grace period = 120` > `Apply`. Or ignore — flips `Green` after warmup. Verify:
```bash
curl http://suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/health
# {"status":"ok","model_loaded":true,"phase":"ready"}
```

**Cleanup:**
`suchanaai-ai-service-prod` (`e-mfahppnkm3`) is `Grey Launching` — `t3.medium` not FreeTier (`FreeTierRestrictionError`). Terminate after `ai-prod` is `Green`:
`Environments > suchanaai-ai-service-prod > Actions > Terminate environment`.

---

## 2. Domain Management — Image 2 (`manage.get.tech`)

**Problem:** CNAMEs point to **old `us-east-1` stack** `eba-j3cvke4q.us-east-1...` not current `ap-southeast-2` `eba-mmm2ap2z...`.

| Host name | Current (wrong) | Change to |
|-----------|-----------------|-----------|
| `www` | `suchanaai-web-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` | `suchanaai-web-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` |
| `api` | `suchanaai-api-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` | `suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` |
| `ai` (add if missing) | — | `suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` |

* Keep the 3 `_xxxx` ACM validation CNAMEs (`_5dd20...`, `_502c3...`, `_b5dce...`) — they are for `suchanaai.tech` cert.

**Steps in `manage.get.tech > DNS > DNS Records > CNAME Records`:**
1. Click edit (pencil) on `www` → paste new `ap-southeast-2` value → Save.
2. Edit `api` → same.
3. `Add new record` → Type `CNAME` → Host `ai` → Value `suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` → TTL `Auto` → Save.

**Apex `suchanaai.tech` (without `www`):**
`CNAME` at apex is invalid per DNS. Go `Domain Forwarding` tab → `Add forwarding` → `suchanaai.tech` → `https://www.suchanaai.tech` `301 Permanent` → Save. Or if `get.tech` offers `A` ALIAS/Apex, set ALIAS to `suchanaai-web-prod.eba-mmm2ap2z...`.

**After DNS propagates (1–5 min):**
```bash
dig www.suchanaai.tech +short
dig api.suchanaai.tech +short
curl http://www.suchanaai.tech/api/health  # via WEB
curl http://api.suchanaai.tech/health      # {"status":"ok"}
```

**EB env vars after domain live:**
`EB > suchanaai-api-prod > Configuration > Environment properties > Edit`:
```
WEB_ORIGIN=https://www.suchanaai.tech,https://suchanaai.tech
PUBLIC_SITE_URL=https://www.suchanaai.tech
AI_SERVICE_URL=http://suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com
```
`Apply` (restarts API, ~2 min).

**Rebuild `web` with new public URLs (NEXT_PUBLIC_* are build-time at `apps/web/Dockerfile:10`):**
CodeBuild `suchanaai-build-all` uses:
```
NEXT_PUBLIC_APP_URL=https://www.suchanaai.tech
NEXT_PUBLIC_API_URL=https://api.suchanaai.tech
NEXT_PUBLIC_AI_URL=https://ai.suchanaai.tech (or http://suchanaai-ai-prod...)
```
Update `buildspec.yml` args, re-upload `s3://elasticbeanstalk-ap-southeast-2-919744496312/codebuild/suchanaai-source.zip`, `aws codebuild start-build`, then `EB > suchanaai-web-prod > Upload and deploy` new `suchanaai-web:latest` (`919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-web:latest`).

**HTTPS note:** `SingleInstance` has no ALB — `https://` will fail until you attach ACM cert. Either switch envs to `LoadBalanced` (`Configuration > Capacity > EnvironmentType`) with ACM `suchanaai.tech` cert in `ap-southeast-2`, or front with CloudFront. `http://` works after CNAME change.

**Cost cleanup (optional):**
```
suchanaai-alb-133432424.ap-southeast-2.elb.amazonaws.com (ECS ALB, unused)
suchanaai-db.c564aui0ck9g.ap-southeast-2.rds.amazonaws.com (RDS t3.micro, empty — using 141.148.209.235 per request)
```
Delete if not needed for future migration: `aws elbv2 delete-load-balancer`, `aws rds delete-db-instance --skip-final-snapshot`.

---

## 3. Current Live Endpoints (verify now)

```
WEB: http://suchanaai-web-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com (Green)
API: http://suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/health (Green)
AI:  http://suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/health (Yellow→Green)
DB:  postgresql://postgres:***@141.148.209.235:5432/public_notice_management (4655 notices)
ECR: 919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-{web,api,ai-service}:latest
Bedrock: global.anthropic.claude-haiku-4-5-20251001-v1:0 via IAM role aws-elasticbeanstalk-ec2-role (no bearer token)
```

Once DNS updated, `https://www.suchanaai.tech` serves the Next.js at `apps/web` via `suchanaai-web-prod`.
