#!/bin/sh
set -e

echo "[ics-profinet] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  iface=${PROFINET_IFACE}  station=${PROFINET_STATION_NAME}"

# DCP-Identify requests go to multicast MAC 01:0E:CF:00:00:00, which the kernel
# drops before it reaches our raw AF_PACKET socket unless the interface is in
# promiscuous mode (the container never explicitly joins that multicast group).
# Same reasoning/fix as containers/zeek's ZEEK_IFACE promisc handling.
ip link set "${PROFINET_IFACE}" promisc on 2>/dev/null \
    && echo "[ics-profinet] ${PROFINET_IFACE} set to promiscuous mode" \
    || echo "[ics-profinet] Warning: could not set promisc on ${PROFINET_IFACE}"

exec python3 /app/server.py
