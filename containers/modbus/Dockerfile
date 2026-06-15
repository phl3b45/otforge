FROM python:3.12-alpine

WORKDIR /app

# pymodbus 3.7.4 pinned — the server-side API (ModbusDeviceContext, ModbusServerContext)
# changed significantly in 3.13 and is deprecated again in favour of SimData/SimDevice
# in v4. Pin here until the v4 migration is done as a dedicated task.
RUN pip install --no-cache-dir "pymodbus==3.7.4"

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=device-1 \
    DEVICE_LABEL="" \
    DEVICE_CATEGORY=sensor \
    MODBUS_MODE=tcp \
    MODBUS_PORT=502 \
    MODBUS_UNIT_ID=1 \
    RTU_COMM_TYPE="" \
    RTU_PROTOCOL="" \
    RTU_OPERATING_MODE="" \
    RTU_POWER_SOURCE="" \
    RTU_SITE_TYPE="" \
    RTU_POLL_INTERVAL=""

# 502 = Modbus TCP  |  80 = HTTP configuration web page
EXPOSE 502 80

ENTRYPOINT ["./entrypoint.sh"]
