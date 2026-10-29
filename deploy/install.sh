#!/usr/bin/env bash
# Installs the restricted release control plane only; never adopts, reloads or deploys the app.
set -Eeuo pipefail
umask 077

INSTALL_ROOT=/opt/qintopia-image-release
CONFIG_DIR=/etc/qintopia-image-release
STATE_DIR=/var/lib/qintopia-image-release
DEPLOY_USER=qintopia-image-deploy
MAINTENANCE_USER=qintopia-image-maintenance
HOME_DIR=/home/qintopia-image-deploy
SSH_DROPIN_DIR=/etc/ssh/sshd_config.d
SSH_DROPIN=$SSH_DROPIN_DIR/99-qintopia-image-release.conf
DRY_RUN=0
PUBLIC_KEY=
STAGE=

die() { printf 'Image release installer: %s\n' "$*" >&2; exit 1; }
note() { printf 'Image release installer: %s\n' "$*"; }
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --deploy-public-key) (($# >= 2)) || die 'public key path required'; PUBLIC_KEY=$2; shift 2 ;;
    -h|--help) printf 'Usage: sudo bash deploy/install.sh [--dry-run] --deploy-public-key /root/deploy.pub\n'; exit 0 ;;
    *) die 'unknown argument' ;;
  esac
done
[[ -n "$PUBLIC_KEY" && -f "$PUBLIC_KEY" && ! -L "$PUBLIC_KEY" ]] || die 'reviewed public key file required'
((DRY_RUN)) || [[ ${EUID:-$(id -u)} -eq 0 ]] || die 'run as root'
SOURCE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
for name in common.py cos.py server.py requirements.txt; do
  [[ -f "$SOURCE_ROOT/scripts/release/$name" && ! -L "$SOURCE_ROOT/scripts/release/$name" ]] || die "missing release source: $name"
done
for name in entry.py ssh-entry.py qintopia-image-deploy qintopia-image-deploy.sudoers qintopia-image-release-recovery.service qintopia-image-release-recovery.timer; do
  [[ -f "$SOURCE_ROOT/deploy/$name" && ! -L "$SOURCE_ROOT/deploy/$name" ]] || die "missing deployment source: $name"
