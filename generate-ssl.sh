#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="${CERT_DIR:-$ROOT/certs}"
DAYS="${CERT_DAYS:-3650}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

mkdir -p "$CERT_DIR"

is_ip() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$1" == *:* ]]
}

add_unique() {
  local -n arr=$1
  local value=$2
  [[ -n "$value" ]] || return 0
  local item
  for item in "${arr[@]+"${arr[@]}"}"; do
    if [[ "$item" == "$value" ]]; then
      return 0
    fi
  done
  arr+=("$value")
}

DNS_NAMES=()
IP_ADDRS=()

add_host() {
  local host=$1
  [[ -n "$host" ]] || return 0
  if is_ip "$host"; then
    add_unique IP_ADDRS "$host"
  else
    add_unique DNS_NAMES "$host"
  fi
}

add_host "localhost"
add_host "127.0.0.1"
add_host "::1"

if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^(MAIN_SERVER|SERVER_[0-9]+)= ]] || continue
    value="${line#*=}"
    value="${value%%$'\r'}"
    rest="${value#*@}"
    host="${rest%%[:/]*}"
    add_host "$host"
  done < "$ENV_FILE"
fi

if command -v hostname >/dev/null 2>&1; then
  add_host "$(hostname -s 2>/dev/null || true)"
  add_host "$(hostname -f 2>/dev/null || true)"
  while read -r ip; do
    add_host "$ip"
  done < <(hostname -I 2>/dev/null || true)
fi

for extra in "$@"; do
  add_host "$extra"
done

if [[ ! -f "$CERT_DIR/ca.key" || ! -f "$CERT_DIR/ca.crt" ]]; then
  echo "Creating internal CA..."
  openssl genrsa -out "$CERT_DIR/ca.key" 4096
  openssl req -x509 -new -nodes \
    -key "$CERT_DIR/ca.key" \
    -sha256 \
    -days "$DAYS" \
    -subj "/CN=storage-server-internal-ca" \
    -out "$CERT_DIR/ca.crt"
else
  echo "Reusing existing CA at $CERT_DIR/ca.crt"
fi

CNF="$CERT_DIR/server.cnf"
{
  echo "[req]"
  echo "distinguished_name = req_distinguished_name"
  echo "req_extensions = v3_req"
  echo "prompt = no"
  echo
  echo "[req_distinguished_name]"
  echo "CN = storage-server"
  echo
  echo "[v3_req]"
  echo "basicConstraints = CA:FALSE"
  echo "keyUsage = digitalSignature, keyEncipherment"
  echo "extendedKeyUsage = serverAuth"
  echo "subjectAltName = @alt_names"
  echo
  echo "[alt_names]"
  i=1
  for name in "${DNS_NAMES[@]+"${DNS_NAMES[@]}"}"; do
    echo "DNS.$i = $name"
    i=$((i + 1))
  done
  i=1
  for ip in "${IP_ADDRS[@]+"${IP_ADDRS[@]}"}"; do
    echo "IP.$i = $ip"
    i=$((i + 1))
  done
} > "$CNF"

echo "Creating server certificate..."
openssl genrsa -out "$CERT_DIR/server.key" 2048
openssl req -new -key "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" -config "$CNF"
openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days "$DAYS" \
  -sha256 \
  -extfile "$CNF" \
  -extensions v3_req

chmod 600 "$CERT_DIR/ca.key" "$CERT_DIR/server.key"
rm -f "$CERT_DIR/server.csr"

echo
echo "Wrote:"
echo "  CA:     $CERT_DIR/ca.crt"
echo "  Cert:   $CERT_DIR/server.crt"
echo "  Key:    $CERT_DIR/server.key"
echo
echo "SANs:"
for name in "${DNS_NAMES[@]+"${DNS_NAMES[@]}"}"; do
  echo "  DNS $name"
done
for ip in "${IP_ADDRS[@]+"${IP_ADDRS[@]}"}"; do
  echo "  IP  $ip"
done
echo
echo "Copy ca.crt to every node in the horsebot network and keep using the same CA."
echo "Other apps should verify TLS with this CA — then they will not warn about an untrusted certificate."
