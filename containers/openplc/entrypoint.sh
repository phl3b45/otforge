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
#   ENIP_PORT            — EtherNet/IP CIP TCP port (default: 44818). OpenPLC
#                          Runtime v3 Linux driver always binds this port; the env
#                          var is logged here and used by the scenario for FUXA/
#                          pycomm3 configuration.
#   ENIP_SLOT            — Backplane slot number for this controller (default: 0).

set -e

echo "[ics-openplc] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  web=${OPENPLC_PORT}  modbus=${MODBUS_PORT}  enip=${ENIP_PORT:-44818}  slot=${ENIP_SLOT:-0}"

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
  PROG_BASENAME="${DEVICE_ID}.st"

  echo "[ics-openplc] Decoding INITIAL_PROGRAM_B64 → ${PROGRAM_FILE}"
  echo "${INITIAL_PROGRAM_B64}" | base64 -d > "${PROGRAM_FILE}"

  if [ -n "${PLC_VAR_COUNT}" ]; then
    echo "[ics-openplc] Program has ${PLC_VAR_COUNT} variable binding(s)"
  fi

  # OpenPLC Runtime v3 uses three mechanisms to auto-start a program:
  #
  #   1. active_program   — plain-text file under webserver/ containing the
  #                         ST filename.  webserver.py reads this at startup
  #                         to look up the program record in the DB.
  #
  #   2. Programs table   — SQLite row with columns (File, Name, Description).
  #                         webserver.py queries this by filename to get the
  #                         human-readable name/description for the UI.
  #
  #   3. Start_run_mode   — Settings row; when 'true', webserver.py calls
  #                         openplc_runtime.start_runtime() automatically
  #                         and the Modbus/TCP + EtherNet/IP servers bind.
  #
  # All three must be set; updating only one is not sufficient.

  DB="/opt/openplc/webserver/openplc.db"

  if command -v sqlite3 &>/dev/null; then
    # Upsert into Programs so webserver.py can look up the project metadata
    sqlite3 "${DB}" \
      "INSERT OR REPLACE INTO Programs (Name, Description, File, Date_upload) \
       VALUES ('${DEVICE_ID}', 'Auto-loaded program for ${DEVICE_ID}', \
               '${PROG_BASENAME}', strftime('%s','now'));" 2>/dev/null || true

    # Set Start_run_mode so the runtime launches automatically at startup
    sqlite3 "${DB}" \
      "UPDATE Settings SET Value='true' WHERE Key='Start_run_mode';" 2>/dev/null || true

    echo "[ics-openplc] Registered '${PROG_BASENAME}' in DB with auto-start enabled"
  else
    echo "[ics-openplc] sqlite3 not found — DB registration skipped"
  fi

  # Update the active_program pointer that webserver.py reads on startup
  echo "${PROG_BASENAME}" > /opt/openplc/webserver/active_program
  echo "[ics-openplc] active_program → ${PROG_BASENAME}"

else
  echo "[ics-openplc] No INITIAL_PROGRAM_B64 set — starting with no program loaded"
fi

# ── Start OpenPLC Runtime ──────────────────────────────────────────────────────
# OpenPLC Runtime v3 starts via start_openplc.sh, which:
#   1. Changes to /opt/openplc/webserver
#   2. Launches webserver.py under the .venv Python interpreter
#   3. webserver.py (Flask) manages IEC-to-C compilation and spawns the
#      compiled PLC scan binary (webserver/core/openplc) as a subprocess
#   4. The core binary serves:
#      - Modbus/TCP slave on port ${MODBUS_PORT} (502)
#      - EtherNet/IP CIP server on port ${ENIP_PORT:-44818}
exec /opt/openplc/start_openplc.sh "$@"
