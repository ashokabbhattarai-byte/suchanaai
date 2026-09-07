# Deploying Evolution API (WhatsApp integration) on the Oracle box

> **Superseded for the current deployment.** This system now runs on AWS
> (see `docs/AWS_DEPLOYMENT.md`), and Evolution API is live there — see
> `docs/EVOLUTION_API_AWS_DEPLOYMENT.md` for the actual, current deployment
> (a dedicated private EC2 instance wired into `suchanaai-api-prod`). This
> doc is kept for reference (the Evolution API concepts in §1 and the
> general open-source-project evaluation checklist in §14 are unchanged)
> but its docker-compose/Caddy steps apply to the Oracle box, not AWS.

> Companion to `DEPLOY.md` (the Oracle Cloud production setup this extends)
> and `apps/api/src/webhooks/` (the code that receives what this produces).
> `DEPLOY.md` explicitly deferred this: *"WhatsApp (Evolution API) integration
> is intentionally skipped for this first pass — leave
> `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` unset."* This doc is that deferred
> step.

---

## Table of contents

1. [What Evolution API is, and the open-source concept behind it](#1-what-evolution-api-is-and-the-open-source-concept-behind-it)
2. [Architecture: where this fits on your box](#2-architecture-where-this-fits-on-your-box)
3. [Before you start](#3-before-you-start)
4. [Step 1 — Generate your own API key](#step-1--generate-your-own-api-key)
5. [Step 2 — Add the service to docker-compose.yml](#step-2--add-the-service-to-docker-composeyml)
6. [Step 3 — Add a Caddy route + DNS record](#step-3--add-a-caddy-route--dns-record)
7. [Step 4 — Wire the env vars into apps/api](#step-4--wire-the-env-vars-into-appsapi)
8. [Step 5 — Launch](#step-5--launch)
9. [Step 6 — Create an instance and link WhatsApp](#step-6--create-an-instance-and-link-whatsapp)
10. [Step 7 — Confirm the webhook round-trip](#step-7--confirm-the-webhook-round-trip)
11. [Operating it long-term](#11-operating-it-long-term)
12. [Troubleshooting](#12-troubleshooting)
13. [Environment variable reference](#13-environment-variable-reference)
14. [General principle: how to evaluate and run any self-hosted open-source project](#14-general-principle-how-to-evaluate-and-run-any-self-hosted-open-source-project)

---

## 1. What Evolution API is, and the open-source concept behind it

**Evolution API** ([github.com/EvolutionAPI/evolution-api](https://github.com/EvolutionAPI/evolution-api))
is a self-hosted REST API that lets a backend (yours: `apps/api`) send and
receive WhatsApp messages programmatically. It is **not** Meta's official
WhatsApp Business API. Internally it uses **Baileys**, an unofficial library
that speaks the same protocol WhatsApp Web uses in a browser. That's the
entire reason it can be free and self-hosted: Meta's real Business API
requires business verification and per-message billing; Baileys-based tools
sidestep that by impersonating a linked device.

**What "open source" means for a project like this, concretely:**

- The full source is public on GitHub, licensed **Apache-2.0** — a permissive
  license. You may self-host it, modify it, and even build a commercial
  product on top of it, for free, as long as you keep the license/copyright
  notice intact. There is no warranty and no vendor obligated to support you.
- It's distributed two ways: the raw source (clone + build yourself) or
  **prebuilt Docker images** published to Docker Hub/GHCR
  (`evoapicloud/evolution-api`) — the practical way almost everyone runs it,
  including this guide.
- Self-hosting trades a subscription fee for **your own operational
  responsibility**: you own upgrades, backups, and uptime. Nobody pages you
  when it goes down.
- **Known risk, stated plainly**: because it emulates WhatsApp Web rather
  than using an official, sanctioned integration, it operates outside
  WhatsApp's terms of service. In practice this is normal and widely used at
  small-to-medium scale, but there's a non-zero chance of a linked number
  getting flagged or logged out, especially under high message volume or
  bot-like sending patterns. Know this going in — it's a tradeoff you're
  accepting, not a bug you can file.

---

## 2. Architecture: where this fits on your box

Your Oracle instance already runs, per `DEPLOY.md` and the live
`docker-compose.yml`: `web`, `api`, `ai`, Postgres, Qdrant, and Caddy
(automatic HTTPS reverse proxy). This adds **one more container**,
`evolution-api`, that:

- Talks to WhatsApp's servers directly (outbound only — no inbound WhatsApp
  traffic to your box).
- Stores linked-session state + message history in **a second database on
  the Postgres you already run** (`evolution`, separate from
  `public_notice_management`) — no new database server.
- Gets its own Caddy subdomain (`evolution.yourdomain.com`) purely so *you*
  can reach its REST API and QR-linking screen from outside — WhatsApp
  itself never calls this URL.
- Pushes incoming WhatsApp messages to `apps/api`'s existing webhook route
  under `apps/api/src/webhooks/` via an outbound HTTP call — `apps/api`
  never polls Evolution API, it just receives.

```
WhatsApp ⇄ (Baileys/WS) ⇄ evolution-api container ──webhook POST──▶ apps/api
                               │
                               ▼
                    Postgres (db: evolution)
```

---

## 3. Before you start

- SSH access to the Oracle box (same one running the rest of the stack).
- The root `POSTGRES_PASSWORD` you're already using there (`DEPLOY.md` §9).
- A spare subdomain you control DNS for, e.g. `evolution.yourdomain.com`.
- Five minutes with `openssl` to generate a key (next step).

---

## Step 1 — Generate your own API key

This is **not** something Evolution API gives you — you invent it, and it
becomes the bearer token every request (yours and WhatsApp's webhook calls)
must present.

```bash
openssl rand -hex 24
```

Save this value — you'll use it twice: once as `AUTHENTICATION_API_KEY` for
the Evolution API container, and again as `EVOLUTION_API_KEY` in
`apps/api/.env.prod` (they must match exactly).

---

## Step 2 — Add the service to docker-compose.yml

Add this service to the root `docker-compose.yml`, alongside your existing
`postgres`, `qdrant`, `api`, `ai`, `web`, `caddy` services:

```yaml
  evolution-api:
    image: evoapicloud/evolution-api:v2.2.3   # pin a version — see §11
    restart: unless-stopped
    environment:
      AUTHENTICATION_API_KEY: ${EVOLUTION_API_KEY}
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/evolution
      DATABASE_SAVE_DATA_INSTANCE: "true"
      DATABASE_SAVE_DATA_NEW_MESSAGE: "true"
      DATABASE_SAVE_MESSAGE_UPDATE: "true"
      DATABASE_SAVE_DATA_CONTACTS: "true"
      DATABASE_SAVE_DATA_CHATS: "true"
      SERVER_URL: https://evolution.yourdomain.com
      WEBHOOK_GLOBAL_URL: https://api.yourdomain.com/webhooks/whatsapp
      WEBHOOK_GLOBAL_ENABLED: "true"
      WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS: "false"
      LOG_LEVEL: ERROR
    volumes:
      - evolution_instances:/evolution/instances
    depends_on:
      postgres:
        condition: service_healthy
    mem_limit: 512m
```

Add the named volume alongside your existing ones:

```yaml
volumes:
  # ...your existing volumes (postgres_data, qdrant_data, ai_uploads, etc.)
  evolution_instances:
```

**Why each nonstandard bit matters:**
- `evolution_instances` volume — this is where the linked-WhatsApp-session
  credentials live. Lose this volume (e.g. `docker compose down -v`) and you
  must re-scan the QR code from scratch.
- `DATABASE_SAVE_DATA_*` flags — control what gets persisted to Postgres vs.
  kept only in memory. All `true` here so a container restart doesn't lose
  message history; drop any you don't need to reduce DB growth.
- `mem_limit: 512m` — Evolution API itself is lightweight (it's not loading
  an ML model like `apps/ai` does); 512m is generous headroom, adjust down
  if your box is tight.

Create the second database once, on the box:

```bash
docker compose exec postgres psql -U postgres -c "CREATE DATABASE evolution;"
```

---

## Step 3 — Add a Caddy route + DNS record

**DNS**: point `evolution.yourdomain.com` (A record) at your box's public IP,
same as your other subdomains.

**Caddyfile** — add a new block:

```
evolution.yourdomain.com {
    reverse_proxy evolution-api:8080
}
```

Caddy fetches its own Let's Encrypt certificate for the new subdomain
automatically the moment DNS resolves and the container restarts — nothing
else to configure for TLS.

---

## Step 4 — Wire the env vars into apps/api

In `apps/api/.env.prod` on the box (per `DEPLOY.md` §9), set:

```
EVOLUTION_API_URL=http://evolution-api:8080
EVOLUTION_API_KEY=<the same value from Step 1>
EVOLUTION_INSTANCE_NAME=suchanaai
```

Note `EVOLUTION_API_URL` uses the **internal Docker service name**
(`evolution-api:8080`), not the public `evolution.yourdomain.com` URL —
`apps/api` and `evolution-api` are on the same Docker Compose network and
should talk to each other directly, not round-trip through Caddy/the public
internet.

---

## Step 5 — Launch

```bash
docker compose up -d evolution-api
docker compose logs -f evolution-api
```

Watch for a line indicating the server started and connected to Postgres
successfully — no linked WhatsApp session yet, that's expected at this
point.

```bash
curl -I https://evolution.yourdomain.com
```

Should return a response (likely `401`/`404` on the bare root — that's fine,
it means Caddy + the container are both up; you haven't authenticated yet).

---

## Step 6 — Create an instance and link WhatsApp

1. Create the instance (name must match `EVOLUTION_INSTANCE_NAME`):

   ```bash
   curl -X POST https://evolution.yourdomain.com/instance/create \
     -H "apikey: <your API key>" \
     -H "Content-Type: application/json" \
     -d '{
       "instanceName": "suchanaai",
       "qrcode": true,
       "integration": "WHATSAPP-BAILEYS"
     }'
   ```

2. Fetch the QR code:

   ```bash
   curl https://evolution.yourdomain.com/instance/connect/suchanaai \
     -H "apikey: <your API key>"
   ```

   This returns a `base64` QR image (or a `pairingCode` for phone-number
   pairing instead of scanning, depending on the payload you send).

3. On the WhatsApp account you want to send/receive from: **WhatsApp app →
   Settings → Linked Devices → Link a Device**, and scan the QR code (decode
   the base64 into an image first — or use Evolution API's built-in manager
   UI at `/manager` if you enabled it, which renders the QR directly in the
   browser).

4. Once linked, `GET /instance/fetchInstances` (with your API key) should
   show `"connectionStatus": "open"` for `suchanaai`.

This session persists in the `evolution_instances` volume + Postgres — a
container restart does **not** require re-scanning, only a volume loss or a
WhatsApp-side forced logout does.

---

## Step 7 — Confirm the webhook round-trip

Send yourself a test WhatsApp message to the linked number, then check:

```bash
docker compose logs -f api | grep -i whatsapp
```

You should see `apps/api`'s webhook handler (`apps/api/src/webhooks/`)
receive the inbound POST. If nothing shows up, see the troubleshooting table
below — this is almost always a `WEBHOOK_GLOBAL_URL` mismatch or the webhook
route not being reachable from inside the `evolution-api` container.

Then send a message *out*, to confirm the other direction:

```bash
curl -X POST https://evolution.yourdomain.com/message/sendText/suchanaai \
  -H "apikey: <your API key>" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "9779800000000",
    "text": "Test from suchanaai"
  }'
```

---

## 11. Operating it long-term

- **Pin the image version**, never `evoapicloud/evolution-api:latest`. A
  floating tag means a routine `docker compose pull` could silently change
  the webhook payload shape or auth behavior underneath `apps/api` without
  you choosing to upgrade. Check the [GitHub Releases
  page](https://github.com/EvolutionAPI/evolution-api/releases) and read the
  changelog before bumping the pinned version.
- **Back up the `evolution` Postgres database and the `evolution_instances`
  volume** the same way you back up `public_notice_management` — nothing
  does this for you automatically on self-hosted infra.
- **Rotate `AUTHENTICATION_API_KEY`** if it's ever exposed (e.g. committed to
  git by accident) — update it in both the container's env and
  `apps/api/.env.prod` together, or the two will stop agreeing.
- **Monitor for forced logouts.** WhatsApp can unlink the device
  server-side at any time; watch `connectionStatus` and consider alerting on
  it flipping away from `"open"`.

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `evolution-api` container exits immediately | `DATABASE_CONNECTION_URI` wrong, or the `evolution` database doesn't exist yet (Step 2's `CREATE DATABASE`) |
| QR code never shows as "connected" | Phone lost internet mid-scan, or `qrcode: true` wasn't set on instance creation — delete the instance and recreate |
| `apps/api` never receives webhook events | `WEBHOOK_GLOBAL_URL` typo, `WEBHOOK_GLOBAL_ENABLED` not `"true"`, or the URL isn't reachable from inside the `evolution-api` container (test with `docker compose exec evolution-api curl -I http://api:3001/webhooks/whatsapp`) |
| Instance shows `"close"` after working fine for a while | WhatsApp forced a logout (device unlinked from the phone side, or flagged for automation) — re-link via Step 6 |
| `429`/rate-limit-like message failures | Sending too fast / bulk-messaging pattern — WhatsApp actively watches for this; add delay between sends |
| Works locally, fails on the box | `EVOLUTION_API_URL` in `apps/api/.env.prod` pointing at `localhost:8080` instead of `evolution-api:8080` — Docker service names, not localhost, resolve between containers |

---

## 13. Environment variable reference

| Variable | Where | Purpose |
|---|---|---|
| `AUTHENTICATION_API_KEY` | `evolution-api` container env | The bearer token all API calls (yours + webhook auth) must present. You generate this. |
| `DATABASE_CONNECTION_URI` | `evolution-api` container env | Points at the `evolution` database on your existing Postgres |
| `SERVER_URL` | `evolution-api` container env | Public URL Evolution API reports about itself (used in some response payloads) |
| `WEBHOOK_GLOBAL_URL` | `evolution-api` container env | Where inbound WhatsApp events get POSTed — your `apps/api` webhook route |
| `EVOLUTION_API_URL` | `apps/api/.env.prod` | Internal Docker address `apps/api` uses to call Evolution API (`http://evolution-api:8080`) |
| `EVOLUTION_API_KEY` | `apps/api/.env.prod` | Must exactly match `AUTHENTICATION_API_KEY` above |
| `EVOLUTION_INSTANCE_NAME` | `apps/api/.env.prod` | The instance name used in Step 6 — `apps/api` sends/receives against this specific instance |

---

## 14. General principle: how to evaluate and run any self-hosted open-source project

A reusable checklist, not specific to Evolution API:

1. **Read the license before you deploy, not after.** Permissive
   (MIT/Apache-2.0) means "do almost anything." Copyleft (AGPL/GPL) can
   obligate you to open-source *your* code if you build a hosted product on
   top of it — check this before it's a legal surprise.
2. **Prefer the official Docker image over building from source**, unless
   you have a specific reason not to — it's tested by the maintainers and
   saves you from replicating their build environment.
3. **Pin versions.** Treat `:latest` as "I am volunteering to be the first
   to find tomorrow's regression."
4. **Read the env var reference in full before your first deploy** — most
   self-hosted tools have footguns that only show up in production traffic
   (data retention flags, webhook signing, rate limits).
5. **You own backups, monitoring, and upgrades.** A SaaS equivalent would
   handle all three; self-hosting is explicitly trading that convenience for
   cost and control.
6. **Community support only** — GitHub Issues/Discord, not a support
   contract. Budget your own debugging time, and check open issues for your
   exact symptom before assuming it's unique to your setup.
