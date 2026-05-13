#!/bin/bash
set -e

IFACE="${SURICATA_IFACE:-eth0}"

echo "[ics-suricata] Device=${DEVICE_ID}  interface=${IFACE}"

# Pull Emerging Threats Open + SCADA rulesets
suricata-update \
    --no-reload \
    --no-test \
    --suricata-conf /etc/suricata/ics-sim.yaml \
    2>/dev/null || echo "[ics-suricata] Rule update failed — continuing with bundled rules"

# Start Suricata in AF_PACKET inline mode
exec suricata \
    -c /etc/suricata/ics-sim.yaml \
    --af-packet="${IFACE}" \
    --init-errors-fatal \
    -l /var/log/suricata
