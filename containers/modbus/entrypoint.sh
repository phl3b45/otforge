#!/bin/sh
set -e

echo "[ics-modbus] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  port=${MODBUS_PORT}  unit=${MODBUS_UNIT_ID}"

exec python3 /app/server.py
