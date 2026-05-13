#!/bin/sh
# ICS virtual switch — visible topology node.
# Docker already handles L2 bridging between containers on the same network.
# This container acts as the labeled "switch" node in the SCADA diagram
# and provides tcpdump access for traffic inspection.

echo "[ics-switch] Device=${DEVICE_ID}  ready"
echo "[ics-switch] Interfaces:"
ip link show

exec tail -f /dev/null
