FROM jasonish/suricata:latest

# ICS-specific Suricata rules
COPY ics-rules.rules /etc/suricata/rules/ics-sim.rules

# Main config (our minimal overlay)
COPY suricata.yaml /etc/suricata/ics-sim.yaml

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=suricata-1 \
    SURICATA_IFACE=eth0

ENTRYPOINT ["/entrypoint.sh"]
