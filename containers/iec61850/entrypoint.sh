#!/bin/sh
# entrypoint.sh — IEC 61850 IED (MMS server) startup.
set -e

echo "[ics-iec61850] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  MMS port=${IEC61850_PORT}"
echo "[ics-iec61850] Serving IEC 61850 over MMS (port 102). GOOSE/SV not enabled."

# server_example_basic_io takes the TCP port as its first argument (defaults to
# 102 if omitted). Bind on all interfaces via the port only.
exec /app/iec61850-server "${IEC61850_PORT}"
