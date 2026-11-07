#!/bin/sh
# docker-registry-cache: client setup (Linux and macOS)
#
# Points the registry names (ghcr.io, quay.io, ...) at the cache by adding them to /etc/hosts, and trusts the
# cache's root certificate so TLS to those names validates. Safe to run again; undo with --remove.
#
# Normally served by the cache's web UI, which fills in the address and registry names:
#   curl -fsSL http://CACHE-HOST:8080/setup.sh | sudo sh -s -- --fingerprint 'AA:BB:...'
#
# What it changes (and nothing else):
#   - one marked block in /etc/hosts (the original is backed up once)
#   - the root certificate, in the system trust store and/or per registry for Docker and Podman
#   - a small list of the files it created, so --remove can take them away again
#
# This script installs a root certificate, so it refuses to do so unless you have verified it: pass the
# SHA-256 fingerprint shown in the cache's web UI with --fingerprint, or answer the prompt after comparing it.
set -eu

DEFAULT_HOSTS='@@HOSTS@@'
DEFAULT_ADDR='@@ADDR@@'
DEFAULT_URL='@@BASE_URL@@'
case "$DEFAULT_HOSTS" in @@*) DEFAULT_HOSTS='' ;; esac
case "$DEFAULT_ADDR" in @@*) DEFAULT_ADDR='' ;; esac
case "$DEFAULT_URL" in @@*) DEFAULT_URL='' ;; esac

# DRC_PREFIX relocates every system path (for packaging and tests); it is not needed in normal use.
PREFIX="${DRC_PREFIX:-}"
HOSTS_FILE="$PREFIX/etc/hosts"
MANIFEST="$PREFIX/etc/docker-registry-cache-client.paths"
MARK_BEGIN='# BEGIN docker-registry-cache'
MARK_END='# END docker-registry-cache'
CERT_NAME='docker-registry-cache.crt'

MODE=install
ADDR='' URL='' HOSTS='' CA_ARG='' PIN=''
YES=0 DRY=0 NO_HOSTS=0 NO_TRUST=0 NO_SYSTEM=0 NO_VERIFY=0

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!]  %s\n' "$*" >&2; }
die()  { printf 'Error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n%s\n' "$*"; }

usage() {
  cat <<'USAGE'
Usage: setup.sh [options]

  --fingerprint SHA256   only accept a root certificate with this SHA-256 fingerprint (recommended)
  --yes, -y              do not ask for confirmation (skips the fingerprint prompt: only use on a network you trust)
  --ca FILE              use this root certificate file instead of downloading one
  --ip ADDRESS           address of the cache server (a name is looked up)
  --url URL              where to download the certificate from (default: the cache that served this script)
  --hosts "a.io b.io"    registry names to point at the cache (default: the cache's list)
  --no-hosts             leave /etc/hosts alone (DNS already points the names at the cache)
  --no-trust             do not install the certificate
  --no-system-trust      trust the certificate for Docker and Podman only, not for the whole machine
  --no-verify            skip the final connection test
  --check                only test the current setup; change nothing
  --remove               undo what this script did
  --dry-run, -n          show what would be done; change nothing (needs no root)
  -h, --help             this text
USAGE
}

optarg() { [ "$#" -ge 2 ] || die "$1 needs a value (try --help)"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fingerprint) optarg "$@"; PIN=$2; shift 2 ;;
    --ca)          optarg "$@"; CA_ARG=$2; shift 2 ;;
    --ip)          optarg "$@"; ADDR=$2; shift 2 ;;
    --url)         optarg "$@"; URL=$2; shift 2 ;;
    --hosts)       optarg "$@"; HOSTS=$2; shift 2 ;;
    --yes|-y)      YES=1; shift ;;
    --no-hosts)    NO_HOSTS=1; shift ;;
    --no-trust)    NO_TRUST=1; shift ;;
    --no-system-trust) NO_SYSTEM=1; shift ;;
    --no-verify)   NO_VERIFY=1; shift ;;
    --check)       MODE=check; shift ;;
    --remove|--uninstall) MODE=remove; shift ;;
    --dry-run|-n)  DRY=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

ADDR=${ADDR:-$DEFAULT_ADDR}
URL=${URL:-$DEFAULT_URL}
HOSTS=${HOSTS:-$DEFAULT_HOSTS}
OS=$(uname -s)

