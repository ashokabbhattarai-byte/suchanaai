# Domain, HTTPS & CI/CD — suchanaai.tech on AWS account `917909628524`

Companion to `docs/DEPLOYMENT_CHECKLIST_AWS_917909628524.md` (that file covers
IAM/EB/ECR setup). This file covers **DNS, TLS, and the exact values needed
for a green CI/CD run**, with real values from the live deployment.

- **Domain:** `suchanaai.tech` (registrar dashboard: `manage.get.tech` — DNS
  Records tab, not currently on Route 53)
- **AWS account:** `917909628524`, region `us-east-1`
- **App code already assumes these exact hostnames** — `apps/api/src/main.ts`
  hardcodes `https://suchanaai.tech` and `https://www.suchanaai.tech` into the
  CORS allowlist. Do not deploy under different hostnames without also
  editing that file.

## Status right now

| Step | State |
|---|---|
| §3 ACM cert requested | ✅ done |
| §3 DNS validation records added at get.tech | ⏳ **your action needed** — see §3 |
| §3 Cert issued | ⏳ blocked on the row above |
| §4 Port 443 opened on both ALB security groups | ✅ done |
| §4 HTTPS listeners attached | ⛔ blocked — tried, ACM rejects a non-`ISSUED` cert |
| §2 Apex/www/api routing records | not yet added — decide Option A vs B first |
| §5–§7 Web rebuild, API env vars, GitHub secrets | not started — depend on the above |

**The one thing blocking everything below §3 is adding those 3 CNAME
records at get.tech.** Nothing else can proceed until that's done.

---

## 0. Why ACM instead of certbot/nginx

You asked for free HTTPS via certbot+nginx. I used **ACM (AWS Certificate
Manager)** instead — same outcome (free, valid cert), better fit for this
architecture:

- Web and API sit behind an **Application Load Balancer**. TLS terminates at
  the ALB, not on the EC2 instances.
- EB instances are managed by an Auto Scaling Group and get replaced
  routinely (deploys, health-check failures, patching). A certbot cert and
  its renewal cron living on an instance disappear the moment that instance
  is recycled.
- ACM issues the cert once, attaches it to the ALB's 443 listener, and
  **auto-renews indefinitely** with nothing to run, patch, or monitor.

The AI service has no ACM cert and doesn't need one: I checked the web
codebase and `NEXT_PUBLIC_AI_URL` is declared but **never referenced** —
the browser never talks to the AI service directly, only the API does,
server-to-server, inside the VPC. It stays on its internal EB hostname over
plain HTTP.

---

## 1. Current live endpoints (already deployed, HTTP only)

| Service | EB CNAME |
|---|---|
| web | `suchanaai-web-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` |
| api | `suchanaai-api-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` |
| ai (internal only) | `suchanaai-ai-service-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` |

All three verified serving real traffic (API: 1,302 notices; AI: Qdrant
connected, embedding model loaded).

---

## 2. DNS records to add at the registrar

**The apex (`suchanaai.tech` with no subdomain) cannot be a CNAME** — that's
a DNS protocol rule, not an AWS limitation. Two ways to handle it:

### Option A — move DNS to Route 53 (recommended)

Route 53 supports an **ALIAS** record at the apex, which behaves like a
CNAME but is legal there, and it's what lets the domain point directly at the
ALB with no extra hop. This is the standard AWS-native setup and what the
rest of this doc assumes.

Steps: create a Route 53 hosted zone for `suchanaai.tech`, update the
nameservers at Namify to Route 53's four `ns-*.awsdns-*.` values, then add:

| Name | Type | Value |
|---|---|---|
| `suchanaai.tech` | A (Alias) | `awseb--AWSEB-QjnF3HSS6UCo-583554501.us-east-1.elb.amazonaws.com` (zone `Z35SXDOTRQ7X7K`) |
| `www.suchanaai.tech` | A (Alias) | same as above (Web ALB) |
| `api.suchanaai.tech` | A (Alias) | `awseb--AWSEB-kXDpInL1eDdC-878338778.us-east-1.elb.amazonaws.com` (zone `Z35SXDOTRQ7X7K`) |

