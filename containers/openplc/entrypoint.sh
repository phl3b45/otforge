#!/bin/bash
# containers/openplc/entrypoint.sh — OpenPLC Runtime container startup script.
#
# Environment variables consumed:
#   DEVICE_ID            — Canvas node ID of this PLC device (e.g., "plc-1")
#   DEVICE_CATEGORY      — Always "plc" for this container image
#   OPENPLC_PORT         — TCP port for the OpenPLC web interface (default: 8080)
#   MODBUS_PORT          — TCP port for the Modbus/TCP slave (default: 502)
#   INITIAL_PROGRAM_B64  — (Optional) Base64-encoded IEC 61131-3 Structured Text
#                          source. When set, the program is decoded to a .st file
#                          and uploaded to the OpenPLC runtime at startup so the
#                          PLC begins executing the user's scenario program
#                          immediately. Injected by compose-generator.ts when
#                          the scenario device has a plcProgram defined.
#   PLC_VAR_COUNT        — (Optional) Number of protocol-mapped variables in the
#                          program. Informational — logged at startup.

set -e

echo "[ics-openplc] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  web=${OPENPLC_PORT}  modbus=${MODBUS_PORT}"

cd /opt/openplc

# ── Pre-load Structured Text program ──────────────────────────────────────────
#
# If INITIAL_PROGRAM_B64 is set, decode the base64 string to a .st file and
# copy it into OpenPLC's program upload directory. The OpenPLC Runtime auto-
# compiles and runs the most recently uploaded program on startup when the
# file is placed in the correct location.
#
# The ST file is named after the device ID so it appears correctly in the
# OpenPLC web interface program list for debugging purposes.

if [ -n "${INITIAL_PROGRAM_B64}" ]; then
  PROGRAM_DIR="/opt/openplc/webserver/st_files"
  PROGRAM_FILE="${PROGRAM_DIR}/${DEVICE_ID}.st"

  echo "[ics-openplc] Decoding INITIAL_PROGRAM_B64 → ${PROGRAM_FILE}"
  echo "${INITIAL_PROGRAM_B64}" | base64 -d > "${PROGRAM_FILE}"

  if [ -n "${PLC_VAR_COUNT}" ]; then
    echo "[ics-openplc] Program has ${PLC_VAR_COUNT} variable binding(s)"
  fi

  # Trigger IEC-to-C compilation by writing the program filename into
  # OpenPLC's persistent settings database. The runtime reads this at
  # startup and compiles before beginning PLC scan execution.
  #
  # The settings database is a SQLite file at:
  #   /opt/openplc/webserver/openplc.db
  # The 'Settings' table has a row with Key='Prog_Name' and Value=<filename>.
  PROG_BASENAME="$(basename "${PROGRAM_FILE}")"
  if command -v sqlite3 &>/dev/null; then
    sqlite3 /opt/openplc/webserver/openplc.db \
      "UPDATE Settings SET Value='${PROG_BASENAME}' WHERE Key='Prog_Name';" 2>/dev/null || true
    echo "[ics-openplc] Registered '${PROG_BASENAME}' as active program"
  else
    echo "[ics-openplc] sqlite3 not found — program registered by filename only"
  fi
else
  echo "[ics-openplc] No INITIAL_PROGRAM_B64 set — starting with no program loaded"
fi

# ── Start OpenPLC Runtime ──────────────────────────────────────────────────────
# The `./openplc` binary is the Flask web server that:
#   1. Serves the web UI at port ${OPENPLC_PORT} (8080)
#   2. Manages the IEC-to-C compilation pipeline
#   3. Runs the PLC scan cycle in a background thread
#   4. Provides a Modbus/TCP slave at port ${MODBUS_PORT} (502)
exec ./openplc "$@"
