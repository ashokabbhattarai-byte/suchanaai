# CI/CD deployment checklist — AWS account `917909628524`

Account-specific companion to `docs/AWS_ELASTIC_BEANSTALK_DEPLOYMENT.md`.
That file explains *how the pipeline works*; this one is the concrete
what-is-done / what-you-must-do list for this account, with the real ARNs and
names already created.

- **AWS account:** `917909628524` (root)
- **Region:** `us-east-1`
- **Deploying GitHub repo:** `ashokabbhattarai-byte/suchanaai` (the `upstream`
  remote — *not* `origin`)
- **Pipeline:** `.github/workflows/ci-cd.yml`

---

## 1. Already created in AWS — nothing to do

| Resource | Name / ARN |
|---|---|
| ECR repo (web) | `917909628524.dkr.ecr.us-east-1.amazonaws.com/suchanaai-web` |
| ECR repo (api) | `917909628524.dkr.ecr.us-east-1.amazonaws.com/suchanaai-api` |
| ECR repo (ai) | `917909628524.dkr.ecr.us-east-1.amazonaws.com/suchanaai-ai-service` |
| OIDC provider | `arn:aws:iam::917909628524:oidc-provider/token.actions.githubusercontent.com` |
| Deploy role | `arn:aws:iam::917909628524:role/suchanaai-github-deploy` |
| EB service role | `aws-elasticbeanstalk-service-role` |
| EC2 instance profile | `aws-elasticbeanstalk-ec2-role` (has `AmazonEC2ContainerRegistryReadOnly`) |
| EB application | `suchanaai` |
| EB environments | `suchanaai-web-prod`, `suchanaai-api-prod`, `suchanaai-ai-service-prod` |

The ECR repo for the AI service **must** be `suchanaai-ai-service` — that is the
pipeline's default (`vars.ECR_AI_REPO`). A repo named `suchanaai-ai` will not
be found and the AI deploy will fail.

### Environment shapes

| Environment | Type | Instance | Port | Notes |
|---|---|---|---|---|
| `suchanaai-web-prod` | LoadBalanced (ALB) | t3.micro ×1–2 | 3535 | 3 AZs: `us-east-1a/b/c` |
| `suchanaai-api-prod` | LoadBalanced (ALB) | t3.micro ×1–2 | 3001 | 3 AZs: `us-east-1a/b/c` |
| `suchanaai-ai-service-prod` | SingleInstance | t3.medium, 30 GB | 8000 | needs ~4 GB (embedding model + headless Chromium) |

The container ports above are fixed in `ci-cd.yml` (`container-port:`) and must
match what each Dockerfile exposes.

---

## 2. GitHub — repository secret

`ashokabbhattarai-byte/suchanaai` → **Settings → Secrets and variables → Actions → Secrets**

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::917909628524:role/suchanaai-github-deploy` |

This is the only AWS credential GitHub needs. There is no access key or secret
key anywhere — the workflow assumes this role via OIDC. The role's trust policy
only accepts `repo:ashokabbhattarai-byte/suchanaai:*`, so a fork or any other
repo cannot assume it.

## 3. GitHub — repository variables

Same page → **Variables** tab.

Every name below already has a default in `ci-cd.yml` that matches what was
created, so **you only strictly need the `NEXT_PUBLIC_*` ones**. The rest are
listed so you can see what is being assumed.

### Required (baked into the web image at build time)

`NEXT_PUBLIC_*` values are compiled into the Next.js bundle during
`docker build`. They are **not** runtime config — changing one means a rebuild,
not an environment-variable update.

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `http://<api CNAME>` (see §5) |
| `NEXT_PUBLIC_AI_URL` | `http://<ai CNAME>` |
| `NEXT_PUBLIC_APP_URL` | `http://<web CNAME>` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | your Google OAuth web client ID |

Optional: `NEXT_PUBLIC_RECAPTCHA_SITE_KEY`, `NEXT_PUBLIC_POSTHOG_KEY`,
`NEXT_PUBLIC_POSTHOG_HOST`.

### Optional (defaults already correct — set only to override)

| Variable | Default in `ci-cd.yml` |
|---|---|
| `AWS_REGION` | `us-east-1` |
| `EB_APPLICATION_NAME` | `suchanaai` |
| `EB_WEB_ENV` / `EB_API_ENV` / `EB_AI_ENV` | `suchanaai-web-prod` / `suchanaai-api-prod` / `suchanaai-ai-service-prod` |
| `ECR_WEB_REPO` / `ECR_API_REPO` / `ECR_AI_REPO` | `suchanaai-web` / `suchanaai-api` / `suchanaai-ai-service` |

---

## 4. AWS — per-environment runtime configuration

Set these in **Elastic Beanstalk → environment → Configuration → Updates,
monitoring, and logging → Environment properties**, or with:

```sh
aws elasticbeanstalk update-environment --region us-east-1 \
  --environment-name suchanaai-api-prod \
  --option-settings \
    Namespace=aws:elasticbeanstalk:application:environment,OptionName=DATABASE_URL,Value='postgresql://…'
```

These are runtime values and are **not** in the Docker image — unlike the
`NEXT_PUBLIC_*` build args above.

### `suchanaai-api-prod`

