FROM alpine:3.20

RUN apk add --no-cache nftables iproute2 bash jq

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Zone subnet defaults match ZONE_DEFAULTS in packages/orchestrator/src/network-config.ts.
# These are always overridden at runtime by FW_ZONE_* vars injected by the compose
# generator — the Dockerfile defaults are only a fallback for manual container runs.
ENV DEVICE_ID=firewall-1 \
    DEVICE_CATEGORY=firewall \
    FW_DEFAULT_POLICY=drop \
    FW_ZONE_OT=10.200.10.0/24 \
    FW_ZONE_CONTROL=10.200.20.0/24 \
    FW_ZONE_PLANT_DMZ=10.200.30.0/24 \
    FW_ZONE_ENTERPRISE=10.200.40.0/24 \
    FW_ZONE_INTERNET_DMZ=10.200.50.0/24 \
    FW_ZONE_ATTACKER=10.200.60.0/24

ENTRYPOINT ["/entrypoint.sh"]
