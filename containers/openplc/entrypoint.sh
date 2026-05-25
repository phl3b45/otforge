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

# ── Pre-load and compile Structured Text program ──────────────────────────────
#
# If INITIAL_PROGRAM_B64 is set, decode the base64 string to a .st file,
# register it in the OpenPLC database, and COMPILE it to a native binary so
# the runtime executes it immediately on startup.
#
# IMPORTANT: webserver.py does NOT auto-compile from source at startup — it
# only spawns a pre-built binary at webserver/core/openplc. Writing the ST
# file and setting DB flags is not enough; we must invoke compile_program.sh
# here so the binary exists before start_openplc.sh is called.
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

  # ── Compile the ST program to a native binary ──────────────────────────────
  #
  # Mirrors the steps in openplc.py compile_program():
  #   1. Copy core/debug.blank → core/debug.cpp  (required stub; compile_program.sh
  #      links against it and will fail if the file is missing or stale)
  #   2. Call scripts/compile_program.sh <basename>
  #      — iec2c (MatIEC) converts the ST source to ANSI C
  #      — glue_generator binds IEC variable addresses to hardware memory
  #      — GCC links everything into the core/openplc executable
  #
  # scripts/compile_program.sh must be called from /opt/openplc/webserver/
  # because it does its own 'cd scripts' internally to read the openplc_platform
  # and openplc_driver config files. Compilation takes 30–90 s on first run.
  echo "[ics-openplc] Compiling '${PROG_BASENAME}' — MatIEC + GCC (30-90 s)..."
  cd /opt/openplc/webserver
  cp -f core/debug.blank core/debug.cpp
  if bash scripts/compile_program.sh "${PROG_BASENAME}"; then
    echo "[ics-openplc] Compilation succeeded — core/openplc binary ready"
  else
    echo "[ics-openplc] ERROR: Compilation failed — runtime will start without a program"
  fi
  cd /opt/openplc

else
  echo "[ics-openplc] No INITIAL_PROGRAM_B64 set — starting with no program loaded"
fi

# ── Generate mbconfig.cfg ─────────────────────────────────────────────────────
#
# modbus_master.cpp opens mbconfig.cfg at runtime to discover external slave
# devices (OpenPLC acting as Modbus master). When the file is absent it logs:
#   "Skipping configuration of Slave Devices (mbconfig.cfg file not found)"
#
# In our scenario the PLC is a Modbus server only — no outgoing master
# connections. Writing a zero-device config here silences the warning without
# changing behaviour. webserver.py regenerates this file whenever slave devices
# are added or removed via the UI, so this stub is always safe to pre-create.
cat > /opt/openplc/webserver/mbconfig.cfg <<'EOF'
Num_Devices = "0"
Polling_Period = "100"
Timeout = "1000"
EOF
echo "[ics-openplc] mbconfig.cfg → 0 slave devices"

# ── Start OpenPLC Runtime ──────────────────────────────────────────────────────
# start_openplc.sh changes to /opt/openplc/webserver, activates the .venv, and
# launches webserver.py (Flask). On startup webserver.py checks Start_run_mode;
# when true it calls start_runtime() which exec's the pre-compiled binary at
# webserver/core/openplc. That binary serves:
#   - Modbus/TCP slave  on port ${MODBUS_PORT}  (502)
#   - EtherNet/IP CIP   on port ${ENIP_PORT:-44818}
#   - S7comm (snap7)    on port 102
# The binary must already exist (built above) before webserver.py starts.
exec /opt/openplc/start_openplc.sh "$@"
