FROM alpine:3.20

RUN apk add --no-cache bridge-utils iproute2 tcpdump bash

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=switch-1 \
    DEVICE_CATEGORY=switch

ENTRYPOINT ["/entrypoint.sh"]
