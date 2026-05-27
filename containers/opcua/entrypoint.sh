#!/bin/sh
set -e

echo "[ics-opcua] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  port=${OPCUA_PORT}  ns=${OPCUA_NAMESPACE}"

exec python3 /app/server.py
