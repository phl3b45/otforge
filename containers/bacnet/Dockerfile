FROM python:3.12-alpine

WORKDIR /app

# bacpypes3 0.0.106 — pure Python BACnet/IP stack, no C dependencies
RUN pip install --no-cache-dir bacpypes3

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=bacnet-1 \
    DEVICE_CATEGORY=sensor \
    BACNET_DEVICE_INSTANCE=1001 \
    BACNET_PORT=47808 \
    BACNET_VENDOR_ID=999 \
    BACNET_VENDOR_NAME="OTForge" \
    BACNET_MODEL_NAME="ICS-SIM"

# BACnet/IP uses UDP; broadcast-based discovery also requires the port open
EXPOSE 47808/udp

ENTRYPOINT ["./entrypoint.sh"]
