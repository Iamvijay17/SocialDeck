#!/bin/sh
# Creates a self-signed certificate for https://localhost on first start and keeps it in the /certs volume, so the
# browser exception you accept once stays valid. Needed because Threads and LinkedIn only accept https:// redirect
# addresses. The private key never leaves this volume; the certificate is valid for localhost / 127.0.0.1 / ::1 only.
set -e
CERT_DIR=/certs
if [ ! -s "$CERT_DIR/localhost.crt" ] || [ ! -s "$CERT_DIR/localhost.key" ]; then
  echo "[socialdeck] generating a self-signed certificate for localhost"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -keyout "$CERT_DIR/localhost.key" -out "$CERT_DIR/localhost.crt" \
    -subj "/CN=localhost/O=SocialDeck local development" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  chmod 600 "$CERT_DIR/localhost.key"
fi
