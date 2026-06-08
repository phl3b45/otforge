#!/bin/bash
# reload-fw-rules.sh — Reference copy of the firewall reload logic.
#
# NOT installed into the container image (see Dockerfile — only entrypoint.sh is copied).
# The actual reload is driven by packages/app/src/main/index.ts: buildNftScript()
# generates nft commands from the live scenario data and pipes them into the running
# container via `docker exec -i <container> sh`. No image rebuild required.
#
# This file exists as a human-readable reference for the reload sequence and for
# manual testing: docker exec -i <container> bash < reload-fw-rules.sh
#
# Requires env vars set at container startup by compose-generator:
#   FW_ZONE_OT, FW_ZONE_CONTROL, FW_ZONE_PLANT_DMZ,
#   FW_ZONE_ENTERPRISE, FW_ZONE_INTERNET_DMZ, FW_ZONE_ATTACKER
#
# For manual testing, also set:
#   FW_RULES_JSON    — ACLRule array JSON (or "" / "[]" for no rules)
#   FW_DEFAULT_POLICY — "accept" | "drop"

set -e

POLICY="${FW_DEFAULT_POLICY:-drop}"
echo "[ics-firewall] Reloading rules: default-policy=${POLICY}"

# Flush all rules in the forward chain — keeps the chain structure and the
# NAT masquerade table/chain intact so existing connections are not killed.
nft flush chain inet ics_fw forward

# Update default policy on the existing chain without changing hook/priority.
nft chain inet ics_fw forward "{ policy ${POLICY}; }"

# Baseline: always allow established/related and ICMP (must be re-added after flush).
nft add rule inet ics_fw forward ct state established,related accept
nft add rule inet ics_fw forward ip protocol icmp accept
nft add rule inet ics_fw forward ip6 nexthdr icmpv6 accept

# ── Zone subnet lookup ───────────────────────────────────────────────────────────
# Mirrors the zone_subnet() function in entrypoint.sh exactly.
zone_subnet() {
    case "$1" in
        ot)           echo "${FW_ZONE_OT}" ;;
        control)      echo "${FW_ZONE_CONTROL}" ;;
        plant-dmz)    echo "${FW_ZONE_PLANT_DMZ}" ;;
        enterprise)   echo "${FW_ZONE_ENTERPRISE}" ;;
        internet-dmz) echo "${FW_ZONE_INTERNET_DMZ}" ;;
        attacker)     echo "${FW_ZONE_ATTACKER}" ;;
        *)            echo "" ;;
    esac
}

# ── ACL rules from FW_RULES_JSON ─────────────────────────────────────────────────
if [ -n "${FW_RULES_JSON}" ] && [ "${FW_RULES_JSON}" != "[]" ]; then
    RULE_COUNT=$(echo "${FW_RULES_JSON}" | jq 'length')
    echo "[ics-firewall] Applying ${RULE_COUNT} ACL rule(s)..."

    # Deny rules first so explicit denies override any pre-existing allow.
    DENY_INDICES=$(echo "${FW_RULES_JSON}" | jq -r 'to_entries[] | select(.value.action == "deny") | .key')
    ALLOW_INDICES=$(echo "${FW_RULES_JSON}" | jq -r 'to_entries[] | select(.value.action == "allow") | .key')
    ORDERED_INDICES="${DENY_INDICES} ${ALLOW_INDICES}"

    for i in ${ORDERED_INDICES}; do
        RULE=$(echo "${FW_RULES_JSON}" | jq ".[$i]")
        SRC_ZONE=$(echo "$RULE"  | jq -r '.sourceZone')
        DST_ZONE=$(echo "$RULE"  | jq -r '.destinationZone')
        PROTO=$(echo "$RULE"     | jq -r '.protocol')
        PORT=$(echo "$RULE"      | jq -r '.destinationPort | tostring')
        ACTION=$(echo "$RULE"    | jq -r '.action')
        COMMENT=$(echo "$RULE"   | jq -r '.comment // ""')

        SRC_SUBNET=$(zone_subnet "$SRC_ZONE")
        DST_SUBNET=$(zone_subnet "$DST_ZONE")

        PARTS=("inet" "ics_fw" "forward")

        [ -n "$SRC_SUBNET" ] && PARTS+=("ip" "saddr" "$SRC_SUBNET")
        [ -n "$DST_SUBNET" ] && PARTS+=("ip" "daddr" "$DST_SUBNET")

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
        esac

        NFT_ACTION=$([ "$ACTION" = "allow" ] && echo "accept" || echo "drop")
        PARTS+=("$NFT_ACTION")

        nft add rule "${PARTS[@]}"
        echo "[ics-firewall] Rule[$i]: ${SRC_ZONE}→${DST_ZONE} proto=${PROTO} port=${PORT} action=${ACTION}${COMMENT:+ # ${COMMENT}}"
    done
else
    echo "[ics-firewall] No ACL rules — default policy (${POLICY}) applies to all traffic."
fi

# Terminal reject: unmatched traffic gets ICMP admin-prohibited (fast response for
# scanners) rather than a silent drop. Explicit deny rules still use 'drop'.
nft add rule inet ics_fw forward reject with icmp type admin-prohibited

echo "[ics-firewall] Reload complete."
nft list chain inet ics_fw forward
