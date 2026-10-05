#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ACTION=${1:?action required}
BASE=/opt/jarvis-refined
MARKER=/etc/jarvis-refined
OWNER=jarvis

[[ $(id -u) == 0 ]] || { echo 'Provisioning requires the dedicated distro root user.' >&2; exit 1; }

run_as_owner() {
  local owner_uid
  owner_uid=$(id -u "$OWNER")
  runuser -u "$OWNER" -- env HOME="/home/$OWNER" USER="$OWNER" \
    XDG_RUNTIME_DIR="/run/user/$owner_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$owner_uid/bus" "$@"
}

case "$ACTION" in
  prepare)
    source /etc/os-release
    [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Use an Ubuntu 24.04 x64 rootfs.' >&2; exit 1; }
    [[ $(uname -m) == x86_64 ]] || exit 1
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y ca-certificates xz-utils openssl git sudo systemd dbus-user-session
    id "$OWNER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$OWNER"
    install -d -m 0755 "$BASE" "$BASE/releases"
    printf 'jarvis-refined-wsl-v1\n' > "$MARKER"
    printf '[boot]\nsystemd=true\n[user]\ndefault=jarvis\n[automount]\nenabled=true\n' > /etc/wsl.conf
    ;;
  install)
    [[ $(cat "$MARKER") == jarvis-refined-wsl-v1 ]] || exit 1
    PAYLOAD=${2:?payload directory required}
    HASH=${3:?application hash required}
    FACE_PORT=${4:?frontend port required}
    [[ $HASH =~ ^[a-f0-9]{64}$ ]] || exit 1
    [[ $FACE_PORT =~ ^[0-9]+$ && $FACE_PORT -ge 5173 && $FACE_PORT -le 5199 ]] || exit 1
    echo 'Verifying the application archive...'
    printf '%s  %s\n' "$HASH" "$PAYLOAD/app.tar.gz" | sha256sum --check --status
    RELEASE="$BASE/releases/$HASH"
    PREVIOUS=$(readlink "$BASE/current" || true)
    PREVIOUS_NODE=$(readlink /usr/local/bin/node || true)
    rollback() {
      local code=$?
      if [[ $code != 0 ]]; then
        if [[ -n $PREVIOUS ]]; then
          ln -sfn "$PREVIOUS" "$BASE/current"
          [[ -z $PREVIOUS_NODE ]] || ln -sfn "$PREVIOUS_NODE" /usr/local/bin/node
          run_as_owner systemctl --user restart jarvis-agents jarvis || true
        else
          rm -f "$BASE/current" /usr/local/bin/node /usr/local/bin/npm
        fi
      fi
      exit "$code"
    }
    trap rollback EXIT
    if [[ ! -f $RELEASE/.complete ]]; then
      STAGE=$(mktemp -d "$BASE/releases/.staging-XXXXXX")
      echo 'Extracting the application release (this can take several minutes)...'
      tar -xzf "$PAYLOAD/app.tar.gz" -C "$STAGE"
      mkdir "$STAGE/node"
      echo 'Extracting the Linux Node runtime...'
      tar -xJf "$PAYLOAD/node-linux.tar.xz" --strip-components=1 -C "$STAGE/node"
      "$STAGE/node/bin/node" -e 'if(process.platform!=="linux"||process.arch!=="x64"||+process.versions.node.split(".")[0]<22)process.exit(1)'
      [[ -f $STAGE/dist/index.html && -d $STAGE/node_modules/ws ]] || exit 1
      chmod -R u+rwX,go+rX,go-w "$STAGE"
      touch "$STAGE/.complete"
      if [[ -e $RELEASE ]]; then echo 'An incomplete release already exists; inspect it before retrying.' >&2; exit 1; fi
      mv "$STAGE" "$RELEASE"
    fi
    ln -sfn "$RELEASE" "$BASE/current"
    ln -sfn "$RELEASE/node/bin/node" /usr/local/bin/node
    ln -sfn "$RELEASE/node/bin/npm" /usr/local/bin/npm
    echo 'Starting the Jarvis user service manager...'
    loginctl enable-linger "$OWNER"
    UID_NUMBER=$(id -u "$OWNER")
    systemctl start "user@$UID_NUMBER.service"
    CONF_DIR="/home/$OWNER/.config/jarvis"
    install -d -m 700 -o "$OWNER" -g "$OWNER" \
      "/home/$OWNER/.config" "$CONF_DIR" \
      "/home/$OWNER/.config/systemd" "/home/$OWNER/.config/systemd/user"
    if [[ ! -f $CONF_DIR/service.env ]]; then
      printf 'PORT=%s\nJARVIS_AGENTS=1\n' "$FACE_PORT" > "$CONF_DIR/service.env"
      chown "$OWNER:$OWNER" "$CONF_DIR/service.env"
      chmod 600 "$CONF_DIR/service.env"
    fi
    for ATTEMPT in {1..30}; do
      [[ ! -S /run/user/$UID_NUMBER/bus ]] || break
      sleep 1
    done
    run_as_owner bash -c 'cd /opt/jarvis-refined/current && node scripts/relay-token.mjs >/dev/null && bash scripts/install.sh --production --readonly'
    ;;
  start|stop|status)
    [[ $ACTION != stop || -f $MARKER ]] || exit 0
    [[ $(cat "$MARKER") == jarvis-refined-wsl-v1 ]] || exit 1
    UID_NUMBER=$(id -u "$OWNER")
    if [[ $ACTION == start ]]; then systemctl start "user@$UID_NUMBER.service"; fi
    if [[ $ACTION == stop ]]; then
      run_as_owner systemctl --user stop jarvis-agents jarvis || true
    else
      run_as_owner systemctl --user "$ACTION" jarvis-agents jarvis
    fi
    ;;
  relay-token)
    [[ $(cat "$MARKER") == jarvis-refined-wsl-v1 ]] || exit 1
    sed -n 's/^JARVIS_RELAY_TOKEN=//p' /home/jarvis/.config/jarvis/secrets.env
    ;;
  *) echo 'Unknown provision action.' >&2; exit 2 ;;
esac