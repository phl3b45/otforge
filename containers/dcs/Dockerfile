FROM python:3.12-alpine

WORKDIR /app

# pymodbus 3.7.4 — used here as a CLIENT (polling connected field devices), unlike
# containers/modbus's server-only usage. Same version pin for consistency; the
# client-side API has been stable across the 3.x line regardless of the server-side
# datastore changes documented in that container's Dockerfile.
# asyncua (opcua-asyncio) 1.1.x — pure Python OPC UA 1.04 implementation, same as
# containers/opcua. cryptography is required for its built-in certificate/PKI stack
# even when security mode is None.
RUN pip install --no-cache-dir "pymodbus==3.7.4" "asyncua==1.1.5" "cryptography>=42"

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=dcs-1 \
    DEVICE_CATEGORY=dcs-controller \
    OPCUA_PORT=4840 \
    OPCUA_NAMESPACE=urn:otforge:ics \
    DCS_FIELD_DEVICES=""

# OPC UA binary TCP endpoint
EXPOSE 4840

ENTRYPOINT ["./entrypoint.sh"]
