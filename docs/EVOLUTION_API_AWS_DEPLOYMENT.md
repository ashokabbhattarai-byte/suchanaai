# Evolution API (WhatsApp alerts) — AWS deployment

> Companion to `docs/EVOLUTION_API_DEPLOYMENT.md` (the original Oracle-box
> version of this guide) and `docs/AWS_DEPLOYMENT.md` (the rest of this
> system's AWS footprint). This document describes the actual, live
> deployment on this project's AWS account (917909628524, us-east-1) — the
> Oracle doc's steps do not apply here; this one supersedes it for AWS.

## What this is

A single dedicated EC2 instance running Evolution API (the self-hosted
WhatsApp gateway — see the Oracle doc §1 for what it is and the
Baileys/ToS tradeoff, which is unchanged) plus its own Postgres, wired into
the already-existing `EvolutionApiService` / `WhatsappWebhookController` /
`AdminWhatsappController` code in `apps/api` — none of that application
code changed; it was already complete and just needed a real instance to
talk to.

## Architecture

```
                     ┌─────────────────────────────────────┐
                     │  VPC vpc-0219942e0382c23e7 (us-east-1)│
                     │  subnet-0be99c7e334385fbb             │
                     │                                        │
  Internet ──HTTPS──▶│  ALB ──▶ suchanaai-api-prod (EB)       │
                     │              │                          │
                     │              │ private, tcp/8080        │
                     │              ▼                          │
                     │  i-0ebc079124469356a (t3.micro)         │
                     │  suchanaai-evolution-prod                │
                     │  ┌────────────────────────────────┐     │
                     │  │ docker: evolution-api  (480MB)  │     │
                     │  │ docker: postgres:16-alpine(220MB)│    │
                     │  └────────────────────────────────┘     │
                     │              │ outbound only             │
                     └──────────────┼───────────────────────────┘
                                    ▼
                          WhatsApp (Baileys/WS)
```

Every design choice below optimizes for the same three things asked for:
**low resource use, fast alerts, and headroom for several alerts firing
close together.**

### Network — private by construction, not by convention

- Security group `sg-06e527ae9229a43da` (`suchanaai-evolution-prod`):
  **inbound TCP 8080 from `sg-00b0d6200986e2ab8`** (api-prod's own security
  group, referenced by ID — not a CIDR, so it keeps working automatically
  if api-prod's instance is replaced by EB), **plus a single `/32` rule for
  one admin workstation IP** (tagged `admin-direct-access`, added on
  request so the manager UI / raw REST API can be used directly instead of
  only through apps/api's proxy) — a static allow, not durable against
  that IP changing; re-run `authorize-security-group-ingress` with a fresh
  IP if it does. No SSH port, no rule for `0.0.0.0/0` at all.
- Direct access when the `/32` rule is present:
  `http://100.57.161.176:8080` (base URL) and
  `http://100.57.161.176:8080/manager` (web UI) — same `apikey` header as
  apps/api uses, sourced from `EVOLUTION_API_KEY` in `suchanaai-api-prod`'s
  environment.
- The instance does carry a public IP (`100.57.161.176`) — this VPC has no
  NAT Gateway, so an instance with *no* public IP has *no* route to the
  internet at all (can't reach WhatsApp's servers or SSM). The security
  group is what actually enforces "unreachable from outside," not the
  presence or absence of an IP address. A NAT Gateway would remove the
  public IP entirely at the cost of ~$32-35/mo for a single-number sender —
  a bad trade at this scale; noted as an option in the security group's
  description if requirements ever change.
- No SSH key pair exists for this instance. Management is via **AWS
  Systems Manager Session Manager** (`aws ssm send-command` /
  `aws ssm start-session`) — the IAM role `suchanaai-evolution-ssm-role`
  (instance profile `suchanaai-evolution-ssm-profile`) grants only
  `AmazonSSMManagedInstanceCore`. Zero open management ports, ever.
- Evolution API is **never reachable from the public internet, even for
  the admin QR-link flow** — `AdminWhatsappController`
  (`GET /admin/whatsapp/status`, `POST /admin/whatsapp/qr`,
  `POST /admin/whatsapp/logout`) already proxies through apps/api's own
  authenticated admin routes, so nothing about this deployment needed a
  public DNS record or public port for Evolution API itself.

### Compute — sized for the actual workload, not headroom for its own sake

- `t3.micro` (1 vCPU burstable, 1GB RAM), matching `suchanaai-web-prod` and
  `suchanaai-api-prod`'s existing sizing. A 1GB swapfile is enabled
  (`vm.swappiness=10`, so it's a safety margin for a burst, not the
  steady-state operating mode) as cushion against a spike, not a substitute
  for right-sizing the containers.
- `mem_limit`/`memswap_limit` set per-container in
  `/opt/evolution/docker-compose.yml`: Postgres 220MB, Evolution API
  480MB — leaves ~200MB+ for the OS and Docker daemon on a 1GB host without
  ever touching swap in normal operation (measured: 315MB available with
  both containers up and healthy).
- Postgres tuned down from its defaults for a workload this light —
  `shared_buffers=48MB`, `max_connections=20`, `work_mem=4MB` — a
  general-purpose Postgres default set assumes far more concurrent
  connections and query complexity than "session state for one WhatsApp
  number" ever produces.
- **Message/contact/chat history persistence is disabled**
  (`DATABASE_SAVE_DATA_NEW_MESSAGE=false`, `DATABASE_SAVE_MESSAGE_UPDATE=false`,
  `DATABASE_SAVE_DATA_CONTACTS=false`, `DATABASE_SAVE_DATA_CHATS=false`) —
  only `DATABASE_SAVE_DATA_INSTANCE=true` persists, which is what lets a
  container restart resume the linked session without re-scanning a QR.
  This system sends one-way alerts (confirmed in
  `whatsapp-webhook.controller.ts`: "this app sends alerts one-way, it
  isn't a chatbot") — storing a full inbound/outbound message log would
  grow disk and I/O for data nothing in this codebase ever reads back.
- `CACHE_REDIS_ENABLED=false`, `CACHE_LOCAL_ENABLED=true` — a third
  container (Redis) is not justified for a single sender number's request
  volume; Node's own in-process cache covers it.
- Docker's log driver is capped (`max-size: 10m, max-file: 3` in
  `/etc/docker/daemon.json`) so verbose logging can never fill the disk
  unattended.

### Fast alerts, multiple close together

- "Fast" here means low added latency per alert, not raw throughput —
  WhatsApp itself rate-limits per number regardless of what fronts it, and
  `AlertMatchingService` (apps/api) already processes the alert queue one
  at a time by design, specifically so a burst of new notices can't flood
  WhatsApp with concurrent requests. Evolution API's job is to answer that
  queue's requests **quickly and without queuing on its own end** — which
  is what the memory/DB tuning above is for: a Postgres that isn't
  swapping and a Node process with headroom answers in milliseconds, not
  seconds.
- `EvolutionApiService.sendText` (apps/api) already has its own 15s
  request timeout per call, so a slow/stuck Evolution API request can
  never stall the whole alert queue behind it — this was already correct
  in the application code; the deployment just needs to stay fast enough
  that this timeout is never hit in practice.
- Both containers have Docker healthchecks (`postgres` via `pg_isready`,
  `evolution-api` via an HTTP probe) with `depends_on: condition:
  service_healthy`, and the whole stack is a `systemd` unit
  (`evolution-api.service`, `restart on boot`, `docker restart:
  unless-stopped` at the container level) — a crashed container or a full
  instance reboot both self-heal without anyone needing to SSH in.

### Monitoring

- CloudWatch alarm `suchanaai-evolution-prod-status-check-failed` on the
  instance's built-in `StatusCheckFailed` metric (2 consecutive 5-minute
  periods) — no agent required, this is EC2's own system+instance status
  check. **Not yet wired to a notification target** (no SNS topic exists
  for it) — add one (`aws sns create-topic` + `aws cloudwatch
  put-metric-alarm --alarm-actions <topic-arn>` + an email/Slack
  subscription) if you want to actually be paged on it rather than just
  having the state tracked.

## What was created (for teardown/audit)

| Resource | ID / Name | Purpose |
|---|---|---|
| EC2 instance | `i-0ebc079124469356a` (`suchanaai-evolution-prod`) | Runs the two containers |
| Security group | `sg-06e527ae9229a43da` (`suchanaai-evolution-prod`) | Locks inbound to api-prod + one admin `/32` |
| SG rule | `sgr-023f1ffcb6555e2df` (`admin-direct-access`) | Admin workstation direct access, `160.250.255.48/32` on tcp/8080 |
| IAM role | `suchanaai-evolution-ssm-role` | SSM-only instance access |
| IAM instance profile | `suchanaai-evolution-ssm-profile` | Attaches the role to the instance |
| CloudWatch alarm | `suchanaai-evolution-prod-status-check-failed` | Instance health |
| EB env vars (on `suchanaai-api-prod`) | `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME` | Wires apps/api to the instance |

**Cost**: ~$7.50/mo on-demand for the `t3.micro` (12GB gp3 EBS included),
no NAT Gateway, no ALB, no additional RDS — the smallest footprint this
architecture allows without giving up outbound WhatsApp connectivity.

## Operating it

**Check health** (no SSH — Session Manager or SSM run-command):
```bash
aws ssm send-command --region us-east-1 --instance-ids i-0ebc079124469356a \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker ps","free -h"]'
# then: aws ssm get-command-invocation --command-id <id> --instance-id i-0ebc079124469356a
```

**Interactive shell** (replaces SSH entirely):
```bash
aws ssm start-session --region us-east-1 --target i-0ebc079124469356a
```

**View logs**:
```bash
# via a Session Manager shell, or ssm send-command with:
docker compose -f /opt/evolution/docker-compose.yml logs --tail 200 evolution-api
```

**Link/relink a WhatsApp number**: use the admin panel at
`/admin/alerts` on the web app (`AdminWhatsappCard`) — it calls
`POST /admin/whatsapp/qr` on apps/api, which proxies to Evolution API over
the private network. There is no direct public way to reach Evolution
API's own QR endpoint, by design.

**Restart the stack**:
```bash
aws ssm send-command --region us-east-1 --instance-ids i-0ebc079124469356a \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart evolution-api.service"]'
```

**Upgrade the Evolution API image**: edit the `image:` tag in
`/opt/evolution/docker-compose.yml` on the instance (via Session Manager),
then `docker compose pull && docker compose up -d`. Pinned to `v2.3.7`
(current stable release as of this deployment) rather than `:latest`, so an
upstream release never silently changes behavior on a restart.

**Teardown** (if this is ever decommissioned):
```bash
aws ec2 terminate-instances --region us-east-1 --instance-ids i-0ebc079124469356a
aws ec2 delete-security-group --region us-east-1 --group-id sg-06e527ae9229a43da
aws iam remove-role-from-instance-profile --instance-profile-name suchanaai-evolution-ssm-profile --role-name suchanaai-evolution-ssm-role
aws iam delete-instance-profile --instance-profile-name suchanaai-evolution-ssm-profile
aws iam detach-role-policy --role-name suchanaai-evolution-ssm-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam delete-role --role-name suchanaai-evolution-ssm-role
aws cloudwatch delete-alarms --region us-east-1 --alarm-names suchanaai-evolution-prod-status-check-failed
# and clear EVOLUTION_API_URL/KEY/INSTANCE_NAME from suchanaai-api-prod's env
```