### Option B — stay on Namify, skip the apex

If you'd rather not migrate nameservers: point `www` and `api` at the EB
CNAMEs directly (ordinary CNAME records, no migration needed), and use
Namify's **Domain Forwarding** tab (visible in your screenshot) to redirect
the bare `suchanaai.tech` to `https://www.suchanaai.tech`. This is simpler
but the forward is typically a basic HTTP redirect at the registrar, not a
real ALB route — acceptable for a "www-canonical" site, less clean than
Option A.

| Name | Type | Value |
|---|---|---|
| `www.suchanaai.tech` | CNAME | `suchanaai-web-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` |
| `api.suchanaai.tech` | CNAME | `suchanaai-api-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` |
| `suchanaai.tech` | Forwarding | → `https://www.suchanaai.tech` (Namify Domain Forwarding tab) |

**I recommend Option A.** The app's own CORS allowlist expects the apex to
work (`https://suchanaai.tech`, no `www.`), so a redirect-only apex is a
slightly awkward fit with code that already assumes it resolves directly.

---

## 3. ACM certificate — REQUESTED, awaiting DNS validation

> **Live status (last checked): `PENDING_VALIDATION`.** Nothing in §4
> onward can proceed until this flips to `ISSUED` — `CreateListener`
> actively rejects a pending cert (`UnsupportedCertificate`), confirmed by
> testing it. This is the one blocking step right now.

Already requested, covering the apex, `www`, and `api`:

```
Certificate ARN: arn:aws:acm:us-east-1:917909628524:certificate/a28930c2-968c-42a4-9b48-e0bf63d1139d
```

**Add these exact 3 CNAME records now**, at whichever registrar/DNS panel is
authoritative for `suchanaai.tech` — for this domain that's the **get.tech**
dashboard (`manage.get.tech/dashboard/manage-domain` → DNS → DNS Records →
Add new record → Record type **CNAME Record**), unless you've since migrated
to Route 53 (Option A).

| Host name field | Value field |
|---|---|
| `_b5dce771cf7b7f2d7ee9580d17af1d54.suchanaai.tech` | `_4625d3addc9d11de0075ff3fcd00cca9.jkddzztszm.acm-validations.aws.` |
| `_502c3d8fb6acbb7b9c8b621cd2b4aa7a.www.suchanaai.tech` | `_469cacd2f79261543ab8e709fccb0989.jkddzztszm.acm-validations.aws.` |
| `_7fbecf81c0749ab6a3b46a2e73074c08.api.suchanaai.tech` | `_5dd202ca91680991d4b71f816873028f.jkddzztszm.acm-validations.aws.` |

**These are the only 3 records needed for step §3.** They are unrelated to
the `www`/`api`/apex *routing* records in §2 — don't confuse the two. In
particular, do **not** save a CNAME with Host name `suchanaai.tech` (bare
apex) pointing at the EB hostname — that was attempted in the get.tech panel
and is wrong for two independent reasons: (1) it isn't one of the three
validation records ACM is waiting for, and (2) a CNAME at the bare apex is
invalid DNS and most registrars either reject it silently or let it corrupt
other apex records (MX, etc.) — see §2's Option A/B for the correct way to
route the apex.

TTL: Auto is fine. If the get.tech form auto-appends the zone to the Host
name field, enter only the part before `.suchanaai.tech` (e.g.
`_b5dce771cf7b7f2d7ee9580d17af1d54`) and verify after saving that it didn't
get double-appended (e.g. `...suchanaai.tech.suchanaai.tech`). Trailing dot
on the Value is optional — include it if the form allows it, omit it if the
form rejects trailing dots.

Check issuance status (safe to re-run anytime, read-only):

```sh
aws acm describe-certificate --region us-east-1 \
  --certificate-arn arn:aws:acm:us-east-1:917909628524:certificate/a28930c2-968c-42a4-9b48-e0bf63d1139d \
  --query "Certificate.Status" --output text
```

---

