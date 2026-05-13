#!/bin/bash
set -e

IFACE="${ZEEK_IFACE:-eth0}"

echo "[ics-zeek] Device=${DEVICE_ID}  interface=${IFACE}"

# Start Zeek in passive analysis mode on the specified interface
exec zeek -i "${IFACE}" /opt/zeek/share/zeek/site/local.zeek
