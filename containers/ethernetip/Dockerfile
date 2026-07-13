FROM python:3.12-alpine

WORKDIR /app

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=enip-1 \
    DEVICE_CATEGORY=ethernetip-adapter \
    ENIP_PORT=44818 \
    ENIP_VENDOR_ID=1 \
    ENIP_PRODUCT_NAME="OTForge Remote I/O Adapter"

# EtherNet/IP explicit messaging — standard port.
EXPOSE 44818

ENTRYPOINT ["./entrypoint.sh"]
