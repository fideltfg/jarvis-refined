#!/usr/bin/env bash
# Full-up install: bridge + face (jarvis.service) and the agent service
# (jarvis-agents.service) as systemd user units that start at boot.
# Re-runnable. On any failure it rolls back what this run changed and reports.
#
#   scripts/install.sh [--readonly] [--production]
#
# Host-specific settings (LAN host, TLS, origins, ports) live in
# ~/.config/jarvis/service.env; secrets stay in ~/.config/jarvis/secrets.env.
set -Eeuo pipefail
umask 077

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

MODE=--writes
LAUNCHER=scripts/start.mjs
for arg in "$@"; do
  case "$arg" in
    --readonly) MODE= ;;
    --production) LAUNCHER=scripts/serve.mjs ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

REPO=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CONF_DIR="$HOME/.config/jarvis"
ENV_FILE="$CONF_DIR/service.env"
UNIT_DIR="$HOME/.config/systemd/user"
UNITS=(jarvis-agents.service jarvis.service)
MARKER='# Managed by jarvis-refined/scripts/install.sh'

if [[ -t 1 ]]; then B=$'\e[1m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'; else B= R= G= Y= N=; fi
STEP='starting'
step() { STEP=$1; printf '%s==>%s %s\n' "$B" "$N" "$1"; }
ok()   { printf '    %sok%s  %s\n' "$G" "$N" "$1"; }
note() { printf '    %snote%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '%sERROR%s (%s): %s\n' "$R" "$N" "$STEP" "$1" >&2; exit 1; }

# ---- rollback state ---------------------------------------------------------
WORK=$(mktemp -d)
BACKUP_DIR="$CONF_DIR/backups/$(date +%Y%m%d-%H%M%S)-$$"
CHANGED=0
LINGER_ENABLED=0
declare -A WAS_ENABLED WAS_ACTIVE BACKED_UP

# Call before modifying a file; the backup dir is only created if something is actually changed.
backup_file() {
  local f=$1
  [[ -z ${BACKED_UP[$f]:-} ]] || return 0
  if [[ -f $f ]]; then
    mkdir -p "$BACKUP_DIR"
    cp -p "$f" "$BACKUP_DIR/$(basename "$f")"
    BACKED_UP[$f]="$BACKUP_DIR/$(basename "$f")"
    note "backed up $f -> ${BACKED_UP[$f]}"
  else
    BACKED_UP[$f]=none
  fi
}

rollback() {
  printf '%s==>%s Rolling back changes from this run\n' "$B" "$N" >&2
  for u in "${UNITS[@]}"; do systemctl --user stop "$u" >/dev/null 2>&1 || true; done
  for f in "${!BACKED_UP[@]}"; do
    if [[ ${BACKED_UP[$f]} == none ]]; then rm -f "$f"; else cp -p "${BACKED_UP[$f]}" "$f"; fi
    echo "    restored $f" >&2
  done
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  for u in "${UNITS[@]}"; do
    if [[ ${WAS_ENABLED[$u]:-0} == 1 ]]; then
      systemctl --user enable "$u" >/dev/null 2>&1 || true
    else
      systemctl --user disable "$u" >/dev/null 2>&1 || true
    fi
    if [[ ${WAS_ACTIVE[$u]:-0} == 1 ]]; then systemctl --user start "$u" >/dev/null 2>&1 || true; fi
  done
  echo '    previous service state restored.' >&2
}

rollback_linger() {
  if loginctl disable-linger "$USER" 2>/dev/null || sudo -n loginctl disable-linger "$USER" 2>/dev/null; then
    echo '    start at boot (linger) disabled again.' >&2
  else
    printf '%sWARNING%s could not disable linger; run:  sudo loginctl disable-linger %s\n' "$Y" "$N" "$USER" >&2
  fi
}

on_exit() {
  local code=$?
  trap - ERR
  if [[ $code -ne 0 ]]; then
    printf '%sInstall failed%s during: %s\n' "$R" "$N" "$STEP" >&2
    if [[ $CHANGED == 1 ]]; then rollback; fi
    if [[ $LINGER_ENABLED == 1 ]]; then rollback_linger; fi
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap on_exit EXIT
trap 'die "command failed (line $LINENO): $BASH_COMMAND"' ERR

# ---- preflight (no changes yet) -----------------------------------------------
step 'Preflight checks'
[[ $(id -u) -ne 0 ]] || die 'run as the user who will own JARVIS, not root (these are systemd user units).'
case "$REPO" in *[%\"\\$'\n']*) die "repo path contains characters systemd cannot take literally: $REPO" ;; esac
[[ -f $REPO/package.json && -f $REPO/bridge/server.mjs && -f $REPO/agents/service.mjs ]] \
  || die "$REPO does not look like a jarvis-refined checkout."

command -v systemctl >/dev/null || die 'systemctl not found; systemd is required.'
command -v loginctl >/dev/null || die 'loginctl not found; systemd-logind is required for boot start.'
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
systemctl --user show-environment >/dev/null 2>&1 \
  || die "cannot reach the systemd user manager (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR). Log in directly as $USER rather than via su/sudo."

NODE=
for c in "$HOME/.local/node/bin/node" "$(command -v node || true)"; do
  [[ -n $c && -x $c ]] && { NODE=$(readlink -f "$c"); break; }
done
[[ -n $NODE ]] || die 'Node.js not found (looked in ~/.local/node/bin and PATH).'
NODE_DIR=$(dirname "$NODE")
case "$NODE_DIR" in *[%\"\\$'\n']*) die "node path contains characters systemd cannot take literally: $NODE" ;; esac
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' \
  || die "Node.js 20+ required; $NODE is $("$NODE" --version)."
NPM="$NODE_DIR/npm"
[[ -x $NPM ]] || NPM=$(command -v npm || true)
[[ -n $NPM ]] || die 'npm not found next to node or on PATH.'
ok "node $("$NODE" --version) at $NODE"

mkdir -p "$CONF_DIR" "$UNIT_DIR"
exec 9>"$CONF_DIR/.install.lock"
if command -v flock >/dev/null; then
  flock -n 9 || die 'another install is already running.'
fi

if [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no) != yes ]]; then
  step 'Enabling start at boot (systemd linger)'
  loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null \
    || die "could not enable linger. Run once:  sudo loginctl enable-linger $USER  then re-run this script."
  LINGER_ENABLED=1
fi
ok 'linger enabled (user services start at boot without a login)'

# ---- dependencies --------------------------------------------------------------
step 'Dependencies'
if [[ $LAUNCHER == scripts/serve.mjs ]]; then
  [[ -f $REPO/dist/index.html && -f $REPO/scripts/serve.mjs && -d $REPO/node_modules/ws && -d $REPO/node_modules/@anthropic-ai/claude-agent-sdk ]] \
    || die 'production mode requires a built release with runtime dependencies.'
  ok 'using packaged frontend and runtime dependencies'
elif [[ ! -f $REPO/node_modules/.package-lock.json || $REPO/package-lock.json -nt $REPO/node_modules/.package-lock.json ]]; then
  (cd "$REPO" && PATH="$NODE_DIR:$PATH" "$NPM" ci --no-audit --no-fund) || die 'npm ci failed (see output above).'
  ok 'installed from package-lock.json'
else
  ok 'node_modules up to date'
fi

# ---- snapshot current state for rollback --------------------------------------
for u in "${UNITS[@]}"; do
  WAS_ENABLED[$u]=0; WAS_ACTIVE[$u]=0
  if systemctl --user is-enabled --quiet "$u" 2>/dev/null; then WAS_ENABLED[$u]=1; fi
  if systemctl --user is-active --quiet "$u" 2>/dev/null; then WAS_ACTIVE[$u]=1; fi
done
CHANGED=1

# ---- secrets & service config -------------------------------------------------
step 'Agent token'
if ! grep -qs '^JARVIS_AGENTS_TOKEN=' "$CONF_DIR/secrets.env"; then backup_file "$CONF_DIR/secrets.env"; fi
(cd "$REPO" && "$NODE" scripts/agents-token.mjs) >/dev/null || die 'could not write JARVIS_AGENTS_TOKEN.'
chmod 600 "$CONF_DIR/secrets.env"
ok "JARVIS_AGENTS_TOKEN present in $CONF_DIR/secrets.env"

step 'Service environment'
if [[ ! -f $ENV_FILE ]]; then
  backup_file "$ENV_FILE"
  {
    echo '# Host settings for jarvis.service / jarvis-agents.service (systemd EnvironmentFile syntax).'
    echo '# For LAN access set JARVIS_HOST=0.0.0.0, JARVIS_TLS_CERT/KEY and JARVIS_ALLOWED_ORIGINS.'
    # Carry over settings from a hand-written jarvis.service so the migration loses nothing.
    if [[ -f $UNIT_DIR/jarvis.service ]] && ! grep -qF "$MARKER" "$UNIT_DIR/jarvis.service"; then
      grep -E '^Environment=' "$UNIT_DIR/jarvis.service" | sed -E 's/^Environment=//' \
        | grep -vE '^"?(PATH|NO_COLOR)=' | sed -E "s/^\"(.*)\"\$/\1/; s#%h#$HOME#g" || true
    fi
  } > "$ENV_FILE"
  ok "created $ENV_FILE"
fi
if ! grep -qE '^JARVIS_AGENTS=' "$ENV_FILE"; then
  backup_file "$ENV_FILE"
  if [[ -s $ENV_FILE && $(tail -c1 "$ENV_FILE") != '' ]]; then echo >> "$ENV_FILE"; fi
  echo 'JARVIS_AGENTS=1' >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
grep -qE '^JARVIS_AGENTS=1$' "$ENV_FILE" || note "JARVIS_AGENTS is not 1 in $ENV_FILE; the bridge will not use the agent service."
ok "bridge -> agent service enabled via $ENV_FILE"

env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"' || true; }
BRIDGE_PORT=$(env_value JARVIS_BRIDGE_PORT); BRIDGE_PORT=${BRIDGE_PORT:-8787}
AGENTS_PORT=$(env_value JARVIS_AGENTS_PORT); AGENTS_PORT=${AGENTS_PORT:-8788}
FACE_PORT=$(env_value PORT); FACE_PORT=${FACE_PORT:-5173}

# ---- unit files ----------------------------------------------------------------
step 'systemd units'
render_unit() {
  case "$1" in
    jarvis-agents.service) cat <<EOF
$MARKER
[Unit]
Description=J.A.R.V.I.S. agent service (goals, coordinator, background workers)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=NO_COLOR=1
EnvironmentFile=-%h/.config/jarvis/secrets.env
EnvironmentFile=-%h/.config/jarvis/service.env
ExecStart="$NODE" agents/service.mjs
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF
    ;;
    jarvis.service) cat <<EOF
$MARKER
[Unit]
Description=J.A.R.V.I.S. (bridge + web face)
After=network-online.target jarvis-agents.service
Wants=network-online.target jarvis-agents.service

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=PATH=$NODE_DIR:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NO_COLOR=1
EnvironmentFile=-%h/.config/jarvis/secrets.env
EnvironmentFile=-%h/.config/jarvis/service.env
ExecStart="$NODE" $LAUNCHER${MODE:+ $MODE}
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF
    ;;
  esac
}
for u in "${UNITS[@]}"; do
  render_unit "$u" > "$WORK/$u.new"
  if [[ -f $UNIT_DIR/$u ]] && cmp -s "$WORK/$u.new" "$UNIT_DIR/$u"; then
    ok "$u unchanged"
  else
    backup_file "$UNIT_DIR/$u"
    install -m 0644 "$WORK/$u.new" "$UNIT_DIR/$u"
    ok "$u written"
  fi