## 4. Attach the certificate to both ALBs — real values, port 443 already open

Port 443 inbound is **already open** on both ALB security groups
(`sg-0f662739599a95c78` web, `sg-002c47748e11ed5f5` api).

**Blocked on §3**: `CreateListener` rejects a cert that isn't `ISSUED` yet —
tried it, got `UnsupportedCertificate`. Once the cert shows `ISSUED`, run:

```sh
CERT=arn:aws:acm:us-east-1:917909628524:certificate/a28930c2-968c-42a4-9b48-e0bf63d1139d

# Web ALB
aws elbv2 create-listener --region us-east-1 \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:917909628524:loadbalancer/app/awseb--AWSEB-QjnF3HSS6UCo/690044d6588f9b5d \
  --protocol HTTPS --port 443 --certificates CertificateArn=$CERT \
  --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:us-east-1:917909628524:targetgroup/awseb-AWSEB-4RRJ9WTUTCCH/86b74ec429de02be

# API ALB
aws elbv2 create-listener --region us-east-1 \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:917909628524:loadbalancer/app/awseb--AWSEB-kXDpInL1eDdC/ef4f64df70ce67be \
  --protocol HTTPS --port 443 --certificates CertificateArn=$CERT \
  --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:us-east-1:917909628524:targetgroup/awseb-AWSEB-DITO35DWO1QM/99ad66ded3646dd1
```

Real ALB/target-group values (already confirmed live):

| | Web ALB | API ALB |
|---|---|---|
| ALB ARN | `.../app/awseb--AWSEB-QjnF3HSS6UCo/690044d6588f9b5d` | `.../app/awseb--AWSEB-kXDpInL1eDdC/ef4f64df70ce67be` |
| ALB DNS name | `awseb--AWSEB-QjnF3HSS6UCo-583554501.us-east-1.elb.amazonaws.com` | `awseb--AWSEB-kXDpInL1eDdC-878338778.us-east-1.elb.amazonaws.com` |
| Hosted zone ID | `Z35SXDOTRQ7X7K` | `Z35SXDOTRQ7X7K` |
| Target group ARN | `.../targetgroup/awseb-AWSEB-4RRJ9WTUTCCH/86b74ec429de02be` | `.../targetgroup/awseb-AWSEB-DITO35DWO1QM/99ad66ded3646dd1` |

These are the exact **§2 Route 53 ALIAS** values if you go that route — an
ALIAS record points at an ALB by its DNS name + hosted zone ID pair above,
not an IP.

After the listeners exist, redirect HTTP → HTTPS on port 80 so plain
`http://suchanaai.tech` doesn't serve unencrypted:

```sh
WEB_HTTP_LISTENER=$(aws elbv2 describe-listeners --region us-east-1 \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:917909628524:loadbalancer/app/awseb--AWSEB-QjnF3HSS6UCo/690044d6588f9b5d \
  --query "Listeners[?Port==\`80\`].ListenerArn" --output text)
aws elbv2 modify-listener --region us-east-1 --listener-arn "$WEB_HTTP_LISTENER" \
  --default-actions Type=redirect,RedirectConfig='{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'
# repeat for the API ALB's port-80 listener
```

---

## 5. Rebuild the web image with HTTPS URLs

`NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_APP_URL` are **compiled into the Next.js
bundle at build time** (see `docs/DEPLOYMENT_CHECKLIST_AWS_917909628524.md`
§3) — changing an env var on the running environment does nothing. The web
image currently deployed was built against the plain HTTP EB hostnames and
**must be rebuilt** once the domain is live:

```
NEXT_PUBLIC_API_URL = https://api.suchanaai.tech
NEXT_PUBLIC_AI_URL  = http://suchanaai-ai-service-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com   (internal, unused by browser, but keep it set)
NEXT_PUBLIC_APP_URL = https://suchanaai.tech
```

## 6. Runtime env vars to update (API)

Once the domain resolves, update the **API** environment's runtime
properties (these are separate from the build-time values above):

