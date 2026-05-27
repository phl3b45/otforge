#!/bin/sh
set -e

echo "[ics-bacnet] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  instance=${BACNET_DEVICE_INSTANCE}  port=${BACNET_PORT}"

exec python3 /app/server.py