[ -n "$HOSTS" ] || die "no registry names known. Download this script from the cache's web UI, or pass --hosts 'ghcr.io quay.io'."
for h in $HOSTS; do
  case "$h" in *[!a-z0-9.-]*|'') die "'$h' is not a valid host name" ;; esac
done

if [ "$MODE" != check ] && [ "$DRY" = 0 ] && [ -z "$PREFIX" ] && [ "$(id -u)" != 0 ]; then
  die "this needs root, because it edits /etc/hosts and the trust store. Run it with sudo (add --dry-run to just look)."
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/drc-setup.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

# ------------------------------------------------------------------ helpers
is_ip() {
  printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' && return 0
  case "$1" in *:*) printf '%s' "$1" | grep -Eq '^[0-9A-Fa-f:]+$' && return 0 ;; esac
  return 1
}

resolve() {
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}' | grep . && return 0
    getent hosts "$1" 2>/dev/null | awk '{print $1; exit}' | grep . && return 0
  fi
  if [ "$OS" = Darwin ] && command -v dscacheutil >/dev/null 2>&1; then
    dscacheutil -q host -a name "$1" 2>/dev/null | awk '/^ip_address:/ {print $2; exit}' | grep . && return 0
  fi
  return 1
}

fetch() {   # url dest
  case "$1" in https://*) insecure=1 ;; *) insecure=0 ;; esac
  # The certificate is public and is checked against its fingerprint, so TLS on this download adds nothing
  # (and cannot work yet: the machine does not trust the cache's certificate).
  if command -v curl >/dev/null 2>&1; then
    if [ "$insecure" = 1 ]; then curl -fsSL -k --connect-timeout 10 -o "$2" "$1"; else curl -fsSL --connect-timeout 10 -o "$2" "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$insecure" = 1 ]; then wget -q --no-check-certificate -T 10 -O "$2" "$1"; else wget -q -T 10 -O "$2" "$1"; fi
  else
    die "neither curl nor wget is installed"
  fi
}

fingerprint() {   # PEM file -> AA:BB:...
  if command -v openssl >/dev/null 2>&1; then
    openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//'
    return
  fi
  der=$(awk '/BEGIN CERTIFICATE/{f=1;next} /END CERTIFICATE/{exit} f' "$1" | tr -d '\r\n')
  if command -v sha256sum >/dev/null 2>&1; then sum=$(printf '%s' "$der" | base64 -d 2>/dev/null | sha256sum | cut -d' ' -f1)
  else sum=$(printf '%s' "$der" | base64 -d 2>/dev/null | shasum -a 256 | cut -d' ' -f1); fi
  printf '%s' "$sum" | tr a-f A-F | sed 's/../&:/g; s/:$//'
}

norm_pin() { printf '%s' "$1" | sed 's/^[Ss][Hh][Aa]256[:=]//' | tr -cd '0-9A-Fa-f' | tr a-f A-F; }

have_tty() { ( : </dev/tty ) 2>/dev/null; }

record_path() {   # remember a file we created, for --remove
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$(dirname "$MANIFEST")"
  touch "$MANIFEST"
  grep -qxF "$1" "$MANIFEST" 2>/dev/null || printf '%s\n' "$1" >> "$MANIFEST"
}

strip_block() {   # print a file without our block
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$1"
}

detect_trust() {
  TRUST=none TRUST_DIR='' TRUST_CMD=''
  if [ "$OS" = Darwin ]; then TRUST=mac; return; fi
  if [ -d "$PREFIX/etc/pki/trust/anchors" ] && command -v update-ca-certificates >/dev/null 2>&1; then
    TRUST=suse; TRUST_DIR="$PREFIX/etc/pki/trust/anchors"; TRUST_CMD=update-ca-certificates
  elif command -v update-ca-certificates >/dev/null 2>&1; then
    TRUST=debian; TRUST_DIR="$PREFIX/usr/local/share/ca-certificates"; TRUST_CMD=update-ca-certificates
  elif command -v update-ca-trust >/dev/null 2>&1; then
    TRUST=redhat; TRUST_CMD=update-ca-trust
    if [ -d "$PREFIX/etc/ca-certificates/trust-source/anchors" ]; then TRUST_DIR="$PREFIX/etc/ca-certificates/trust-source/anchors"
    else TRUST_DIR="$PREFIX/etc/pki/ca-trust/source/anchors"; fi
  fi
}

