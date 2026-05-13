#!/bin/bash
set -e

echo "[ics-router] Device=${DEVICE_ID}  ready"

# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true

# Show current routing table
echo "[ics-router] Route table:"
ip route show

exec tail -f /dev/null