| Key | New value |
|---|---|
| `WEB_ORIGIN` | `https://suchanaai.tech` |
| `PUBLIC_SITE_URL` | `https://suchanaai.tech` |
| `APP_URL` | `https://suchanaai.tech` |

`apps/api/src/main.ts` already hardcodes `https://suchanaai.tech` and
`https://www.suchanaai.tech` into `productionOrigins` for CORS, independent
of `WEB_ORIGIN` — so cross-origin browser calls from the real domain will
work even before this step, but the env vars above drive the values the API
puts into outgoing links (alert emails, etc.) and should still be updated.

---

## 7. GitHub Actions — real values for a green CI/CD run

`ashokabbhattarai-byte/suchanaai` → **Settings → Secrets and variables → Actions**

### Secret

| Name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::917909628524:role/suchanaai-github-deploy` |

### Variables

| Name | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.suchanaai.tech` |
| `NEXT_PUBLIC_AI_URL` | `http://suchanaai-ai-service-prod.eba-j3cvke4q.us-east-1.elasticbeanstalk.com` |
| `NEXT_PUBLIC_APP_URL` | `https://suchanaai.tech` |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | `976108367738-7ifbum0as0oft1hlmkdkk03vt26sfnr9.apps.googleusercontent.com` |
| `AWS_REGION` | `us-east-1` *(matches the pipeline default — optional to set explicitly)* |
| `EB_APPLICATION_NAME` | `suchanaai` *(default — optional)* |
| `EB_WEB_ENV` | `suchanaai-web-prod` *(default — optional)* |
| `EB_API_ENV` | `suchanaai-api-prod` *(default — optional)* |
| `EB_AI_ENV` | `suchanaai-ai-service-prod` *(default — optional)* |
| `ECR_WEB_REPO` | `suchanaai-web` *(default — optional)* |
| `ECR_API_REPO` | `suchanaai-api` *(default — optional)* |
| `ECR_AI_REPO` | `suchanaai-ai-service` *(default — optional)* |

Everything marked "default — optional" already matches what exists in AWS
and what `ci-cd.yml` falls back to — only the four `NEXT_PUBLIC_*` values and
the one secret are strictly required.

**Google OAuth console:** add `https://suchanaai.tech` and
`https://www.suchanaai.tech` to the OAuth client's Authorized JavaScript
origins (console.cloud.google.com → APIs & Services → Credentials) — Google
will reject the login flow from the new origin otherwise.

### Trigger the first deploy after DNS/HTTPS lands

**Actions → CI/CD → Run workflow →** tick **"Deploy all three apps
regardless of what changed"**. This rebuilds web with the new
`NEXT_PUBLIC_*` values baked in and redeploys all three.

---

## 8. Order of operations

Doing these out of order leaves the site half-broken (e.g. HTTPS live but web
still pointing at HTTP API URLs). Recommended sequence:

1. **§2** — decide Route 53 vs Namify-only, add DNS records (skip ACM
   validation records for now if using Option B and no cert yet)
2. **§3** — request the ACM cert, add its validation CNAMEs, wait for
   `ISSUED` status (`aws acm describe-certificate ... --query Certificate.Status`)
3. **§4** — attach the cert to both ALBs' 443 listeners, add HTTP→HTTPS
   redirect on port 80
4. Confirm `https://suchanaai.tech` and `https://api.suchanaai.tech` resolve
   and serve valid certs (`curl -vI https://suchanaai.tech` — check for `SSL
   certificate verify ok`)
5. **§7** — set the GitHub variables/secret, then run the workflow with
   "deploy all three" — this does **§5 and §6** for you (rebuilds web,
   the API env vars can be set manually via `update-environment` or folded
   into the same deploy)
6. Verify: `https://suchanaai.tech` loads, logs in via Google, and successfully
   calls `https://api.suchanaai.tech`

---

## 9. Known gap

The AI service remains **single-instance**, HTTP-only, internal-only — by
design, since it's never reached from a browser. If that instance is
replaced or fails, scraping and RAG stop until EB relaunches it; there's no
load balancer or redundancy on that tier. Acceptable for current scale;
revisit if AI availability becomes a concern.
