#!/bin/bash
# entrypoint.sh — nftables firewall configuration for the otforge-firewall container.
#
# Builds an nftables ruleset from environment variables injected by the compose
# generator (packages/orchestrator/src/compose-generator.ts) then keeps running.
#
# The container bridges OT, Control, and Plant-DMZ networks (three interfaces), which
# is why NET_ADMIN and NET_RAW capabilities are required in the compose file.
#
# Environment variables:
#   DEVICE_ID          — Device node ID from the scenario (logged on start)
#   FW_DEFAULT_POLICY  — "accept" or "drop" (default: "drop")
#                         drop  = deny-by-default (recommended for ICS)
#                         accept = allow-by-default (open-lab scenarios)
#   FW_RULES_JSON      — JSON array of ACLRule objects from scenario.security.firewallRules.
#                         Each rule: { id, sourceZone, destinationZone, protocol,
#                                      destinationPort, action, comment? }
#                         Zones: "ot" | "control" | "plant-dmz" | "enterprise" |
#                                "internet-dmz" | "attacker" | "any"
#                         Protocol: "tcp" | "udp" | "icmp" | "any"
#                         Port: number | "any"
#                         Action: "allow" | "deny"
#                         Parsed with jq; requires jq in the image (apk add jq).
#
# Zone subnet variables (injected by compose-generator.ts at simulation start):
#   FW_ZONE_OT           — OT network CIDR        (default: 10.200.10.0/24)
#   FW_ZONE_CONTROL      — Control center CIDR    (default: 10.200.20.0/24)
#   FW_ZONE_PLANT_DMZ    — Plant DMZ CIDR         (default: 10.200.30.0/24)
#   FW_ZONE_ENTERPRISE   — Enterprise zone CIDR   (default: 10.200.40.0/24)
#   FW_ZONE_INTERNET_DMZ — Internet DMZ CIDR      (default: 10.200.50.0/24)
#   FW_ZONE_ATTACKER     — Red team subnet CIDR   (default: 10.200.60.0/24)
#
# Network zones follow the Purdue Reference Model (IEC 62443-3-2 / NIST SP 800-82):
#   ot           — Levels 0–2: PLCs, RTUs, IEDs, sensors, actuators
#   control      — Level 3:    HMIs, historians, engineering workstations
#   plant-dmz    — Level 3.5:  Firewalls, IDS/IPS, jump hosts
#   enterprise   — Level 4:    Domain controllers, business servers, desktops
#   internet-dmz — Level 5:    Internet-facing servers, DNS
#   attacker     — Red team:   Isolated attack machine subnet

set -e

POLICY="${FW_DEFAULT_POLICY:-drop}"
echo "[ics-firewall] ================================================"
echo "[ics-firewall] Device=${DEVICE_ID}  default-policy=${POLICY}"
echo "[ics-firewall] Zone subnets:"
echo "[ics-firewall]   ot           = ${FW_ZONE_OT}"
echo "[ics-firewall]   control      = ${FW_ZONE_CONTROL}"
echo "[ics-firewall]   plant-dmz    = ${FW_ZONE_PLANT_DMZ}"
echo "[ics-firewall]   enterprise   = ${FW_ZONE_ENTERPRISE}"
echo "[ics-firewall]   internet-dmz = ${FW_ZONE_INTERNET_DMZ}"
echo "[ics-firewall]   attacker     = ${FW_ZONE_ATTACKER}"
echo "[ics-firewall] ================================================"

# ── Enable IP forwarding ────────────────────────────────────────────────────────
# The firewall container forwards packets between its three interfaces.
# Write to both global and per-interface paths; suppress errors on restricted kernels.
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
echo 1 > /proc/sys/net/ipv4/conf/all/forwarding 2>/dev/null || true

# ── Initialize nftables ─────────────────────────────────────────────────────────
# Start from a clean slate on every container start.
nft flush ruleset

# inet family matches both IPv4 and IPv6 in one table — simpler than separate ip/ip6.
nft add table inet ics_fw

# Forward chain: filters packets forwarded between interfaces (not locally terminated).
# policy $POLICY = default action when no rule matches.
nft add chain inet ics_fw forward "{ type filter hook forward priority 0; policy ${POLICY}; }"

# ── Stateful baseline rules ─────────────────────────────────────────────────────
# Allow established/related connections — required for reply traffic on all TCP sessions.
nft add rule inet ics_fw forward ct state established,related accept

