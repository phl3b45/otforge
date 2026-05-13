FROM alpine:3.20

RUN apk add --no-cache iproute2 iptables ip6tables bash

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=router-1 \
    DEVICE_CATEGORY=router

ENTRYPOINT ["/entrypoint.sh"]
