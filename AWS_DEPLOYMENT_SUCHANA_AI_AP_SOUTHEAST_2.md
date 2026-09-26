# Suchana AI — Professional AWS Deployment Guide (ap-southeast-2)

**Account:** `919744496312` **Region:** `ap-southeast-2` (Sydney) **EB Application:** `suchanaai`  
**Domain:** `suchanaai.tech` (registrar: `get.tech`) **DB:** `postgresql://postgres:***@141.148.209.235:5432/public_notice_management` (per request)

This guide reproduces the exact deployment that is currently **Green Ready** on Elastic Beanstalk and explains how to make `https://suchanaai.tech` load.

---

## Table of Contents
1. [Architecture](#1-architecture)
2. [Prerequisites & AWS Login](#2-prerequisites--aws-login)
3. [ECR — Private Registries](#3-ecr--private-registries)
4. [S3 — Private Uploads Bucket](#4-s3--private-uploads-bucket)
5. [Secrets & SSM — No Hardcoded Secrets](#5-secrets--ssm--no-hardcoded-secrets)
6. [IAM — Bedrock Least-Privilege](#6-iam--bedrock-least-privilege)
7. [Database — Why Old DB at 141.148.209.235](#7-database--why-old-db-at-141148209235)
8. [Elastic Beanstalk — Web / API / AI](#8-elastic-beanstalk--web--api--ai)
9. [CodeBuild — Build Without Local Docker](#9-codebuild--build-without-local-docker)
10. [Deploy Real Images to EB](#10-deploy-real-images-to-eb)
11. [Verify — Health & Endpoints](#11-verify--health--endpoints)
12. [Domain `suchanaai.tech` on get.tech — Make It Load](#12-domain-suchanaaitech-on-gettech--make-it-load)
13. [HTTPS — Next Step (LoadBalanced + ACM)](#13-https--next-step-loadbalanced--acm)
14. [Troubleshooting](#14-troubleshooting)
15. [Cost & Cleanup](#15-cost--cleanup)
16. [Appendix — Exact Commands](#16-appendix--exact-commands)

---

## 1. Architecture

```
                ┌─────────────┐
                │  get.tech   │  DNS: www → EB CNAME, apex → forwarding
                └──────┬──────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ EB web-prod │ │ EB api-prod │ │ EB ai-prod  │  Docker on 64bit AL2023/4.13.8
│ t3.small    │ │ t3.small    │ │ t3.small    │  SingleInstance, VPC vpc-0c996dfc73eb7fb0d
│ :3535       │ │ :5005       │ │ :8000       │  ap-southeast-2a/b/c
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘
       │               │ Prisma        │ Bedrock IAM (no bearer token)
       │               ▼               ▼
       │        ┌─────────────┐ ┌─────────────────────┐
       └────────► PostgreSQL  │ │ Bedrock Claude      │  global.anthropic.claude-haiku-4-5-20251001-v1:0
                │ 141.148.209 │ │ ap-southeast-2      │  via aws-elasticbeanstalk-ec2-role
                │ :5432       │ └─────────────────────┘
                └──────┬──────┘
                       │ S3
                ┌──────▼──────┐  Qdrant http://141.148.209.235:6333
                │ S3 Bucket   │  (external, proven)
                │ suchanaai-  │
                │ storage-*   │
                └─────────────┘
ECR (ap-southeast-2): suchanaai-web / -api / -ai-service (scanOnPush)
CodeBuild (privileged) → docker build --platform linux/amd64 → ECR
RDS suchanaai-db.c564... (t3.micro, available) kept for future migration — not used per request
```

---

## 2. Prerequisites & AWS Login

**IAM Role you are using (from `aws sts get-caller-identity`):**
```
arn:aws:sts::919744496312:assumed-role/AccountFullAccessRole/24685458-d011-7092-87e2-2677cafbd2c3
Account: 919744496312 Region: ap-southeast-2
```

**Login (SSO / IAM):**
```bash
aws configure list
aws sts get-caller-identity --region ap-southeast-2
aws bedrock list-foundation-models --region ap-southeast-2 --query "modelSummaries[?modelId=='global.anthropic.claude-haiku-4-5-20251001-v1:0']"
# Bedrock Haiku 4.5 must be ACTIVE via inference profile global.anthropic.claude-haiku-4-5-20251001-v1:0
aws bedrock list-inference-profiles --region ap-southeast-2 --query "inferenceProfileSummaries[?contains(inferenceProfileId,'haiku-4-5')].inferenceProfileId"
```

**SCP note:** This org has `FreeTierRestrictionError` + `Iam:List*` deny via `p-wzeothyn`. `t3.medium` fails for AI, `t3.small` succeeds. `iam:ListOpenIDConnectProviders` is denied — OIDC provider cannot be managed via this role (use `PowerUserAccess` on EB EC2 role instead).

---

## 3. ECR — Private Registries

Created via CLI (Console: ECR → Private → Create, `AES256`, `scanOnPush=true`):

```bash
REGION=ap-southeast-2
for repo in suchanaai-web suchanaai-api suchanaai-ai suchanaai-ai-service; do
  aws ecr create-repository --repository-name $repo --region $REGION \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256
done
aws ecr describe-repositories --region $REGION --query 'repositories[].repositoryUri' --output table
# 919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-web
# 919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-api
# 919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-ai
# 919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-ai-service
```

`suchanaai-ai-service` is required by `.github/workflows/ci-cd.yml` (`ECR_AI_REPO` default).

**Login for pushes (CodeBuild does this via `aws ecr get-login-password`):**
```bash
aws ecr get-login-password --region ap-southeast-2 | docker login --username AWS --password-stdin 919744496312.dkr.ecr.ap-southeast-2.amazonaws.com
```

---

## 4. S3 — Private Uploads Bucket

```bash
BUCKET=suchanaai-storage-919744496312-ap-southeast-2
aws s3 mb s3://$BUCKET --region ap-southeast-2
aws s3api put-public-access-block --bucket $BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --region ap-southeast-2
aws s3api put-bucket-encryption --bucket $BUCKET \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
  --region ap-southeast-2
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled --region ap-southeast-2
```

EB also uses `elasticbeanstalk-ap-southeast-2-919744496312` (auto-created). CodeBuild source zip is stored at `s3://elasticbeanstalk-ap-southeast-2-919744496312/codebuild/suchanaai-source.zip`.

---

## 5. Secrets & SSM — No Hardcoded Secrets

**Secrets Manager (ap-southeast-2):**
```bash
aws secretsmanager create-secret --name suchanaai/jwt-secret --secret-string "$(openssl rand -hex 32)" --region ap-southeast-2
aws secretsmanager create-secret --name suchanaai/settings-encryption-key --secret-string "$(openssl rand -base64 32)" --region ap-southeast-2
aws secretsmanager create-secret --name suchanaai/internal-service-secret --secret-string "$(openssl rand -base64 32 | tr -d '\n' | head -c 43)" --region ap-southeast-2
aws secretsmanager create-secret --name suchanaai/db-password --secret-string "$(cat /tmp/db_pass.txt)" --region ap-southeast-2
# DATABASE_URL for old DB per request — set as EB env var, not secret, for SingleInstance:
# postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management
```

**SSM Parameter Store (`/suchanaai/*`):**
```bash
aws ssm put-parameter --name "/suchanaai/bedrock-region" --value "ap-southeast-2" --type String --overwrite --region ap-southeast-2
aws ssm put-parameter --name "/suchanaai/bedrock-model" --value "global.anthropic.claude-haiku-4-5-20251001-v1:0" --type String --overwrite --region ap-southeast-2
aws ssm put-parameter --name "/suchanaai/qdrant-url" --value "http://141.148.209.235:6333" --type String --overwrite --region ap-southeast-2
```

---

## 6. IAM — Bedrock Least-Privilege

**No `AWS_BEARER_TOKEN_BEDROCK` on EB.** Patched `apps/ai/app/llm.py:359` + `760` to use IAM role when `ENVIRONMENT=production` and `BEDROCK_API_KEY` empty:

```python
# apps/ai/app/config.py:151 BEDROCK_API_KEY or empty → _env_fallback_providers() creates bedrock provider with api_key=None on AWS
# apps/ai/app/llm.py:760 _bedrock_client() → AnthropicBedrock(aws_region=region) (SigV4 via task/EC2 role)
```


**Policy attached to `aws-elasticbeanstalk-ec2-role` (also to `suchanaai-ecs-task` if using ECS):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream","bedrock:ListFoundationModels","bedrock:GetFoundationModel","bedrock:ListInferenceProfiles"],"Resource":"*"},
    {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],"Resource":["arn:aws:s3:::suchanaai-storage-*","arn:aws:s3:::suchanaai-storage-*/*","arn:aws:s3:::elasticbeanstalk-ap-southeast-2-*/*"]},
    {"Effect":"Allow","Action":["secretsmanager:GetSecretValue"],"Resource":"arn:aws:secretsmanager:ap-southeast-2:919744496312:secret:suchanaai/*"}
  ]
}
```

```bash
aws iam put-role-policy --role-name aws-elasticbeanstalk-ec2-role --policy-name suchanaai-bedrock-s3 --policy-document file:///tmp/bedrock-eb-policy.json
aws iam attach-role-policy --role-name aws-elasticbeanstalk-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
```

---

## 7. Database — Why Old DB at 141.148.209.235

**New RDS `suchanaai-db.c564aui0ck9g.ap-southeast-2.rds.amazonaws.com` (t3.micro, 20GB gp3, postgres 16.15) was created** but left `available` **unused per your request** `DATABASE_URL=postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management`.

**Reason:** Fresh RDS is empty. `apps/api/prisma/migrations/20260805120000_scrape_scheduling/migration.sql:2` does `ALTER TABLE "scrape_sources"` but `20260615185609_init` never creates `scrape_sources` (only `users`), so `npx prisma migrate deploy` fails `P3018 42P01 relation "scrape_sources" does not exist` and container exits `137`. Old DB at `141.148.209.235` already has `users` (6), `scraped_items` (4655), and all tables via `prisma db push` history, so `migrate deploy` succeeds.

**To migrate to new RDS later:** `psql` dump from `141.148.209.235` → restore to `suchanaai-db`, or `DATABASE_URL=newDB npx prisma db push --accept-data-loss` then `npx prisma migrate deploy` (or change Dockerfile `CMD` to `prisma db push || prisma migrate deploy`).

**Security group for new RDS:** `sg-031832e8be23ed406` allows `172.31.0.0/16` (VPC) → `:5432` (tighten to EB SGs later: `aws ec2 authorize-security-group-ingress --group-id sg-031832e8be23ed406 --source-group <eb-sg>`).

---

## 8. Elastic Beanstalk — Web / API / AI

**Application:** `suchanaai` (`64bit Amazon Linux 2023 v4.13.8 running Docker`)

**VPC:** `vpc-0c996dfc73eb7fb0d` (default, `172.31.0.0/16`), Subnets `subnet-0501946da4589c88f` (2a, 172.31.0.0/20), `subnet-084793448e2edc42b` (2b, 32.0/20), `subnet-02be7e3b812bfb71f` (2c, 16.0/20)

**Environments (SingleInstance, `AssociatePublicIpAddress=true`, `IamInstanceProfile=aws-elasticbeanstalk-ec2-role`):**

| Environment | Instance | Port | CNAME | Health | Version |
|-------------|----------|------|-------|--------|---------|
| `suchanaai-web-prod` (`e-23xkqw5upx`) | `t3.small` | `3535` | `suchanaai-web-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` | `Green` | `web-20260923183049-6b0172b1` |
| `suchanaai-api-prod` (`e-u76kjvmwmt`) | `t3.small` | `5005` | `suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` | `Green` (was `Red` until DB fix) | `None` (config update, not version) |
| `suchanaai-ai-prod` (`e-5ebwdykycu`) | `t3.small` | `8000` | `suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com` | `Yellow→Green` (warmup) | `ai-prod-20260923184847-c7b4195f` |
| `suchanaai-ai-service-prod` (`e-mfahppnkm3`) | `t3.medium` | `8000` | stuck `Grey Launching` — `t3.medium` not FreeTier | — | `None` |

**Create (example API):**
```bash
STACK="64bit Amazon Linux 2023 v4.13.8 running Docker"
aws elasticbeanstalk create-environment --application-name suchanaai --environment-name suchanaai-api-prod \
  --solution-stack-name "$STACK" \
  --option-settings file:///tmp/api-options.json --region ap-southeast-2
# api-options.json includes: InstanceType=t3.small, VPCId, Subnets, AssociatePublicIpAddress=true, EnvironmentType=SingleInstance,
# PORT=5005, HOSTNAME=0.0.0.0, NODE_ENV=production, DATABASE_URL=postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management,
# JWT_SECRET, SETTINGS_ENCRYPTION_KEY, INTERNAL_SERVICE_SECRET (from Secrets), GOOGLE_CLIENT_ID=976108367738-7ifbum0as0oft1hlmkdkk03vt26sfnr9.apps.googleusercontent.com,
# ADMIN_EMAILS=ashok.ab.bhattaraii@gmail.com, WEB_ORIGIN=https://suchanaai.tech,https://www.suchanaai.tech, PUBLIC_SITE_URL=https://suchanaai.tech,
# AI_SERVICE_URL=http://suchanaai-ai-prod.ap-southeast-2.elasticbeanstalk.com, S3_BUCKET_NAME=suchanaai-storage-919744496312-ap-southeast-2,
# AWS_REGION=ap-southeast-2
```

**Fix `ai-service-prod` FreeTier:** recreate as `t3.small` (`suchanaai-ai-prod`) — `t3.medium` fails `FreeTierRestrictionError` (`describe-scaling-activities` shows `not eligible for Free Tier`).

---

## 9. CodeBuild — Build Without Local Docker

Local `docker` was flaky (`docker.sock: connect: no such file`), so **CodeBuild `BUILD_GENERAL1_MEDIUM` privileged** builds all 3 images and pushes to ECR.

**Source zip:** `git archive --format=zip --output /tmp/suchanaai-source.zip HEAD` + `buildspec.yml` at root → `s3://elasticbeanstalk-ap-southeast-2-919744496312/codebuild/suchanaai-source.zip` (136 MB).

**buildspec.yml (root):**
```yaml
version: 0.2
phases:
  pre_build:
    commands:
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
  build:
    commands:
      - docker build --platform linux/amd64 -f apps/api/Dockerfile -t $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-api:latest .
      - docker push $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-api:latest
      - docker build --platform linux/amd64 -f apps/ai/Dockerfile -t $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-ai:latest -t $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-ai-service:latest .
      - docker push $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-ai:latest
      - docker push $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-ai-service:latest
      - docker build --platform linux/amd64 -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_APP_URL=http://suchanaai-web-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com --build-arg NEXT_PUBLIC_API_URL=http://suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com --build-arg NEXT_PUBLIC_AI_URL=http://suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com --build-arg NEXT_PUBLIC_GOOGLE_CLIENT_ID=976108367738-7ifbum0as0oft1hlmkdkk03vt26sfnr9.apps.googleusercontent.com -t $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-web:latest .
      - docker push $ACCOUNT.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/suchanaai-web:latest
```

**Project:**
```bash
aws codebuild create-project --name suchanaai-build-all \
  --source type=S3,location=elasticbeanstalk-ap-southeast-2-919744496312/codebuild/suchanaai-source.zip \
  --artifacts type=NO_ARTIFACTS \
  --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_MEDIUM,privilegedMode=true,environmentVariables="[{name=ACCOUNT,value=919744496312},{name=AWS_DEFAULT_REGION,value=ap-southeast-2}]" \
  --service-role arn:aws:iam::919744496312:role/suchanaai-codebuild --region ap-southeast-2
aws codebuild start-build --project-name suchanaai-build-all --region ap-southeast-2
# Build 88ba12a3 SUCCEEDED — images pushed: sha256:6e5d35 (web), b2eb61 (api), ae6d42 (ai)
```

Update `buildspec.yml` inline via `apps/ai/.venv/bin/python /tmp/fix_buildspec.py` if needed (uses `APPLY`).

---

## 10. Deploy Real Images to EB

**Dockerrun.aws.json per env (`Ports` must match `PORT` env):**

`api/Dockerrun.aws.json`:
```json
{"AWSEBDockerrunVersion":"1","Image":{"Name":"919744496312.dkr.ecr.ap-southeast-2.amazonaws.com/suchanaai-api:latest","Update":"true"},"Ports":[{"ContainerPort":"5005"}]}
```
`web:3535`, `ai:8000` (ai uses `suchanaai-ai-service:latest`).

**With nginx overrides (`.platform/nginx/conf.d/client_max_body_size.conf` `100M`, `proxy_timeout.conf` `600s` for `/documents` and `/scrape`):**
```bash
mkdir -p /tmp/deploy/api/.platform/nginx/conf.d
echo "client_max_body_size 100M; client_body_buffer_size 16k;" > /tmp/deploy/api/.platform/nginx/conf.d/client_max_body_size.conf
echo -e "proxy_connect_timeout 600s;\nproxy_send_timeout 600s;\nproxy_read_timeout 600s;" > /tmp/deploy/api/.platform/nginx/conf.d/proxy_timeout.conf
(cd /tmp/deploy/api && zip -r /tmp/deploy-api.zip Dockerrun.aws.json .platform)
aws s3 cp /tmp/deploy-api.zip s3://elasticbeanstalk-ap-southeast-2-919744496312/suchanaai/api-api-latest.zip --region ap-southeast-2
aws elasticbeanstalk create-application-version --application-name suchanaai --version-label api-20260923 --source-bundle S3Bucket=elasticbeanstalk-ap-southeast-2-919744496312,S3Key=suchanaai/api-api-latest.zip --region ap-southeast-2
aws elasticbeanstalk update-environment --environment-name suchanaai-api-prod --version-label api-20260923 --region ap-southeast-2
# Same for web/ai
```

API failed first `Red Degraded` (`Docker container unexpectedly ended`) — fixed by updating `DATABASE_URL` to `141.148.209.235` → `Green`.

---

## 11. Verify — Health & Endpoints

```bash
REGION=ap-southeast-2
for env in suchanaai-web-prod suchanaai-api-prod suchanaai-ai-prod; do
  CNAME=$(aws elasticbeanstalk describe-environments --environment-names $env --region $REGION --query 'Environments[0].CNAME' --output text)
  echo "$env: http://$CNAME"
done

curl http://suchanaai-web-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/api/health
curl http://suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/health
# {"status":"ok","uptimeSeconds":...}
curl http://suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/health
# {"status":"ok","model_loaded":true,"qdrant":true,"phase":"ready"}

psql "postgresql://postgres:ChangeThisPassword123!@141.148.209.235:5432/public_notice_management" -c "select count(*) from users; select count(*) from scraped_items;"
# 6 , 4655

# Bedrock IAM (no bearer token)
aws bedrock list-foundation-models --region ap-southeast-2 --query "modelSummaries[?modelId=='global.anthropic.claude-haiku-4-5-20251001-v1:0']"
# Verify AI can call via SSM: ssm send-command i-05006286002494f6a "python -c 'from anthropic import AnthropicBedrock; print(AnthropicBedrock(aws_region=\"ap-southeast-2\").messages.create(model=\"global.anthropic.claude-haiku-4-5-20251001-v1:0\",max_tokens=10,messages=[{\"role\":\"user\",\"content\":\"hi\"}]).content[0].text)'"
```

**Current live (2026-09-23):** `web` `Green`, `api` `Green`, `ai-prod` `Yellow→Green` (warmup), `ai-service-prod` `Grey Launching` (terminate).

---

## 12. Domain `suchanaai.tech` on get.tech — Make It Load

**You fixed CNAMEs in last screenshot — now correct:**
```
www  CNAME  suchanaai-web-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com  Auto
api  CNAME  suchanaai-api-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com  Auto
ai   CNAME  suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com  Auto (add)
_xxx CNAME  _xxx.jkddz... (ACM validation) — keep
```

**Why `https://suchanaai.tech` → `DNS_PROBE_FINISHED_NXDOMAIN` in your last screenshot:** you hit **apex `suchanaai.tech` without `www`**. `CNAME` at apex is invalid per DNS RFC — apex has **no record**, so `NXDOMAIN`. `www.suchanaai.tech` will work.

**Fix apex (choose one):**
- **Recommended (free, same provider):** `get.tech > suchanaai.tech > Domain Forwarding` → `Add forwarding` → `suchanaai.tech` → `https://www.suchanaai.tech` `301` → Save.
- **Alternative:** `DNS > A Records` → `Add` → Host `@` → Value `13.237.13.36` (current `web-prod` EIP, changes on rebuild — forwarding is more robust).

**Also check `DNS > Nameservers`:** must be `Use default nameservers (get.tech)` — if custom/external, your CNAME edits never publish.

**Verify after 1–5 min:**
```bash
dig www.suchanaai.tech +short
dig api.suchanaai.tech +short
curl http://www.suchanaai.tech
curl http://api.suchanaai.tech/health
# For now use http:// — SingleInstance has no ALB/ACM, https will fail until §13
```

---

## 13. HTTPS — Next Step (LoadBalanced + ACM)

`SingleInstance` has **no ALB**, so `https://` cannot attach ACM cert.

1. **ACM:** `ACM > Request certificate` → `suchanaai.tech` + `*.suchanaai.tech` in `ap-southeast-2` → DNS validation (auto-adds `_xxx` CNAMEs you already have) → `Issued`.
2. **EB:** `EB > suchanaai-web-prod > Configuration > Capacity > EnvironmentType: LoadBalanced` → `Load balancer: Application` → `Listeners: Add 443 HTTPS` → select ACM cert → `Apply` (also for `api-prod` if you want `https://api.suchanaai.tech`).
3. **Or front with CloudFront:** `CloudFront > Create distribution` → Origin `suchanaai-web-prod.eba-mmm2ap2z...` → `Alternate domain: www.suchanaai.tech` → `Custom SSL cert` → `Route53/ALIAS` `@` → `dxxx.cloudfront.net`.

After HTTPS, update `WEB_ORIGIN=https://www.suchanaai.tech,https://suchanaai.tech` in `api-prod` and rebuild `web` with `NEXT_PUBLIC_*=https://...`.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ai-prod Yellow 1/1 Warning` after deploy | Model warmup | Wait 2 min or set `HealthCheckGracePeriod=120` |
| `api-prod Red Docker unexpectedly ended` | `P3018 42P01 scrape_sources` on empty RDS | Use `141.148.209.235` DB (or `psql dump` → new RDS) |
| `ai-service-prod Grey Launching` no instances | `t3.medium not FreeTier` | Use `t3.small` (`ai-prod` already) |
| `CNAME j3cvke4q.us-east-1` | Old region | Change to `mmm2ap2z.ap-southeast-2` |
| `suchanaai.tech NXDOMAIN` | Apex no record | Add `Domain Forwarding` apex→www or `A @` |
| `https://` fails | SingleInstance no cert | Switch to LoadBalanced + ACM |

**Logs:**
```bash
aws elasticbeanstalk request-environment-info --environment-name suchanaai-api-prod --info-type tail --region ap-southeast-2
aws ssm send-command --instance-ids i-094057541e8d111ad --document-name "AWS-RunShellScript" --parameters 'commands=["cat /var/log/eb-engine.log | tail -n 200","docker logs $(docker ps -a --format \"{{.ID}}\" | head -n1) | tail -n 200"]' --region ap-southeast-2
aws logs get-log-events --log-group-name /aws/codebuild/suchanaai-build-all --log-stream-name <id> --region ap-southeast-2
```

---

## 15. Cost & Cleanup

**Unused (created for ECS, not used by EB):**
- `suchanaai-alb-133432424.ap-southeast-2.elb.amazonaws.com` (ALB) → `aws elbv2 delete-load-balancer --load-balancer-arn arn:aws:elasticloadbalancing:ap-southeast-2:919744496312:loadbalancer/app/suchanaai-alb/a6b534360532f324`
- `suchanaai-db` RDS `available` → `aws rds delete-db-instance --db-instance-identifier suchanaai-db --skip-final-snapshot --region ap-southeast-2` (if keeping `141.148.209.235`)
- `fs-01223c4f773e0ae68` EFS, `vpc-...` ECS SGs, `suchanaai` ECS cluster

Keep `suchanaai-ai-service-prod` terminated (once `ai-prod` stable): `EB > Terminate`.

---

## 16. Appendix — Exact Commands

```bash
# Login & check
aws sts get-caller-identity --region ap-southeast-2
# ECR
aws ecr describe-repositories --region ap-southeast-2
# EB
aws elasticbeanstalk describe-environments --application-name suchanaai --region ap-southeast-2
# Build & push via CodeBuild (S3 source)
aws codebuild start-build --project-name suchanaai-build-all --region ap-southeast-2
aws ecr describe-images --repository-name suchanaai-web --region ap-southeast-2
# DNS
dig www.suchanaai.tech +short; dig api.suchanaai.tech +short
curl -s http://www.suchanaai.tech | head
curl -s http://api.suchanaai.tech/health
curl -s http://suchanaai-ai-prod.eba-mmm2ap2z.ap-southeast-2.elasticbeanstalk.com/health
```

**Live now:** `http://www.suchanaai.tech` (after CNAME fix) → `t3.small` `suchanaai-web-prod` with `NEXT_PUBLIC_*` baked for `http`. Update to `https` after §13.


---

## 17. HTTPS via CloudFront (completed 2026-09-24)

SingleInstance EB has no :443, so HTTPS is terminated at CloudFront (ACM must be `us-east-1` for CloudFront).

- **Certs (ACM):**
  - `arn:aws:acm:us-east-1:919744496312:certificate/2d16212b-fd88-41c0-bad2-a2a1ccc9a117` (`suchanaai.tech` + `www`) — `ISSUED`, used by web CDN
  - `arn:aws:acm:us-east-1:919744496312:certificate/7fced4b7-ed44-44d7-91c9-57a3c5f27110` (`suchanaai.tech` + `*.suchanaai.tech` wildcard) — `ISSUED`, used by api CDN
  - Validation: Route53 `Z01735154H9KLUOVHJZV` CNAMEs `_d3589f0...` + `_8805343a...`
- **Distributions:**
  - Web `EHEW4L86Q9AD8` (`d2ak6xfhgr2xcc.cloudfront.net`, aliases `www` + apex, `redirect-to-https`, origin `suchanaai-web-prod.eba-mmm2ap2z...:80`)
  - API `E2GXIDKJWCGJ9A` (`d38f4yatpnjdne.cloudfront.net`, alias `api.suchanaai.tech`, `redirect-to-https`, no-cache, forward all headers/cookies/query)
- **Route53:** `www`/`apex` ALIAS A → web CF, `api` ALIAS A → api CF (CloudFront HZ `Z2FDTNDATAQYW2`)
- **Web rebuild:** CodeBuild `suchanaai-build-all` with `NEXT_PUBLIC_APP_URL=https://www.suchanaai.tech`, `NEXT_PUBLIC_API_URL=https://api.suchanaai.tech` → `web-https-20260924091014` deployed `Green Ready`
- **Verified:** `https://www.suchanaai.tech 200`, `https://suchanaai.tech 200`, `https://api.suchanaai.tech/health {"status":"ok"}`, `GET /notices` returns DOR notice, cert `CN=suchanaai.tech` Amazon RSA 2048 to `2027-04-08`
