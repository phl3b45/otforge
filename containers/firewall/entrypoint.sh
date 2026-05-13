#!/bin/bash
set -e

POLICY="${FW_DEFAULT_POLICY:-drop}"

echo "[ics-firewall] Device=${DEVICE_ID}  default-policy=${POLICY}"

# Enable IP forwarding between interfaces (firewall bridges all zones)
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
echo 1 > /proc/sys/net/ipv4/conf/all/forwarding 2>/dev/null || true

# Initialize nftables
nft flush ruleset

nft add table inet ics_fw

# Forward chain — default policy from env
nft add chain inet ics_fw forward "{ type filter hook forward priority 0; policy ${POLICY}; }"

# Allow established/related connections
nft add rule inet ics_fw forward ct state established,related accept

# Allow ICMP (ping) for reachability testing
nft add rule inet ics_fw forward ip protocol icmp accept
nft add rule inet ics_fw forward ip6 nexthdr icmpv6 accept

# OT → IT: allow specific ports if configured
if [ -n "${FW_OT_TO_IT_PORTS}" ]; then
    for port in $(echo "${FW_OT_TO_IT_PORTS}" | tr ',' ' '); do
        nft add rule inet ics_fw forward \
            ip saddr 172.20.10.0/24 ip daddr 172.20.20.0/24 \
            tcp dport "${port}" accept
        echo "[ics-firewall] Allow OT→IT  port=${port}"
    done
fi

# IT → OT: allow specific ports if configured
if [ -n "${FW_IT_TO_OT_PORTS}" ]; then
    for port in $(echo "${FW_IT_TO_OT_PORTS}" | tr ',' ' '); do
        nft add rule inet ics_fw forward \
            ip saddr 172.20.20.0/24 ip daddr 172.20.10.0/24 \
            tcp dport "${port}" accept
        echo "[ics-firewall] Allow IT→OT  port=${port}"
    done
fi

echo "[ics-firewall] nftables ruleset:"
nft list ruleset

# Keep container running
exec tail -f /dev/null