# Allow ICMP between zones so students can use ping for reachability checks.
nft add rule inet ics_fw forward ip protocol icmp accept
nft add rule inet ics_fw forward ip6 nexthdr icmpv6 accept

# ── Zone subnet lookup ──────────────────────────────────────────────────────────
# Returns the CIDR subnet for a zone name from env vars injected by compose-generator.ts.
# Returns empty string for "any" (no src/dst address filter in the nft rule).
# Zone names match the NetworkZone type in packages/schema/src/icslab.ts exactly.
zone_subnet() {
    case "$1" in
        ot)           echo "${FW_ZONE_OT}" ;;
        control)      echo "${FW_ZONE_CONTROL}" ;;
        plant-dmz)    echo "${FW_ZONE_PLANT_DMZ}" ;;
        enterprise)   echo "${FW_ZONE_ENTERPRISE}" ;;
        internet-dmz) echo "${FW_ZONE_INTERNET_DMZ}" ;;
        attacker)     echo "${FW_ZONE_ATTACKER}" ;;
        *)            echo "" ;;  # "any" or unknown → no subnet restriction
    esac
}

# ── ACL rules from FW_RULES_JSON ────────────────────────────────────────────────
# Parse the JSON array of ACLRule objects injected by the compose generator.
# Each object is translated directly to one nftables forward rule.
if [ -n "${FW_RULES_JSON}" ] && [ "${FW_RULES_JSON}" != "[]" ]; then
    RULE_COUNT=$(echo "${FW_RULES_JSON}" | jq 'length')
    echo "[ics-firewall] Loading ${RULE_COUNT} ACL rule(s) from scenario..."

    for i in $(seq 0 $((RULE_COUNT - 1))); do
        RULE=$(echo "${FW_RULES_JSON}" | jq ".[$i]")
        SRC_ZONE=$(echo "$RULE"  | jq -r '.sourceZone')
        DST_ZONE=$(echo "$RULE"  | jq -r '.destinationZone')
        PROTO=$(echo "$RULE"     | jq -r '.protocol')
        PORT=$(echo "$RULE"      | jq -r '.destinationPort | tostring')
        ACTION=$(echo "$RULE"    | jq -r '.action')
        COMMENT=$(echo "$RULE"   | jq -r '.comment // ""')

        SRC_SUBNET=$(zone_subnet "$SRC_ZONE")
        DST_SUBNET=$(zone_subnet "$DST_ZONE")

        # Build the nft add rule argument list incrementally.
        # We collect parts into a shell array so whitespace is handled correctly.
        PARTS=("inet" "ics_fw" "forward")

        # Source zone filter (omit for "any")
        [ -n "$SRC_SUBNET" ] && PARTS+=("ip" "saddr" "$SRC_SUBNET")

        # Destination zone filter (omit for "any")
        [ -n "$DST_SUBNET" ] && PARTS+=("ip" "daddr" "$DST_SUBNET")

        # Protocol and optional port filter
        case "$PROTO" in
            tcp)
                if [ "$PORT" != "any" ] && [ -n "$PORT" ]; then
                    PARTS+=("tcp" "dport" "$PORT")
                fi
                ;;
            udp)
                if [ "$PORT" != "any" ] && [ -n "$PORT" ]; then
                    PARTS+=("udp" "dport" "$PORT")
                fi
                ;;
            icmp)
                PARTS+=("ip" "protocol" "icmp")
                ;;
            # "any" protocol: no protocol filter — rule matches all L4 types
        esac

        # Translate schema action to nftables verdict
        NFT_ACTION=$([ "$ACTION" = "allow" ] && echo "accept" || echo "drop")
        PARTS+=("$NFT_ACTION")

        nft add rule "${PARTS[@]}"
        echo "[ics-firewall] Rule[$i]: ${SRC_ZONE}→${DST_ZONE} proto=${PROTO} port=${PORT} action=${ACTION}${COMMENT:+ # ${COMMENT}}"
    done
fi

# ── Display final ruleset ───────────────────────────────────────────────────────
echo "[ics-firewall] Active nftables ruleset:"
nft list ruleset

# ── Keep container running ──────────────────────────────────────────────────────
# nftables rules are stateless kernel state — they persist as long as the container's
# network namespace is alive. tail -f keeps the process alive at zero CPU cost.
exec tail -f /dev/null
