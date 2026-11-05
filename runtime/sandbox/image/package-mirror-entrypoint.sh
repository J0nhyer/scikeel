#!/bin/sh
set -e
devpi-init --serverdir /data >/dev/null 2>&1 || true
if [ -n "$SCIKEEL_PYPI_MIRROR" ]; then
  python /usr/local/bin/package-mirror-configure.py /data "$SCIKEEL_PYPI_MIRROR"
fi
exec devpi-server --serverdir /data --host 0.0.0.0 --port 3141 --threads 4 --connection-limit 32 --request-timeout 60
