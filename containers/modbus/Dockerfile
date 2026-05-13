FROM python:3.12-alpine

WORKDIR /app

# pymodbus 3.7 is pure Python — no C compilation needed on Alpine
RUN pip install --no-cache-dir "pymodbus==3.7.4"

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=device-1 \
    DEVICE_CATEGORY=sensor \
    MODBUS_MODE=tcp \
    MODBUS_PORT=502 \
    MODBUS_UNIT_ID=1

EXPOSE 502

ENTRYPOINT ["./entrypoint.sh"]
