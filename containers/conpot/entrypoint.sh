#!/bin/sh
set -e

case "$DEVICE_CATEGORY" in
  legacy-plc)
    echo "[ics-conpot] Device=${DEVICE_ID}  profile=S7-${S7_DEVICE_TYPE}  port=${S7_PORT}"
    ;;
  iec104-rtu)
    echo "[ics-conpot] Device=${DEVICE_ID}  profile=IEC-104  common_addr=${IEC104_COMMON_ADDRESS}  port=${IEC104_PORT}"
    ;;
  *)
    echo "[ics-conpot] WARNING: unrecognised DEVICE_CATEGORY='${DEVICE_CATEGORY}', defaulting to S7-300"
    ;;
esac

exec python3 /app/server.py