runtime_dirs() {   # container tools that read a certificate per registry
  if [ -d "$PREFIX/etc/docker" ] || command -v docker >/dev/null 2>&1; then printf '%s\n' "$PREFIX/etc/docker/certs.d"; fi
  if [ -d "$PREFIX/etc/containers" ] || command -v podman >/dev/null 2>&1; then printf '%s\n' "$PREFIX/etc/containers/certs.d"; fi
}

# ------------------------------------------------------------------ verification
verify() {
  bad=0
  step "Checking each registry name"
  for h in $HOSTS; do
    got=$(resolve "$h" || true)
    if [ -z "$got" ]; then warn "$h does not resolve"; bad=1; continue; fi
    if [ -n "${IP:-}" ] && [ "$got" != "$IP" ]; then
      warn "$h resolves to $got, not $IP. Another DNS setting or a VPN may be overriding /etc/hosts."; bad=1; continue
    fi
    if ! command -v curl >/dev/null 2>&1; then ok "$h resolves to $got (curl not installed, TLS not tested)"; continue; fi
    code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 "https://$h/v2/" 2>"$TMP/err") && rc=0 || rc=$?
    if [ "$rc" -eq 0 ]; then
      ok "$h -> $got, TLS trusted (HTTP $code)"
    elif [ "$rc" -eq 60 ] || [ "$rc" -eq 35 ] || grep -qi 'certificate' "$TMP/err" 2>/dev/null; then
      warn "$h -> $got, but curl does not trust the certificate. Is the root certificate installed, and does the server certificate cover $h?"; bad=1
    else
      warn "$h -> $got, but the connection failed: $(tr '\n' ' ' < "$TMP/err" | cut -c1-120)"; bad=1
    fi
  done
  return $bad
}

# ------------------------------------------------------------------ --check
if [ "$MODE" = check ]; then
  step "docker-registry-cache client check"
  if [ -f "$HOSTS_FILE" ] && grep -qxF "$MARK_BEGIN" "$HOSTS_FILE"; then
    ok "hosts entries from this script are present"
    IP=$(awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{f=1;next} $0==e{f=0} f&&$1!~/^#/{print $1; exit}' "$HOSTS_FILE")
  else
    say "  hosts entries from this script: none (fine if your DNS points the names at the cache)"
  fi
  if verify; then say; say "Everything checks out."; exit 0; fi
  exit 1
fi

# ------------------------------------------------------------------ --remove
if [ "$MODE" = remove ]; then
  step "Removing docker-registry-cache client setup"
  [ "$DRY" = 1 ] && say "  (dry run: nothing will be changed)"
  if [ "$NO_HOSTS" = 0 ] && [ -f "$HOSTS_FILE" ] && grep -qxF "$MARK_BEGIN" "$HOSTS_FILE"; then
    if [ "$DRY" = 1 ]; then say "  would remove the docker-registry-cache block from $HOSTS_FILE"
    else strip_block "$HOSTS_FILE" > "$TMP/hosts.new"; cat "$TMP/hosts.new" > "$HOSTS_FILE"; ok "removed the block from $HOSTS_FILE"; fi
  else
    say "  no hosts entries to remove"
  fi
  detect_trust
  if [ -f "$MANIFEST" ]; then
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      if [ -e "$path" ]; then
        if [ "$DRY" = 1 ]; then say "  would delete $path"
        else
          if [ "$OS" = Darwin ] && [ "$(basename "$path")" = ca.crt ] && [ "$(basename "$(dirname "$path")")" = docker-registry-cache ] && command -v security >/dev/null 2>&1; then
            sha1=$(openssl x509 -in "$path" -noout -fingerprint -sha1 2>/dev/null | sed 's/^.*=//; s/://g')
            security remove-trusted-cert -d "$path" 2>/dev/null || true
            [ -n "$sha1" ] && security delete-certificate -Z "$sha1" /Library/Keychains/System.keychain 2>/dev/null || true
          fi
          rm -f "$path"; rmdir "$(dirname "$path")" 2>/dev/null || true; ok "deleted $path"
        fi
      fi
    done < "$MANIFEST"
    if [ "$DRY" = 0 ]; then
      rm -f "$MANIFEST"
      case "$TRUST" in
        debian|suse) "$TRUST_CMD" --fresh >/dev/null 2>&1 || warn "$TRUST_CMD --fresh failed; run it yourself" ;;
        redhat) "$TRUST_CMD" >/dev/null 2>&1 || warn "$TRUST_CMD failed; run it yourself" ;;
      esac
    fi
  else
    say "  no certificate files recorded, nothing to delete"
  fi
  say; say "Done. Restart containerd (and Docker, if it relied on the system store) so running daemons forget the certificate."
  exit 0