done
DEPLOY_KEY=$(awk '
  BEGIN { count=0 }
  /^[[:space:]]*$/ { next }
  NF<2 || $1!="ssh-ed25519" || $2!~/^[A-Za-z0-9+\/=]+$/ { exit 2 }
  { key=$1 " " $2; count++ }
  END { if (count!=1) exit 2; print key }
' "$PUBLIC_KEY") || die 'exactly one ed25519 public key is required'
for command_name in python3 visudo sshd systemctl install cmp stat id getent useradd usermod flock; do
  command -v "$command_name" >/dev/null || die "required tool unavailable: $command_name"
done
python3 -c 'import sys,venv;raise SystemExit(0 if sys.version_info >= (3,10) else 1)' || die 'Python 3.10+ with venv required'
[[ -x /opt/qintopia-image-runtime/bin/node ]] || die 'existing isolated Node runtime is missing'
[[ $(/opt/qintopia-image-runtime/bin/node --version) == v22.22.1 ]] || die 'isolated Node version must match the reviewed build runtime'
[[ $(/opt/qintopia-image-runtime/bin/node -p 'process.platform + "/" + process.arch') == linux/x64 ]] || die 'release runtime requires Linux x64'
getent passwd qintopia-image-app >/dev/null || die 'existing application user is missing'
[[ -f /etc/qintopia-image-app/environment && ! -L /etc/qintopia-image-app/environment ]] || die 'existing application environment is missing'
visudo -cf "$SOURCE_ROOT/deploy/qintopia-image-deploy.sudoers" >/dev/null || die 'sudoers validation failed'
effective=$(sshd -T -C user="$DEPLOY_USER",addr=127.0.0.1,laddr=127.0.0.1,lport=22 2>/dev/null) || die 'cannot inspect effective sshd configuration'
printf '%s\n' "$effective" | awk '
  $1=="authorizedkeysfile" { for(i=2;i<=NF;i++) if($i==".ssh/authorized_keys") found=1 }
  $1=="forcecommand" && $2!="none" { conflict=1 }
  END { exit !(found && !conflict) }
' || die 'sshd authorized keys or ForceCommand conflict'
STAGE=$(mktemp -d /tmp/qintopia-image-install.XXXXXX)
trap 'status=$?; [[ -z "${STAGE:-}" ]] || rm -rf -- "$STAGE"; exit "$status"' EXIT
[[ -d "$SSH_DROPIN_DIR" && ! -L "$SSH_DROPIN_DIR" ]] || die 'existing sshd drop-in directory is missing or unsafe'
printf 'restrict,command="/usr/local/libexec/qintopia-image-ssh-entry" %s\n' "$DEPLOY_KEY" > "$STAGE/authorized_keys"
cat > "$STAGE/ssh-keepalive.conf" <<'EOF'
# Transport liveness only for the restricted image release account.
Match User qintopia-image-deploy
    ClientAliveInterval 15
    ClientAliveCountMax 3
Match all
EOF

# Preview the actual Include order without changing the running SSH service.
# Transport keepalives do not time out a healthy, long-running COS operation.
python3 - "$STAGE" "$SSH_DROPIN_DIR" "$SSH_DROPIN" <<'PY'
import pathlib,re,sys
stage,folder,target=map(pathlib.Path,sys.argv[1:])
source=pathlib.Path('/etc/ssh/sshd_config').read_text()
pattern=re.compile(r'^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf\s*(?:#.*)?$',re.M)
if len(pattern.findall(source)) != 1:
    raise SystemExit('Image release installer: expected one sshd_config.d Include')
files={item.name:item for item in folder.glob('*.conf')}
files[target.name]=stage/'ssh-keepalive.conf'
if any(re.search(r'[\s"\\]',str(item)) for item in files.values()):
    raise SystemExit('Image release installer: unsupported SSH include path')
preview=pattern.sub(lambda match:'\n'.join('Include '+str(files[name]) for name in sorted(files)),source)
(stage/'sshd-preview.conf').write_text(preview)
PY
sshd -t -f "$STAGE/sshd-preview.conf" || die 'SSH keepalive preview failed validation'
check_keepalive() {
  local output
  output=$(sshd -T "$@" -C user="$DEPLOY_USER",addr=127.0.0.1,laddr=127.0.0.1,lport=22 2>/dev/null) || return 1
  printf '%s\n' "$output" | awk '
    $1=="clientaliveinterval" { interval=$2 }
    $1=="clientalivecountmax" { count=$2 }
    END { exit !(interval==15 && count==3) }
  '
}
check_keepalive -f "$STAGE/sshd-preview.conf" || die 'dedicated SSH keepalive preview is not 15/3'
for check_user in root qintopia-image-app; do
  sshd -T -C user="$check_user",addr=127.0.0.1,laddr=127.0.0.1,lport=22 > "$STAGE/ssh-$check_user-before"
  sshd -T -f "$STAGE/sshd-preview.conf" -C user="$check_user",addr=127.0.0.1,laddr=127.0.0.1,lport=22 > "$STAGE/ssh-$check_user-after"
  cmp -s "$STAGE/ssh-$check_user-before" "$STAGE/ssh-$check_user-after" || die 'SSH preview changes an unrelated account policy'
done

assert_root() {
  local path=$1 uid mode
  [[ ! -L "$path" ]] || die "managed path is a symlink: $path"
  uid=$(stat -c '%u:%g' -- "$path"); mode=$(stat -c '%a' -- "$path")
  [[ "$uid" == 0:0 ]] || die "managed path is not root-owned: $path"
  (( (8#$mode & 8#022) == 0 )) || die "managed path is writable by other users: $path"
}
check_file() {
  local source=$1 target=$2 expected_mode=${3:-} actual_mode
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] || die "managed file is not regular: $target"
    cmp -s "$source" "$target" || die "existing tool differs; review an explicit upgrade: $target"
    assert_root "$target"
    if [[ -n "$expected_mode" ]]; then
      actual_mode=$(stat -c '%a' -- "$target")
      (( 8#$actual_mode == 8#$expected_mode )) || die "existing tool mode differs; review an explicit repair: $target"
    fi
  fi
}
install_new_file() {
  local source=$1 target=$2 mode=$3 temporary
  if [[ -e "$target" || -L "$target" ]]; then
    check_file "$source" "$target" "$mode"
    return
  fi
  temporary=$(mktemp "$(dirname -- "$target")/.qintopia-install.XXXXXX")
  install -o root -g root -m "$mode" "$source" "$temporary"
  # An existing installation is never overwritten. Differing tools must use
  # the separately reviewed digest-bound upgrade transaction.
  if ! ln -- "$temporary" "$target"; then
    rm -- "$temporary"
    die 'managed file appeared concurrently; retained it for operator review'
  fi
  rm -- "$temporary"
}
for directory in "$INSTALL_ROOT" "$INSTALL_ROOT/lib" "$INSTALL_ROOT/venv" "$CONFIG_DIR" "$STATE_DIR" "$HOME_DIR" "$HOME_DIR/.ssh" "$SSH_DROPIN_DIR"; do
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || die "managed directory invalid: $directory"
    assert_root "$directory"
  fi
done
[[ ! -e "$HOME_DIR/.ssh/authorized_keys2" && ! -L "$HOME_DIR/.ssh/authorized_keys2" ]] || die 'unexpected secondary authorized keys file'
for name in common.py cos.py server.py; do check_file "$SOURCE_ROOT/scripts/release/$name" "$INSTALL_ROOT/lib/$name" 0644; done
check_file "$SOURCE_ROOT/deploy/entry.py" "$INSTALL_ROOT/entry.py" 0644
check_file "$SOURCE_ROOT/deploy/ssh-entry.py" /usr/local/libexec/qintopia-image-ssh-entry 0755
check_file "$SOURCE_ROOT/deploy/qintopia-image-deploy" /usr/local/sbin/qintopia-image-deploy 0755
check_file "$SOURCE_ROOT/deploy/qintopia-image-deploy.sudoers" /etc/sudoers.d/qintopia-image-deploy 0440
check_file "$STAGE/authorized_keys" "$HOME_DIR/.ssh/authorized_keys" 0644
check_file "$STAGE/ssh-keepalive.conf" "$SSH_DROPIN" 0644
for name in qintopia-image-release-recovery.service qintopia-image-release-recovery.timer; do check_file "$SOURCE_ROOT/deploy/$name" "/etc/systemd/system/$name" 0644; done
if entry=$(getent passwd "$DEPLOY_USER"); then
  IFS=: read -r _ _ _ _ _ existing_home existing_shell <<< "$entry"
  [[ "$existing_home" == "$HOME_DIR" && "$existing_shell" == /bin/sh ]] || die 'existing deploy account identity differs'
  for group in $(id -nG "$DEPLOY_USER"); do [[ "$group" != sudo && "$group" != docker ]] || die 'deploy user has forbidden group membership'; done
fi
if entry=$(getent passwd "$MAINTENANCE_USER"); then
  IFS=: read -r _ _ maintenance_uid _ _ maintenance_home maintenance_shell <<< "$entry"
  [[ "$maintenance_uid" != 0 && "$maintenance_home" == /nonexistent && "$maintenance_shell" == /usr/sbin/nologin ]] || die 'existing maintenance account identity differs'
  for group in $(id -nG "$MAINTENANCE_USER"); do [[ "$group" == "$MAINTENANCE_USER" ]] || die 'maintenance user has unexpected group membership'; done
fi
if ((DRY_RUN)); then
  note 'dry-run passed: no application, user, configuration, key or timer changed'
  exit 0
fi
install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/lib" "$HOME_DIR" "$HOME_DIR/.ssh" /usr/local/libexec
install -d -o root -g root -m 0700 "$CONFIG_DIR" "$STATE_DIR"
exec 9>"$STATE_DIR/release.lock"
flock -n 9 || die 'another installation or release owns the lock'
if ! getent passwd "$DEPLOY_USER" >/dev/null; then useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /bin/sh "$DEPLOY_USER"; fi
usermod --password '*' "$DEPLOY_USER"
if ! getent passwd "$MAINTENANCE_USER" >/dev/null; then useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$MAINTENANCE_USER"; fi
usermod --password '*' "$MAINTENANCE_USER"
if [[ ! -x "$INSTALL_ROOT/venv/bin/python3" ]]; then
  [[ ! -e "$INSTALL_ROOT/venv" ]] || die 'existing virtual environment is incomplete'
  python3 -m venv "$INSTALL_ROOT/venv"
  "$INSTALL_ROOT/venv/bin/python3" -I -m pip install --disable-pip-version-check --no-input -r "$SOURCE_ROOT/scripts/release/requirements.txt" >/dev/null
else
  "$INSTALL_ROOT/venv/bin/python3" -I -c "import importlib.metadata; assert importlib.metadata.version('cos-python-sdk-v5') == '1.9.38'" || die 'existing SDK differs; dependency updates need explicit review'
fi
for name in common.py cos.py server.py; do install_new_file "$SOURCE_ROOT/scripts/release/$name" "$INSTALL_ROOT/lib/$name" 0644; done
install_new_file "$SOURCE_ROOT/deploy/entry.py" "$INSTALL_ROOT/entry.py" 0644
install_new_file "$SOURCE_ROOT/deploy/ssh-entry.py" /usr/local/libexec/qintopia-image-ssh-entry 0755
install_new_file "$SOURCE_ROOT/deploy/qintopia-image-deploy" /usr/local/sbin/qintopia-image-deploy 0755
install_new_file "$SOURCE_ROOT/deploy/qintopia-image-deploy.sudoers" /etc/sudoers.d/qintopia-image-deploy 0440
install_new_file "$STAGE/authorized_keys" "$HOME_DIR/.ssh/authorized_keys" 0644
for name in qintopia-image-release-recovery.service qintopia-image-release-recovery.timer; do install_new_file "$SOURCE_ROOT/deploy/$name" "/etc/systemd/system/$name" 0644; done
systemctl daemon-reload
if [[ ! -e "$SSH_DROPIN" ]]; then
  ssh_temp=$(mktemp "$SSH_DROPIN_DIR/.qintopia-image-keepalive.XXXXXX")
  install -o root -g root -m 0644 "$STAGE/ssh-keepalive.conf" "$ssh_temp"
  # Exclusive creation: a concurrently installed operator file is never replaced.
  ln -- "$ssh_temp" "$SSH_DROPIN" || die 'SSH drop-in appeared concurrently; inspect it before retrying'
  rm -- "$ssh_temp"
  ssh_valid=1
  sshd -t || ssh_valid=0
  check_keepalive || ssh_valid=0
  for check_user in root qintopia-image-app; do
    sshd -T -C user="$check_user",addr=127.0.0.1,laddr=127.0.0.1,lport=22 > "$STAGE/ssh-$check_user-installed" || ssh_valid=0
    cmp -s "$STAGE/ssh-$check_user-before" "$STAGE/ssh-$check_user-installed" || ssh_valid=0
  done
  if (( ! ssh_valid )); then
    cmp -s "$STAGE/ssh-keepalive.conf" "$SSH_DROPIN" || die 'SSH drop-in changed concurrently; retained it for operator review'
    rm -- "$SSH_DROPIN"
    die 'installed SSH policy failed verification; new drop-in removed without reloading SSH'
  fi
  if ! systemctl reload ssh; then
    cmp -s "$STAGE/ssh-keepalive.conf" "$SSH_DROPIN" || die 'SSH drop-in changed concurrently after reload failure; inspect the service'
    rm -- "$SSH_DROPIN"
    sshd -t && systemctl reload ssh || true
    die 'SSH reload failed; added drop-in removed, inspect the SSH service'
  fi
fi
check_keepalive || die 'dedicated SSH keepalive readback failed'
note 'control plane installed; app unchanged, configuration/adoption and timer activation remain explicit operator steps'
