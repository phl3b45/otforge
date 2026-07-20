#!/bin/sh
set -e

echo "[ics-dcs] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  port=${OPCUA_PORT}  ns=${OPCUA_NAMESPACE}"
echo "[ics-dcs] Field devices: ${DCS_FIELD_DEVICES:-<none — DCS not wired to any field device>}"

exec python3 /app/server.py