fi

# ------------------------------------------------------------------ install
step "docker-registry-cache client setup"
[ "$DRY" = 1 ] && say "  (dry run: nothing will be changed)"
[ "$NO_HOSTS" = 1 ] && [ "$NO_TRUST" = 1 ] && { say "  --no-hosts and --no-trust together leave nothing to do."; exit 0; }

IP=''
if [ "$NO_HOSTS" = 0 ]; then
  [ -n "$ADDR" ] || die "do not know the cache's address. Pass --ip ADDRESS."
  if is_ip "$ADDR"; then IP=$ADDR
  else
    IP=$(resolve "$ADDR" || true)
    [ -n "$IP" ] || die "could not look up '$ADDR'. Pass the cache's IP address with --ip."
  fi
  say "  cache server: $IP"
fi

# ---- 1. the root certificate
CA_FILE=''
if [ "$NO_TRUST" = 0 ]; then
  step "1. Root certificate"
  if [ -n "$CA_ARG" ]; then
    [ -r "$CA_ARG" ] || die "cannot read $CA_ARG"
    CA_FILE=$CA_ARG; say "  using $CA_ARG"
  else
    [ -n "$URL" ] || die "do not know where to download the certificate from. Pass --url http://CACHE:8080 or --ca FILE."
    CA_FILE="$TMP/ca.crt"
    say "  downloading $URL/ca.crt"
    fetch "$URL/ca.crt" "$CA_FILE" 2>"$TMP/fetch.err" || {
      die "could not download $URL/ca.crt ($(tr '\n' ' ' < "$TMP/fetch.err" | cut -c1-100)). If the cache uses your own server certificate and publishes no ca.crt, give the root with --ca FILE, or use --no-trust."
    }
  fi
  grep -q 'BEGIN CERTIFICATE' "$CA_FILE" || die "that is not a PEM certificate"
  FP=$(fingerprint "$CA_FILE")
  [ -n "$FP" ] || die "could not read the certificate (is it a valid PEM file?)"
  if command -v openssl >/dev/null 2>&1; then
    say "  subject:     $(openssl x509 -in "$CA_FILE" -noout -subject 2>/dev/null | sed 's/^subject= *//')"
    say "  valid until: $(openssl x509 -in "$CA_FILE" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
    openssl x509 -in "$CA_FILE" -noout -checkend 0 >/dev/null 2>&1 || warn "this certificate has expired"
  fi
  say "  SHA-256:     $FP"
  if [ -n "$PIN" ]; then
    [ "$(norm_pin "$FP")" = "$(norm_pin "$PIN")" ] || die "the certificate's fingerprint does not match --fingerprint. NOT installing it. Someone may be tampering with the download."
    ok "matches the fingerprint you gave"
  elif [ -n "$CA_ARG" ]; then
    say "  (a file you supplied yourself)"
  elif [ "$DRY" = 1 ]; then
    say "  (a real run would ask you to confirm this fingerprint, or require --fingerprint)"
  elif [ "$YES" = 1 ]; then
    warn "installing without checking the fingerprint (--yes)"
  elif have_tty; then
    printf '\n  Install this certificate as trusted? Only answer yes if the fingerprint is the one the cache shows\n  in its web UI (Connect a client). [y/N] ' >&2
    read ans </dev/tty || ans=n
    case "$ans" in y|Y|yes|YES) ;; *) die "cancelled" ;; esac
  else
    die "no terminal to ask on. Re-run with --fingerprint 'AA:BB:...' (shown in the cache's web UI), or --yes if you accept the risk."
  fi
fi

