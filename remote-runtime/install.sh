#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run this installer as root on the remote host.' >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: install.sh <local-model-name> [http://127.0.0.1:11434/v1]' >&2
  exit 1
fi
case "$1" in
  ''|*[!a-zA-Z0-9._:/-]*) echo 'Invalid model name.' >&2; exit 1 ;;
esac
model=$1
url=${2:-http://127.0.0.1:11434/v1}
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bootstrap="$source_dir/bootstrap"
for file in cert.pem key.pem token hostname; do
  if [ ! -f "$bootstrap/$file" ] || [ -L "$bootstrap/$file" ]; then
    echo "Missing bootstrap/$file; use a host-specific archive." >&2
    exit 1
  fi
done
if [ -e /etc/jarvis-remote-agent/agent.env ] || [ -e /etc/systemd/system/jarvis-remote-agent.service ]; then
  echo 'Already installed; refusing to replace credentials or the service.' >&2
  exit 1
fi
if [ ! -x /usr/bin/node ]; then
  echo 'Node.js 20+ is required at /usr/bin/node by the service unit.' >&2
  exit 1
fi
if ! /usr/bin/node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { localModelURL } = await import(pathToFileURL(process.argv[1]));
  localModelURL(process.argv[2]);
' "$source_dir/remote-runtime/worker.mjs" "$url"; then
  echo 'Invalid numeric-loopback model URL.' >&2
  exit 1
fi
if [ "$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0]) >= 20')" != true ]; then
  echo 'Node.js 20 or newer is required.' >&2
  exit 1
fi
for command in openssl systemctl useradd; do
  command -v "$command" >/dev/null || { echo "Missing $command." >&2; exit 1; }
done
hostname=$(cat "$bootstrap/hostname")
openssl verify -CAfile "$bootstrap/cert.pem" -verify_hostname "$hostname" "$bootstrap/cert.pem" >/dev/null
if ! id jarvis-remote >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/jarvis-remote-agent --shell /usr/sbin/nologin jarvis-remote
fi
install -d -o jarvis-remote -g jarvis-remote -m 0700 /var/lib/jarvis-remote-agent /var/lib/jarvis-remote-agent/state /var/lib/jarvis-remote-agent/work
install -d -o root -g root -m 0755 /opt/jarvis-remote-agent /opt/jarvis-remote-agent/releases
install -d -o root -g jarvis-remote -m 0750 /etc/jarvis-remote-agent
install -o root -g jarvis-remote -m 0640 "$bootstrap/key.pem" /etc/jarvis-remote-agent/key.pem
install -o root -g jarvis-remote -m 0644 "$bootstrap/cert.pem" /etc/jarvis-remote-agent/cert.pem

release="/opt/jarvis-remote-agent/releases/$(date +%Y%m%d%H%M%S)-$$"
install -d -o root -g root -m 0755 "$release"
for entry in agents bridge remote-runtime package.json package-lock.json LICENSE; do
  cp -R "$source_dir/$entry" "$release/"
done
rm -f "$release/remote-runtime/install.sh"
ln -sfn "$release" /opt/jarvis-remote-agent/current
{
  printf 'JARVIS_AGENTS_TOKEN=%s\n' "$(cat "$bootstrap/token")"
  printf 'JARVIS_AGENTS_TLS_CERT=/etc/jarvis-remote-agent/cert.pem\n'
  printf 'JARVIS_AGENTS_TLS_KEY=/etc/jarvis-remote-agent/key.pem\n'
  printf 'JARVIS_REMOTE_MODEL_URL=%s\n' "$url"
  printf 'JARVIS_REMOTE_MODEL=%s\n' "$model"
} > /etc/jarvis-remote-agent/agent.env
chown root:jarvis-remote /etc/jarvis-remote-agent/agent.env
chmod 0640 /etc/jarvis-remote-agent/agent.env
install -o root -g root -m 0644 "$source_dir/jarvis-remote-agent.service" /etc/systemd/system/jarvis-remote-agent.service
systemctl daemon-reload
systemctl enable --now jarvis-remote-agent
echo 'Remote agent installed. Remove the transferred archive and extracted bootstrap files after verifying service health.'