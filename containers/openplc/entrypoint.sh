#!/bin/bash
set -e

echo "[ics-openplc] Device=${DEVICE_ID}  web=${OPENPLC_PORT}  modbus=${MODBUS_PORT}"

cd /opt/openplc

# Start OpenPLC Runtime
# The runtime serves the web UI on port 8080 and a Modbus/TCP slave on port 502
exec ./openplc "$@"
