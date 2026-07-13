#!/bin/sh
set -e

echo "[ics-ethernetip] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  port=${ENIP_PORT}"

exec python3 /app/server.py
