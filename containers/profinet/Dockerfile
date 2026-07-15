FROM python:3.12-alpine

# iproute2 provides the `ip` binary entrypoint.sh uses to set the container's
# interface into promiscuous mode — required to receive DCP-Identify multicast
# frames (destination MAC 01:0E:CF:00:00:00), which the kernel otherwise drops
# before they reach our raw AF_PACKET socket (same fix already applied to
# containers/zeek for the same underlying reason — see project_zeek_capture_fix).
RUN apk add --no-cache iproute2

WORKDIR /app

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=profinet-1 \
    DEVICE_CATEGORY=profinet-device \
    PROFINET_IFACE=eth0 \
    PROFINET_STATION_NAME=profinet-device-1 \
    PROFINET_VENDOR_ID=42 \
    PROFINET_DEVICE_ID=1

# DCP runs directly over raw Ethernet (EtherType 0x8892) — no TCP/UDP port to expose.

ENTRYPOINT ["./entrypoint.sh"]
