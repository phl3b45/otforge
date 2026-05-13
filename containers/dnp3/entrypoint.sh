#!/bin/sh
set -e

echo "[ics-dnp3] Device=${DEVICE_ID}  port=${DNP3_PORT}  outstation=${DNP3_OUTSTATION_ADDRESS}  master=${DNP3_MASTER_ADDRESS}"

exec python3 /app/outstation.py
