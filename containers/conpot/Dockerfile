FROM python:3.12-alpine

WORKDIR /app

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# ── Environment defaults — all overridable by docker-compose environment ──────
# DEVICE_CATEGORY selects the protocol server to run:
#   legacy-plc  → Siemens S7comm on port 102 (ISO-TSAP / RFC 1006)
#   iec104-rtu  → IEC 60870-5-104 on port 2404
#
# S7_DEVICE_TYPE selects the emulated Siemens CPU model (legacy-plc only).
# Valid values: 300, 400, 1200, 1500
# Affects the order number and firmware version returned by SZL reads —
# Nmap s7-enumerate, Metasploit siemens_simatic_manager, and snap7 tools
# all read these fields to identify the exact CPU type.
#
# IEC104_COMMON_ADDRESS is the ASDU Common Address (2 bytes) that identifies
# this RTU on a multi-drop IEC 104 segment. Each RTU on the same segment must
# have a unique common address; 1 is the default for a single-RTU topology.
ENV DEVICE_ID=device-1 \
    DEVICE_CATEGORY=legacy-plc \
    S7_DEVICE_TYPE=300 \
    S7_PORT=102 \
    IEC104_COMMON_ADDRESS=1 \
    IEC104_PORT=2404

EXPOSE 102 2404

ENTRYPOINT ["./entrypoint.sh"]
