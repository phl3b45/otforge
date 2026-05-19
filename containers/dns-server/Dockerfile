# containers/dns-server/Dockerfile
#
# Meridian Process Controls — DNS server for the simulated internet zone.
#
# Runs dnsmasq as an authoritative name server for meridian-process.com.
# Placed in the Internet DMZ zone of the ICS Simulator topology so students can:
#   1. Run  dig @<dns-ip> meridian-process.com   to resolve the company domain
#   2. Run  dig @<dns-ip> ANY meridian-process.com  to enumerate all records
#   3. Observe every query logged to stdout (docker logs <container>)
#
# All zone records (A, CNAME-style address entries) are configured via
# environment variables at container start so the same image works for
# any IP addressing scheme the scenario auto-assigns.
#
# Environment variables (with defaults):
#   DNS_DOMAIN      — Authoritative domain  (default: meridian-process.com)
#   WEB_SERVER_IP   — A record for the apex and www  (default: 203.0.113.10)
#   MAIL_SERVER_IP  — A record for mail  (default: <same as WEB_SERVER_IP>)
#   DNS_UPSTREAM    — Upstream resolver  (default: 8.8.8.8; "" = air-gapped)
#
# Image: alpine:3.20 + dnsmasq (~8 MB total)
FROM alpine:3.20

RUN apk add --no-cache dnsmasq

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default zone configuration — overridden at runtime by compose env vars
ENV DNS_DOMAIN=meridian-process.com \
    WEB_SERVER_IP=203.0.113.10 \
    MAIL_SERVER_IP= \
    DNS_UPSTREAM=8.8.8.8

# DNS standard ports — UDP for queries, TCP for responses > 512 bytes
EXPOSE 53/udp
EXPOSE 53/tcp

ENTRYPOINT ["/entrypoint.sh"]
