#!/usr/bin/env bash
# ── Remove Ollama (qwen2.5:7b) from EC2 services i-071d7b2debed5e3ed ─────────
# Host: t3.large (2 vCPU, 7.6 GiB), public 3.80.188.210, private 172.31.95.204
# Ollama endpoint: http://172.31.95.204:11434  (public http://3.80.188.210:11434/v1/chat/completions)
# Run: chmod +x scripts/ec2-remove-ollama.sh && ./scripts/ec2-remove-ollama.sh
# Or ssh manually and paste the block inside the heredoc.
set -euo pipefail

EC2_PUBLIC="3.80.188.210"
EC2_PRIVATE="172.31.95.204"
EC2_ID="i-071d7b2debed5e3ed"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ssh-key-2026-07-23.key}" # adjust: ssh-key-suchana-ai.key etc.
SSH_USER="${SSH_USER:-ubuntu}"  # try ubuntu, then ec2-user

DB_HOST="141.148.209.235"
DB_NAME="${DB_NAME:-public_notice_management}"
DB_USER="${DB_USER:-postgres}"

echo "==> [1/6] Verifying EC2 $EC2_ID ($EC2_PUBLIC / $EC2_PRIVATE) is running"
aws ec2 describe-instances --instance-ids "$EC2_ID" --query "Reservations[0].Instances[0].{State:State.Name,Type:InstanceType,IP:PublicIpAddress,Private:PrivateIpAddress}" --output table || true

echo "==> [2/6] SSH → $EC2_PUBLIC : stop & remove Ollama + qwen2.5:7b"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "${SSH_USER}@${EC2_PUBLIC}" bash -s <<'EOSSH'
set -xeuo pipefail
echo "--- host ---"
hostname; lscpu | head -n 5; free -h; df -h | head -n 10
echo "--- listening ports before ---"
ss -tlnp | grep -E '11434|8000|8001' || echo "no 11434/8000 listener yet"
echo "--- ollama processes ---"
ps aux | grep -i ollama | grep -v grep || echo "no ollama ps"
systemctl status ollama 2>&1 | head -n 30 || echo "no systemd ollama"
docker ps -a 2>&1 | head -n 20 || echo "no docker or not running"

# 1) Try ollama CLI remove model (if installed)
if command -v ollama >/dev/null 2>&1; then
  echo "--- ollama list ---"
  ollama list || true
  echo "--- ollama rm qwen2.5:7b ---"
  ollama rm qwen2.5:7b || true
  ollama rm qwen2.5 || true
fi

# 2) Stop systemd service (official Ollama install.sh creates this)
sudo systemctl stop ollama 2>/dev/null || true
sudo systemctl disable ollama 2>/dev/null || true
sudo pkill -f ollama 2>/dev/null || true

# 3) Docker variant (if Ollama was containerized)
if command -v docker >/dev/null 2>&1; then
  docker stop ollama 2>/dev/null || true
  docker rm -f ollama 2>/dev/null || true
  docker rmi ollama/ollama 2>/dev/null || true
  # also catch any container exposing 11434
  docker ps -a --format '{{.ID}} {{.Image}} {{.Ports}}' | grep 11434 || true
fi

# 4) Remove binaries & models
sudo rm -f /usr/local/bin/ollama /usr/bin/ollama 2>/dev/null || true
sudo rm -rf /usr/share/ollama /var/lib/ollama 2>/dev/null || true
rm -rf ~/.ollama 2>/dev/null || true
sudo rm -rf /opt/ollama 2>/dev/null || true

# 5) Clean disk
echo "--- disk after removal ---"
df -h
du -sh ~/.ollama /usr/share/ollama /var/lib/ollama 2>&1 | head -n 20 || true
if command -v docker >/dev/null 2>&1; then
  docker system prune -f 2>/dev/null || true
fi
sudo journalctl --vacuum-size=100M 2>/dev/null || true

echo "--- listening ports after ---"
ss -tlnp | grep 11434 || echo "11434 closed ✓"
curl -sf http://127.0.0.1:11434/api/tags 2>&1 | head -n 5 && echo "WARNING: still responding" || echo "Ollama not responding ✓"

echo "--- final disk/memory ---"
free -h; df -h | head -n 10
EOSSH

echo "==> [3/6] Verify externally that 11434 is closed"
curl -v --connect-timeout 5 "http://${EC2_PUBLIC}:11434/api/tags" 2>&1 | head -n 20 && echo "WARN: still open" || echo "External 11434 closed ✓"
curl -v --connect-timeout 5 "http://${EC2_PRIVATE}:11434/api/tags" 2>&1 | head -n 20 || true  # will fail from outside VPC, expected

echo "==> [4/6] DB cleanup: remove ai_providers slug='ollama-services' on ${DB_HOST}"
echo "    Run this from a host that can reach ${DB_HOST}:5432"
echo "    (If psql is local, it will run now; otherwise ssh to API host and run)"
if command -v psql >/dev/null 2>&1; then
  echo "SELECT slug, label, baseUrl, model FROM ai_providers WHERE slug LIKE '%ollama%';" | PGPASSWORD="${PGPASSWORD:-}" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT slug, label, baseUrl, model, enabled FROM ai_providers WHERE slug LIKE '%ollama%';" || echo "psql select failed — run manually"
  echo "DELETE FROM ai_providers WHERE slug = 'ollama-services';" | PGPASSWORD="${PGPASSWORD:-}" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "DELETE FROM ai_providers WHERE slug = 'ollama-services';" || true
  # also catch preset-derived slug if admin clicked the preset before
  PGPASSWORD="${PGPASSWORD:-}" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "DELETE FROM ai_providers WHERE slug IN ('ollama-qwen2-5-7b-ec2-services','ollama','ollama-services') OR baseUrl LIKE '%11434%';" || true
  PGPASSWORD="${PGPASSWORD:-}" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT slug, label FROM ai_providers ORDER BY sort_order;" || true
else
  cat <<'EOSQL'
# Manual SQL — run on any host with psql access to 141.148.209.235:
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "SELECT slug, label, baseUrl, model FROM ai_providers WHERE slug LIKE '%ollama%';"
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "DELETE FROM ai_providers WHERE slug = 'ollama-services';"
# also sweep preset slug + any 11434 leftover:
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "DELETE FROM ai_providers WHERE slug IN ('ollama-qwen2-5-7b-ec2-services','ollama') OR baseUrl LIKE '%11434%';"
PGPASSWORD="<secret>" psql -h 141.148.209.235 -U postgres -d public_notice_management -c "SELECT slug, label FROM ai_providers ORDER BY sort_order;"
EOSQL
fi

echo "==> [5/6] Code: provider-dialog preset removed"
echo "    File: apps/web/components/admin/provider-dialog.tsx:63-70 — Ollama preset replaced by vLLM preset"
echo "    Commit this change: git diff apps/web/components/admin/provider-dialog.tsx"

echo "==> [6/6] Security group: optionally close 11434"
echo "    aws ec2 revoke-security-group-ingress --group-id sg-xxxxxxxx --protocol tcp --port 11434 --cidr 0.0.0.0/0  (or your SG)"
echo "    Check current: aws ec2 describe-security-groups --group-ids sg-xxxxxxxx --query 'SecurityGroups[0].IpPermissions'"
echo ""
echo "Done. Ollama removed, DB swept, preset cleaned. Next: run scripts/ec2-install-vllm.sh"
