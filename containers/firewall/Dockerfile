FROM alpine:3.20

RUN apk add --no-cache nftables iproute2 bash

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=firewall-1 \
    DEVICE_CATEGORY=firewall \
    # Default policy: deny cross-zone traffic not explicitly allowed
    FW_DEFAULT_POLICY=drop \
    # Comma-separated list of allowed OT→IT ports (e.g. "502,20000")
    FW_OT_TO_IT_PORTS="" \
    FW_IT_TO_OT_PORTS=""

ENTRYPOINT ["/entrypoint.sh"]
