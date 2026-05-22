#!/bin/bash
# entrypoint.sh — Zeek network monitor startup for the otforge-zeek container.
#
# Reads script configuration injected by compose-generator.ts and starts Zeek
# in passive analysis mode on the specified interface.
#
# Environment variables:
#   DEVICE_ID     — Device node ID from the scenario (logged on start)
#   ZEEK_IFACE    — Network interface to monitor (default: eth0)
#   ZEEK_SCRIPTS  — Comma-separated script filenames to load from the Zeek site dir.
#                   e.g. "modbus.zeek,dnp3.zeek,ics.zeek"
#                   When empty, defaults to "modbus.zeek,dnp3.zeek".
#                   Scripts must exist under /opt/zeek/share/zeek/site/.
#                   The bundled ics-monitor.zeek is always loaded via local.zeek.
#
# Zeek operates passively: it observes a copy of all traffic on eth0 but does not
# block or modify packets. Log files (conn.log, modbus.log, etc.) are written to
# /var/log/zeek/ (a named volume in the compose file, consumed by Loki in Phase 6).

set -e

SCRIPTS="${ZEEK_SCRIPTS:-modbus.zeek,dnp3.zeek}"

# ── Select and prepare the capture interface ────────────────────────────────────
# Same promiscuous-mode requirement as Suricata: without promisc, Zeek only sees
# frames addressed to its own MAC. Enabling promisc lets the bridge deliver copies
# of ALL frames so Zeek can build complete connection logs.
IFACE="${ZEEK_IFACE:-}"
if [ -z "$IFACE" ]; then
    for candidate in $(ls /sys/class/net/ | grep -v lo | sort); do
        if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.'; then
            IFACE="$candidate"
            break
        fi
    done
    IFACE="${IFACE:-eth0}"
fi

ip link set "$IFACE" promisc on 2>/dev/null \
    && echo "[ics-zeek] Promiscuous mode enabled on ${IFACE}" \
    || echo "[ics-zeek] Warning: could not set promisc on ${IFACE}"

echo "[ics-zeek] Device=${DEVICE_ID}  interface=${IFACE}"
echo "[ics-zeek] Requested scripts: ${SCRIPTS}"

# ── Resolve requested scripts to absolute paths ─────────────────────────────────
# Each script name in ZEEK_SCRIPTS is resolved against the Zeek site directory.
# Non-existent scripts are skipped with a warning rather than failing the container.
SITE_DIR="/usr/local/zeek/share/zeek/site"
EXTRA_ARGS=()

for script in $(echo "$SCRIPTS" | tr ',' ' '); do
    script_clean=$(echo "$script" | tr -d '[:space:]')
    [ -z "$script_clean" ] && continue

    script_path="${SITE_DIR}/${script_clean}"
    if [ -f "$script_path" ]; then
        EXTRA_ARGS+=("$script_path")
        echo "[ics-zeek] Loading script: ${script_clean}"
    else
        # Script not found — this is expected if the scenario enables a script that
        # hasn't been bundled into the image yet. Log and continue gracefully.
        echo "[ics-zeek] Warning: script not found, skipping: ${script_clean}"
    fi
done

# ── Start Zeek ──────────────────────────────────────────────────────────────────
# `zeek -i` writes all log files (conn.log, modbus.log, etc.) to its WORKING
# DIRECTORY — there is no --logdir flag in standalone mode (zeekctl handles that
# in managed deployments). We cd to the named volume path before exec so the logs
# land where Promtail expects them. exec inherits the working directory.
LOG_DIR="/var/log/zeek"
mkdir -p "${LOG_DIR}"
cd "${LOG_DIR}"
echo "[ics-zeek] Log directory: ${LOG_DIR}"
echo "[ics-zeek] Starting Zeek passive monitor on ${IFACE}..."
exec zeek -i "${IFACE}" "${SITE_DIR}/local.zeek" "${EXTRA_ARGS[@]}"
