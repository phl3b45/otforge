FROM zeek/zeek:latest

# ICS protocol monitoring script
COPY ics-monitor.zeek /usr/local/zeek/share/zeek/site/ics-monitor.zeek

# Load our script from the site policy
RUN echo "@load ics-monitor" >> /usr/local/zeek/share/zeek/site/local.zeek

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=zeek-1 \
    ZEEK_IFACE=eth0

ENTRYPOINT ["/entrypoint.sh"]
