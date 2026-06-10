#!/bin/bash
# containers/influxdb/entrypoint.sh — InfluxDB 1.8 container startup.
#
# Environment variables (match official influxdb:1.8 image conventions):
#   INFLUXDB_DB                 — Database to auto-create on first start
#   INFLUXDB_HTTP_AUTH_ENABLED  — Enable HTTP auth (default: false)
#   INFLUXDB_ADMIN_USER         — Admin username (only used when auth enabled)
#   INFLUXDB_ADMIN_PASSWORD     — Admin password (only used when auth enabled)
set -e

CONFIG=/etc/influxdb/influxdb.conf
DATA_DIR=/var/lib/influxdb

# Write a minimal influxdb.conf on first run
if [ ! -f "${CONFIG}" ]; then
    AUTH_ENABLED="${INFLUXDB_HTTP_AUTH_ENABLED:-false}"
    cat > "${CONFIG}" << EOF
[meta]
  dir = "${DATA_DIR}/meta"

[data]
  dir = "${DATA_DIR}/data"
  wal-dir = "${DATA_DIR}/wal"

[http]
  bind-address = ":8086"
  auth-enabled = ${AUTH_ENABLED}
EOF
fi

# On first start the meta directory does not exist — run init sequence
if [ ! -d "${DATA_DIR}/meta" ]; then
    # Start influxd in the background so we can run setup queries
    influxd -config "${CONFIG}" &
    INFLUXD_PID=$!

    # Wait up to 30 s for the HTTP API to accept connections
    for i in $(seq 1 30); do
        if influx -execute "SHOW DATABASES" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    # Create the scenario database
    if [ -n "${INFLUXDB_DB}" ]; then
        influx -execute "CREATE DATABASE \"${INFLUXDB_DB}\""
        echo "[influxdb] Created database: ${INFLUXDB_DB}"
    fi

    # Create admin user only when auth is enabled
    if [ "${INFLUXDB_HTTP_AUTH_ENABLED}" = "true" ] \
       && [ -n "${INFLUXDB_ADMIN_USER}" ] \
       && [ -n "${INFLUXDB_ADMIN_PASSWORD}" ]; then
        influx -execute \
            "CREATE USER \"${INFLUXDB_ADMIN_USER}\" \
             WITH PASSWORD '${INFLUXDB_ADMIN_PASSWORD}' \
             WITH ALL PRIVILEGES"
        echo "[influxdb] Created admin user: ${INFLUXDB_ADMIN_USER}"
    fi

    # Shut down the init instance; exec replaces this process with a clean one
    kill "${INFLUXD_PID}"
    wait "${INFLUXD_PID}" 2>/dev/null || true
fi

exec influxd -config "${CONFIG}" "$@"