done
if command -v systemd-analyze >/dev/null; then
  if VERIFY=$(systemd-analyze --user verify "${UNITS[@]/#/$UNIT_DIR/}" 2>&1) && [[ -z $VERIFY ]]; then
    ok 'units verified'
  else
    echo "$VERIFY" >&2
    die 'unit verification reported problems (above).'
  fi
fi
systemctl --user daemon-reload

# ---- enable & start ------------------------------------------------------------
step 'Enable and (re)start services'
systemctl --user enable "${UNITS[@]}" >/dev/null 2>&1 || die 'systemctl enable failed.'
declare -A RESTARTS
STARTED_AT=$(date '+%Y-%m-%d %H:%M:%S')
for u in "${UNITS[@]}"; do
  systemctl --user restart "$u" || die "systemctl restart $u failed."
  RESTARTS[$u]=$(systemctl --user show -p NRestarts --value "$u")
done

# ---- verify --------------------------------------------------------------------
probe_tcp() { "$NODE" -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1");s.setTimeout(2000);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' "$1"; }
probe_bridge() { "$NODE" -e 'fetch(`http://127.0.0.1:${process.argv[1]}/health`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).then(j=>process.exit(j.ok?0:1),()=>process.exit(1))' "$1"; }

wait_healthy() { # unit, description, probe...
  local unit=$1 what=$2; shift 2
  for _ in $(seq 1 45); do
    systemctl --user is-active --quiet "$unit" || break
    [[ $(systemctl --user show -p NRestarts --value "$unit") == "${RESTARTS[$unit]}" ]] || break
    if "$@" 2>/dev/null; then ok "$what"; return 0; fi
    sleep 1
  done
  echo "---- last log lines for $unit ----" >&2
  journalctl --user -u "$unit" --since "$STARTED_AT" -n 40 --no-pager -o cat 2>/dev/null \
    | sed -E 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1[REDACTED]/g; s/\b([A-Z_]*(TOKEN|KEY|SECRET|PASSWORD)[A-Z_]*=)[^ ]+/\1[REDACTED]/g' >&2 || true
  die "$unit did not become healthy ($what)."
}

step 'Health checks'
wait_healthy jarvis-agents.service "agent API listening on 127.0.0.1:$AGENTS_PORT" probe_tcp "$AGENTS_PORT"
wait_healthy jarvis.service "bridge /health ok on 127.0.0.1:$BRIDGE_PORT" probe_bridge "$BRIDGE_PORT"
wait_healthy jarvis.service "face listening on port $FACE_PORT" probe_tcp "$FACE_PORT"
sleep 3
for u in "${UNITS[@]}"; do
  systemctl --user is-active --quiet "$u" && [[ $(systemctl --user show -p NRestarts --value "$u") == "${RESTARTS[$u]}" ]] \
    || die "$u stopped or restarted right after start; check: journalctl --user -u $u"
done

CHANGED=0
SCHEME=http; [[ -n $(env_value JARVIS_TLS_CERT) ]] && SCHEME=https
printf '\n%sJARVIS is installed and running.%s\n' "$G" "$N"
echo "  face:      $SCHEME://localhost:$FACE_PORT  (mode: ${MODE:---readonly})"
echo "  services:  ${UNITS[*]} (enabled at boot)"
echo "  config:    $ENV_FILE"
echo "  logs:      journalctl --user -u jarvis -u jarvis-agents -f"
if [[ -d $BACKUP_DIR ]]; then echo "  backups:   $BACKUP_DIR (files replaced by this run)"; fi
