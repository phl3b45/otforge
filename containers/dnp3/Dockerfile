FROM python:3.12-alpine

WORKDIR /app

COPY outstation.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Pure-Python DNP3 outstation — no external libraries required
ENV DEVICE_ID=ied-1 \
    DEVICE_CATEGORY=ied \
    DNP3_PORT=20000 \
    DNP3_OUTSTATION_ADDRESS=10 \
    DNP3_MASTER_ADDRESS=1

EXPOSE 20000

ENTRYPOINT ["./entrypoint.sh"]
