FROM python:3.12-alpine

WORKDIR /app

# asyncua (opcua-asyncio) 1.1.x — pure Python OPC UA 1.04 implementation.
# cryptography is required for the built-in certificate/PKI stack even when
# security mode is None; without it asyncua raises an ImportError on startup.
RUN pip install --no-cache-dir "asyncua==1.1.5" "cryptography>=42"

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=opcua-1 \
    DEVICE_CATEGORY=scada-server \
    OPCUA_PORT=4840 \
    OPCUA_NAMESPACE=urn:otforge:ics

# OPC UA binary TCP endpoint
EXPOSE 4840

ENTRYPOINT ["./entrypoint.sh"]
