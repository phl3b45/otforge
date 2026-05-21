#!/bin/bash
# entrypoint.sh — Suricata IDS/IPS startup for the otforge-suricata container.
#
# Reads security configuration injected by compose-generator.ts and starts Suricata
# in AF_PACKET inline mode on the specified interface.
#
# Environment variables:
#   DEVICE_ID          — Device node ID from the scenario (logged on start)
#   SURICATA_IFACE     — Network interface to monitor (default: eth0)
#   IDS_RULESETS       — Comma-separated Emerging Threats ruleset IDs to enable.
#                         e.g. "emerging-scada,emerging-modbus"
#                         When empty, defaults to "emerging-scada,emerging-modbus".
#                         Used to filter which suricata-update sources are enabled.
#   IDS_DISABLED_SIDS  — Comma-separated Suricata SID numbers to suppress.
#                         e.g. "2001219,2010936"
#                         Writes a /etc/suricata/threshold.conf suppress block so
#                         the rules still load but never generate alerts for those SIDs.
#                         Useful for suppressing known false positives in lab environments.

set -e

RULESETS="${IDS_RULESETS:-emerging-scada,emerging-modbus}"
DISABLED_SIDS="${IDS_DISABLED_SIDS:-}"
CUSTOM_RULES_B64="${IDS_CUSTOM_RULES_B64:-}"

# ── Select and prepare the capture interface ────────────────────────────────────
# Suricata runs in a Docker container whose eth0 is connected to the OT bridge.
# Without promiscuous mode, the Linux kernel only delivers frames addressed to
# this container's MAC — traffic between other containers is invisible. Setting
# promisc on means the bridge sends ALL frames to our veth pair endpoint so
# Suricata can inspect every packet on the OT network segment.
#
# Interface selection: if SURICATA_IFACE is set, use it; otherwise scan all
# non-loopback interfaces and pick the first one that has an IP in the 10.x
# range (the OT/Control subnets). Falls back to eth0 if none is found.
IFACE="${SURICATA_IFACE:-}"
if [ -z "$IFACE" ]; then
    for candidate in $(ls /sys/class/net/ | grep -v lo | sort); do
        if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.'; then
            IFACE="$candidate"
            break
        fi
    done
    IFACE="${IFACE:-eth0}"
fi

# Enable promiscuous mode (requires NET_ADMIN capability set in compose)
ip link set "$IFACE" promisc on 2>/dev/null \
    && echo "[ics-suricata] Promiscuous mode enabled on ${IFACE}" \
    || echo "[ics-suricata] Warning: could not set promisc on ${IFACE} (may already be set)"

echo "[ics-suricata] Device=${DEVICE_ID}  interface=${IFACE}"
echo "[ics-suricata] Enabled rulesets: ${RULESETS}"
[ -n "$DISABLED_SIDS" ] && echo "[ics-suricata] Suppressed SIDs: ${DISABLED_SIDS}"

# ── Generate SID suppression file ───────────────────────────────────────────────
# Suricata reads threshold.conf at startup. Each suppress entry tells the engine to
# load the rule (so rule counts are accurate) but never emit an alert for that SID.
# This is preferable to disabling rules entirely because it keeps the ruleset complete
# while silencing known lab false-positives.
THRESHOLD_FILE="/etc/suricata/threshold.conf"
# Start with an empty threshold file so old suppression entries don't persist
> "$THRESHOLD_FILE"

if [ -n "$DISABLED_SIDS" ]; then
    for sid in $(echo "$DISABLED_SIDS" | tr ',' ' '); do
        sid_clean=$(echo "$sid" | tr -d '[:space:]')
        if [ -n "$sid_clean" ]; then
            # gen_id 1 = all standard ET rules; sig_id = the specific rule SID
            echo "suppress gen_id 1, sig_id ${sid_clean}" >> "$THRESHOLD_FILE"
            echo "[ics-suricata] Suppressing SID ${sid_clean}"
        fi
    done
fi

# ── Write custom rules ──────────────────────────────────────────────────────────
# IDS_CUSTOM_RULES_B64 carries base64-encoded Suricata rule text authored in the
# OTForge IDSPanel. Decoded to custom.rules so Suricata loads it on startup.
# The rule-files list in otforge.yaml always includes this path; when no custom
# rules are set, an empty file satisfies the include without generating errors.
CUSTOM_RULES_FILE="/etc/suricata/rules/custom.rules"
if [ -n "${CUSTOM_RULES_B64}" ]; then
    echo "[ics-suricata] Decoding custom rules → ${CUSTOM_RULES_FILE}"
    echo "${CUSTOM_RULES_B64}" | base64 -d > "${CUSTOM_RULES_FILE}"
    # Count non-comment, non-blank lines as a proxy for rule count
    rule_count=$(grep -cE '^(alert|drop|pass|reject|rejectsrc|rejectdst|rejectboth)\s' \
        "${CUSTOM_RULES_FILE}" 2>/dev/null || echo 0)
    echo "[ics-suricata] Custom rules loaded: ${rule_count} rule(s)"
else
    # Create an empty file so the rule-files entry in otforge.yaml is always satisfied
    > "${CUSTOM_RULES_FILE}"
    echo "[ics-suricata] No custom rules — ${CUSTOM_RULES_FILE} is empty"
fi

# ── Update rulesets ─────────────────────────────────────────────────────────────
# suricata-update downloads and merges Emerging Threats Open rules. The --no-reload
# flag skips live rule reload (not running yet). --no-test skips the self-test to
# speed up startup. If the update fails (no internet, rate limit), Suricata falls
# back to the bundled otforge.rules and whatever was previously cached.
#
# The IDS_RULESETS variable is logged but not yet used to filter suricata-update
# sources at the CLI level — source filtering requires an enable.conf file which
# is written below for the next startup. On first run all sources update and the
# user-selected rulesets take effect on subsequent container restarts.
echo "[ics-suricata] Running suricata-update (may fail in offline environments)..."
# timeout 30s prevents suricata-update from blocking container startup indefinitely
# when the internet is slow or rate-limiting the Emerging Threats download. On timeout
# or failure, Suricata falls back to the bundled otforge.rules from the image layer.
timeout 30s suricata-update \
    --no-reload \
    --no-test \
    --suricata-conf /etc/suricata/otforge.yaml \
    2>/dev/null || echo "[ics-suricata] Rule update failed or timed out — continuing with bundled rules"

# Write enable.conf so future suricata-update runs only download selected rulesets.
# Format: one "source-name" entry per line that suricata-update should keep enabled.
ENABLE_CONF="/var/lib/suricata/update/enable.conf"
mkdir -p "$(dirname "$ENABLE_CONF")"
> "$ENABLE_CONF"
for rs in $(echo "$RULESETS" | tr ',' ' '); do
    rs_clean=$(echo "$rs" | tr -d '[:space:]')
    [ -n "$rs_clean" ] && echo "$rs_clean" >> "$ENABLE_CONF"
done

# ── Start Suricata ──────────────────────────────────────────────────────────────
# AF_PACKET mode: Suricata operates inline on the specified interface, inspecting
# and optionally dropping packets that match IDS rules. Eve JSON output goes to
# /var/log/suricata/ (a named volume in the compose file, consumed by Loki in Phase 6).
echo "[ics-suricata] Starting Suricata in AF_PACKET mode on ${IFACE}..."
exec suricata \
    -c /etc/suricata/otforge.yaml \
    --af-packet="${IFACE}" \
    --init-errors-fatal \
    -l /var/log/suricata