| Key | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | ≥32 chars. The API **refuses to boot** on a weak/default value |
| `SETTINGS_ENCRYPTION_KEY` | base64 32-byte key. **Load-bearing** — rotating it orphans every stored provider API key |
| `INTERNAL_SERVICE_SECRET` | must match the AI service's value exactly |
| `AI_SERVICE_URL` | `http://<ai CNAME>` |
| `WEB_ORIGIN` | `http://<web CNAME>` — CORS allowlist |
| `PUBLIC_SITE_URL` | public domain used in alert links |
| `GOOGLE_CLIENT_ID` | same client ID as the web build arg |
| `ADMIN_EMAILS` | comma-separated admin allowlist |
| `NODE_ENV` | `production` |
| `PORT` | `3001` — must match `container-port` |

Optional: `AWS_REGION`, `S3_BUCKET_NAME`, `STRIPE_*`, `EVOLUTION_*`,
`RECAPTCHA_SECRET_KEY`, and the `SCRAPING_*` / `NOTICES_*_CACHE_MS` tunables.

### `suchanaai-ai-service-prod`

| Key | Notes |
|---|---|
| `QDRANT_URL` | vector store endpoint |
| `QDRANT_API_KEY` | blank if unauthenticated |
| `QDRANT_COLLECTION` | `documents` |
| `API_INTERNAL_URL` | `http://<api CNAME>` |
| `INTERNAL_SERVICE_SECRET` | must match the API's value exactly |
| `CORS_ORIGINS` | `http://<web CNAME>` |
| `PORT` | `8000` |
| `ENVIRONMENT` | `production` |

LLM keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENCODE_ZEN_API_KEY`,
`BEDROCK_API_KEY`) are **fallback defaults only** — the admin panel at
`/admin/ai` is the real source of truth and overrides them on a polling loop.
Set them here only to have something working before the first sync.

If `INTERNAL_SERVICE_SECRET` is blank the config sync is disabled entirely and
the AI service runs purely on these env vars.

### `suchanaai-web-prod`

Needs almost nothing at runtime — its config is compiled in. Set `PORT=3535`.

---

## 5. Read the environment URLs

```sh
aws elasticbeanstalk describe-environments --region us-east-1 \
  --application-name suchanaai \
  --query "Environments[].[EnvironmentName,Status,Health,CNAME]" --output table
```

Feed the three CNAMEs back into the `NEXT_PUBLIC_*` variables (§3), the API's
`AI_SERVICE_URL` / `WEB_ORIGIN`, and the AI service's `API_INTERNAL_URL` /
`CORS_ORIGINS`.

**Ordering matters:** the web image bakes in `NEXT_PUBLIC_API_URL`, so the API
environment must exist and its CNAME be known *before* the web image is built.
If you deploy web first with a wrong URL, fix the variable and re-run the web
job — an environment-variable change alone will not fix it.

---

## 6. First deployment

The pipeline only deploys apps whose files changed. For the initial rollout,
deploy all three explicitly:

**Actions → CI/CD → Run workflow →** tick **"Deploy all three apps regardless
of what changed"** (`force_all`).

Then watch:

```sh
aws elasticbeanstalk describe-events --region us-east-1 \
  --environment-name suchanaai-api-prod --max-items 20 \
  --query "Events[].[EventDate,Severity,Message]" --output table
```

---

## 7. Known gaps

1. **`anthropic` package.** `apps/ai/requirements.txt` now includes
   `anthropic[bedrock]`, but it has never been installed anywhere. The AI image
   build will pull it — no action needed if you deploy via the pipeline.
2. **Bedrock is not usable on the old account.** The Bedrock provider is wired
   end to end, but account `679777944150` is `NOT_AUTHORIZED` for every Claude
   model. If you want Bedrock on **this** account (`917909628524`), model access
   must be requested here separately — it does not carry over.
3. **Database still off-AWS.** `DATABASE_URL` and `QDRANT_URL` point at
   `141.148.209.235` (Oracle Cloud). This works but leaves your data outside
   AWS. RDS `db.t4g.micro` is free-tier for 12 months if you want to move it.
4. **Cost.** Two ALBs (~$32/mo) and a t3.medium (~$30/mo) are **not** free tier;
   free tier covers 750 h/month of a *single* micro instance. Budget
   ~$70–90/month before RDS. The AI instance is the main lever.

---

## 8. Troubleshooting quick reference

| Symptom | Cause |
|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `AWS_DEPLOY_ROLE_ARN` wrong, or pushing from a repo other than `ashokabbhattarai-byte/suchanaai` |
| `repository does not exist` on AI deploy | ECR repo must be `suchanaai-ai-service` |
| Environment `Degraded`, container restarts | app crashed on boot — almost always a missing env var. Check `/var/log/eb-docker/containers/eb-current-app/` via **Logs → Request logs** |
| API exits immediately | `JWT_SECRET` missing or under 32 chars — it refuses to start by design |
| Web loads but every API call fails | `NEXT_PUBLIC_API_URL` baked in wrong → rebuild web; or API `WEB_ORIGIN` doesn't match the web CNAME → CORS |
| Admin AI panel shows "No API key configured" right after saving | stale registry cache; fixed — the API now pushes `POST /llm/providers/refresh` after every provider edit |