# ---- 2. /etc/hosts
if [ "$NO_HOSTS" = 0 ]; then
  step "2. Registry names in $HOSTS_FILE"
  [ -f "$HOSTS_FILE" ] || { mkdir -p "$(dirname "$HOSTS_FILE")"; : > "$HOSTS_FILE"; }
  strip_block "$HOSTS_FILE" > "$TMP/hosts.base"
  for h in $HOSTS; do
    if awk -v h="$h" '/^[[:space:]]*#/ {next} { for (i = 2; i <= NF; i++) if ($i == h) { found = 1 } } END { exit !found }' "$TMP/hosts.base"; then
      warn "$h is also set elsewhere in $HOSTS_FILE. The first matching line wins, so check that it points at the cache."
    fi
  done
  { cat "$TMP/hosts.base"; echo "$MARK_BEGIN"; echo "# managed by docker-registry-cache setup; undo with --remove"
    for h in $HOSTS; do printf '%s %s\n' "$IP" "$h"; done; echo "$MARK_END"; } > "$TMP/hosts.full"
  if [ "$DRY" = 1 ]; then
    say "  would write:"; for h in $HOSTS; do say "    $IP $h"; done
  else
    [ -e "$HOSTS_FILE.docker-registry-cache.bak" ] || cp -p "$HOSTS_FILE" "$HOSTS_FILE.docker-registry-cache.bak" 2>/dev/null || true
    cat "$TMP/hosts.full" > "$HOSTS_FILE"
    for h in $HOSTS; do ok "$IP $h"; done
    say "  (original saved as $HOSTS_FILE.docker-registry-cache.bak)"
    [ "$OS" = Darwin ] && { dscacheutil -flushcache 2>/dev/null || true; killall -HUP mDNSResponder 2>/dev/null || true; }
  fi
fi

# ---- 3. trust
if [ "$NO_TRUST" = 0 ]; then
  step "3. Trusting the certificate"
  detect_trust
  if [ "$NO_SYSTEM" = 0 ]; then
    case "$TRUST" in
      mac)
        if [ "$DRY" = 1 ]; then say "  would add it to the System keychain as a trusted root"
        else
          copy="$PREFIX/usr/local/share/docker-registry-cache/ca.crt"
          mkdir -p "$(dirname "$copy")"; cp "$CA_FILE" "$copy"; chmod 644 "$copy"; record_path "$copy"
          security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$copy" && ok "added to the System keychain" \
            || die "security add-trusted-cert failed"
        fi ;;
      debian|suse|redhat)
        dest="$TRUST_DIR/$CERT_NAME"
        if [ "$DRY" = 1 ]; then say "  would install $dest and run $TRUST_CMD"
        else
          mkdir -p "$TRUST_DIR"; cp "$CA_FILE" "$dest"; chmod 644 "$dest"; record_path "$dest"
          "$TRUST_CMD" >"$TMP/trust.out" 2>&1 || { cat "$TMP/trust.out" >&2; die "$TRUST_CMD failed"; }
          ok "installed $dest and ran $TRUST_CMD"
        fi ;;
      *) warn "no known trust-store tool here (update-ca-certificates / update-ca-trust). The per-registry copy below may still be enough for Docker and Podman." ;;
    esac
  else
    say "  skipping the system trust store (--no-system-trust)"
  fi
  rdirs=$(runtime_dirs)
  if [ -n "$rdirs" ]; then
    for base in $rdirs; do
      for h in $HOSTS; do
        dest="$base/$h/ca.crt"
        if [ "$DRY" = 1 ]; then say "  would install $dest"
        else mkdir -p "$base/$h"; cp "$CA_FILE" "$dest"; chmod 644 "$dest"; record_path "$dest"; fi
      done
      [ "$DRY" = 1 ] || ok "installed it for each registry under $base (no restart needed)"
    done
  elif [ "$NO_SYSTEM" = 1 ]; then
    warn "Docker and Podman were not found, so nothing was installed. Drop --no-system-trust to trust it system-wide."
  fi
fi

# ---- 4. verify
if [ "$DRY" = 0 ] && [ "$NO_VERIFY" = 0 ] && [ "$NO_HOSTS" = 0 ] && [ "$NO_TRUST" = 0 ]; then
  verify || warn "some checks failed; see above. Re-run with --check after fixing them."
fi

step "Done."
if [ "$DRY" = 1 ]; then say "That was a dry run. Run again without --dry-run to apply it."; exit 0; fi
say "  Docker picks up the per-registry certificate straight away. Restart containerd (Kubernetes nodes) so it"
say "  reads the system store: sudo systemctl restart containerd"
[ "$OS" = Darwin ] && say "  Docker Desktop: restart it so it sees the new trust and hosts entries."
say "  To undo: run this script again with --remove."
