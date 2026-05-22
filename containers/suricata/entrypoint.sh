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

# ── Select and prepare capture interfaces ───────────────────────────────────────
# Suricata is attached to multiple Docker bridge networks (ot-net, control-net,
# internet-dmz-net, attacker-net). Without promiscuous mode, the Linux kernel only
# delivers frames addressed to this container's own MAC. Promiscuous mode makes the
# bridge deliver ALL frames so Suricata can inspect every packet on each segment.
#
# IMPORTANT — why CLI --af-packet flags are NOT used here:
#   Multiple --af-packet=ethX CLI flags all share the same default cluster-id.
#   The Linux kernel delivers frames to only the LAST socket that registered with
#   a given cluster-id, so only one interface actually captures. The correct approach
#   is to write one af-packet YAML entry per interface with a UNIQUE cluster-id into
#   the config file before starting Suricata, then start without any CLI --af-packet
#   flags. Suricata then spawns one capture worker per config entry, each receiving
#   its own frame copy from the kernel.

IFACES=()
CLUSTER_ID=1

if [ -n "${SURICATA_IFACE:-}" ]; then
    # Explicit single-interface override (useful for unit tests)
    ip link set "$SURICATA_IFACE" promisc on 2>/dev/null \
        && echo "[ics-suricata] Promiscuous mode enabled on ${SURICATA_IFACE}" \
        || echo "[ics-suricata] Warning: could not set promisc on ${SURICATA_IFACE}"
    IFACES=("$SURICATA_IFACE")
else
    # Auto-detect every non-loopback interface with a 10.x address
    for candidate in $(ls /sys/class/net/ 2>/dev/null | grep -v lo | sort); do
        if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.'; then
            ip link set "$candidate" promisc on 2>/dev/null \
                && echo "[ics-suricata] Promiscuous mode enabled on ${candidate}" \
                || echo "[ics-suricata] Warning: could not set promisc on ${candidate}"
            IFACES+=("$candidate")
        fi
    done
    if [ ${#IFACES[@]} -eq 0 ]; then
        echo "[ics-suricata] Warning: no 10.x interface found, falling back to eth0"
        IFACES=("eth0")
    fi
fi

echo "[ics-suricata] Device=${DEVICE_ID}  interfaces=${IFACES[*]}"

# ── Write af-packet section into config with unique cluster-ids ─────────────────
# Each interface entry gets its own cluster-id (1, 2, 3…). cluster_flow hashing
# ensures all packets of a given TCP/UDP flow land on the same worker thread so
# stream reassembly works correctly across multi-packet sessions.
{
    printf "\naf-packet:\n"
    for iface in "${IFACES[@]}"; do
        printf "  - interface: %s\n"    "$iface"
        printf "    cluster-id: %d\n"   "$CLUSTER_ID"
        printf "    cluster-type: cluster_flow\n"
        printf "    defrag: yes\n"
        CLUSTER_ID=$((CLUSTER_ID + 1))
    done
} >> /etc/suricata/otforge.yaml
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

# ── Update rulesets (non-blocking background job) ────────────────────────────────
# suricata-update downloads and merges Emerging Threats Open rules.
#
# Previous behaviour: suricata-update ran synchronously with a 30-second timeout
# BEFORE Suricata started. On air-gapped or rate-limited networks this always timed
# out, adding 30 s to every startup with no benefit — Suricata would fall back to
# the bundled rules anyway. Worse, if the internet-dmz / attacker networks had
# connectivity, the 30-second wait still blocked alert generation during that window.
#
# New behaviour: write the enable.conf first, then launch suricata-update in the
# background (& disown). Suricata starts immediately with the bundled otforge.rules
# and the previously-cached suricata.rules. If suricata-update succeeds and produces
# a new suricata.rules file, Suricata will pick it up on the NEXT restart — live
# rule reload via SIGUSR2 is intentionally omitted to avoid disrupting running flows.

# Write enable.conf so suricata-update only downloads selected rulesets.
ENABLE_CONF="/var/lib/suricata/update/enable.conf"
mkdir -p "$(dirname "$ENABLE_CONF")"
> "$ENABLE_CONF"
for rs in $(echo "$RULESETS" | tr ',' ' '); do
    rs_clean=$(echo "$rs" | tr -d '[:space:]')
    [ -n "$rs_clean" ] && echo "$rs_clean" >> "$ENABLE_CONF"
done

echo "[ics-suricata] Launching suricata-update in background (non-blocking)..."
(
    suricata-update \
        --no-reload \
        --no-test \
        --suricata-conf /etc/suricata/otforge.yaml \
        2>/dev/null \
    && echo "[ics-suricata] Background rule update complete" \
    || echo "[ics-suricata] Background rule update failed or offline — bundled rules active"
) &
disown $!

# ── Start Suricata ──────────────────────────────────────────────────────────────
# No --af-packet CLI flags — the af-packet: section appended to otforge.yaml above
# defines all interfaces with unique cluster-ids. Eve JSON output goes to
# /var/log/suricata/ (named volume shared with Promtail, consumed by Loki).
echo "[ics-suricata] Starting Suricata in AF_PACKET mode on ${IFACES[*]}..."
exec suricata \
    -c /etc/suricata/otforge.yaml \
    --init-errors-fatal \
    -l /var/log/suricata
