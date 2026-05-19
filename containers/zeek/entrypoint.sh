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

IFACE="${ZEEK_IFACE:-eth0}"
SCRIPTS="${ZEEK_SCRIPTS:-modbus.zeek,dnp3.zeek}"

echo "[ics-zeek] Device=${DEVICE_ID}  interface=${IFACE}"
echo "[ics-zeek] Requested scripts: ${SCRIPTS}"

# ── Resolve requested scripts to absolute paths ─────────────────────────────────
# Each script name in ZEEK_SCRIPTS is resolved against the Zeek site directory.
# Non-existent scripts are skipped with a warning rather than failing the container.
SITE_DIR="/opt/zeek/share/zeek/site"
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
# local.zeek is the Zeek site policy — it already includes ics-monitor.zeek via the
# RUN echo "@load ics-monitor" step in the Dockerfile. Any additional scripts
# resolved above are passed as positional arguments after the site policy.
echo "[ics-zeek] Starting Zeek passive monitor on ${IFACE}..."
exec zeek -i "${IFACE}" "${SITE_DIR}/local.zeek" "${EXTRA_ARGS[@]}"
