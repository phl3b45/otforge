#!/bin/bash
# entrypoint.sh — Suricata IDS/IPS startup for the otforge-suricata container.
#
# Reads security configuration injected by compose-generator.ts and starts Suricata
# in AF_PACKET mode on all detected simulation interfaces.
#
# Environment variables:
#   DEVICE_ID          — Device node ID from the scenario (logged on start)
#   SURICATA_IFACE     — Network interface to monitor (default: auto-detect all 10.x ifaces)
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

IFACES=()
CLUSTER_ID=1

if [ -n "${SURICATA_IFACE:-}" ]; then
    # Explicit single-interface override (useful for unit tests or non-host-mode deployments)
    ip link set "$SURICATA_IFACE" promisc on 2>/dev/null \
        && echo "[ics-suricata] Promiscuous mode enabled on ${SURICATA_IFACE}" \
        || echo "[ics-suricata] Warning: could not set promisc on ${SURICATA_IFACE}"
    IFACES=("$SURICATA_IFACE")
else
    # Running in host network mode: detect Docker bridge interfaces (br-XXXX) that carry
    # simulation traffic. Docker creates a br-XXXX Linux bridge on the host for each
    # network; the host-side bridge sees ALL inter-container unicast frames, unlike a
    # container veth which only receives frames addressed to its own MAC.
    #
    # Selection criteria:
    #   1. Interface has a "bridge" kernel type (directory /sys/class/net/<iface>/bridge exists)
    #   2. Interface has an address in 10.200.x.x (our simulation subnet range)
    #
    # We do NOT set promiscuous mode on bridge interfaces — the bridge already receives
    # all frames from its member ports. Promisc on br-XXXX is a no-op for capture purposes.
    for candidate in $(ls /sys/class/net/ 2>/dev/null | sort); do
        if [ -d "/sys/class/net/${candidate}/bridge" ] 2>/dev/null; then
            if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.200\.'; then
                echo "[ics-suricata] Found simulation bridge: ${candidate}"
                IFACES+=("$candidate")
            fi
        fi
    done
    if [ ${#IFACES[@]} -eq 0 ]; then
        # Fallback: no bridge interfaces found — may be running outside host-network mode.
        # Fall back to scanning all non-loopback interfaces with a 10.x address (old behaviour).
        echo "[ics-suricata] Warning: no br-XXXX bridge interfaces found, falling back to veth scan"
        for candidate in $(ls /sys/class/net/ 2>/dev/null | grep -v lo | sort); do
            if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.'; then
                ip link set "$candidate" promisc on 2>/dev/null
                IFACES+=("$candidate")
            fi
        done
    fi
    if [ ${#IFACES[@]} -eq 0 ]; then
        echo "[ics-suricata] Warning: no suitable interface found, falling back to eth0"
        IFACES=("eth0")
    fi
fi

echo "[ics-suricata] Device=${DEVICE_ID}  interfaces=${IFACES[*]}"

# ── Write af-packet config to a separate include file ───────────────────────────
# Writing to a SEPARATE file (not appending to otforge.yaml) prevents the af-packet
# block from accumulating on each Docker restart. Docker's restart policy re-uses the
# same container filesystem, so >> appends would add a duplicate af-packet section on
# every crash-restart cycle, triggering "Configuration node 'af-packet' redefined"
# warnings and eventually corrupting the config.
#
# Using > (overwrite) on a dedicated file makes the entrypoint idempotent across
# restarts. Suricata loads it via --include on the CLI.
#
# Each interface gets a unique cluster-id so the kernel delivers frame copies to
# separate AF_PACKET sockets. cluster_flow hashing ensures all packets of a given
# TCP/UDP flow land on the same worker thread for correct stream reassembly.
AF_PACKET_CONF="/etc/suricata/af-packet.yaml"
{
    # Suricata requires all included config files to begin with the YAML 1.1 header
    printf "%%YAML 1.1\n---\n"
    printf "af-packet:\n"
    for iface in "${IFACES[@]}"; do
        printf "  - interface: %s\n"    "$iface"
        printf "    cluster-id: %d\n"   "$CLUSTER_ID"
        printf "    cluster-type: cluster_flow\n"
        printf "    defrag: yes\n"
        CLUSTER_ID=$((CLUSTER_ID + 1))
    done
} > "$AF_PACKET_CONF"

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

# ── Ensure suricata.rules placeholder exists ────────────────────────────────────
# The rule-files list in otforge.yaml includes /var/lib/suricata/rules/suricata.rules,
# which is populated by suricata-update (run in the background below). On the first
# start the file does not yet exist, and --init-errors-fatal treats a missing rule file
# as a fatal init error, killing Suricata immediately before it can capture any traffic.
# Creating an empty placeholder satisfies the rule-files list so Suricata starts with
# only our bundled otforge.rules. suricata-update will overwrite this file with the
# full Emerging Threats ruleset once it completes; the rules take effect on next restart.
SURICATA_RULES="/var/lib/suricata/rules/suricata.rules"
if [ ! -f "$SURICATA_RULES" ]; then
    mkdir -p "$(dirname "$SURICATA_RULES")"
    touch "$SURICATA_RULES"
    echo "[ics-suricata] Created empty placeholder: ${SURICATA_RULES}"
fi

# ── Update rulesets (non-blocking background job) ────────────────────────────────
# suricata-update downloads and merges Emerging Threats Open rules.
# Runs in the background so Suricata starts immediately with the bundled otforge.rules.
# If suricata-update succeeds, the new suricata.rules takes effect on next restart.

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
# --af-packet (no argument) activates AF_PACKET capture mode in Suricata 8+.
# Interface definitions come from the af-packet.yaml include file written above
# rather than appended to otforge.yaml, so the config stays clean across restarts.
# Eve JSON output goes to /var/log/suricata/ (named volume shared with Promtail).
echo "[ics-suricata] Starting Suricata in AF_PACKET mode on ${IFACES[*]}..."
exec suricata \
    --af-packet \
    -c /etc/suricata/otforge.yaml \
    --include "$AF_PACKET_CONF" \
    --init-errors-fatal \
    -l /var/log/suricata
