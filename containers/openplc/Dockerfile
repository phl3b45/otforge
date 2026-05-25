FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies for OpenPLC Runtime.
# automake   — provides aclocal, required by autoreconf when building MatIEC compiler
# python3-venv — required by install.sh to create the .venv for the Flask web server
# libtool    — needed by MatIEC's autoconf build system
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config bison flex autoconf automake libtool \
    cmake sudo \
    libssl-dev libffi-dev python3 python3-pip python3-venv \
    curl wget sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# OpenPLC Runtime source is pre-downloaded by the CI workflow step
# "Download OpenPLC Runtime source" and placed in openplc-src/ before
# this Docker build runs. That directory is part of the build context
# (containers/openplc/) and is gitignored (never committed).
#
# For local builds, pre-populate it first:
#   mkdir -p containers/openplc/openplc-src
#   curl -fsSL https://github.com/thiagoralves/OpenPLC_v3/archive/refs/heads/master.tar.gz \
#     | tar -xz --strip-components=1 -C containers/openplc/openplc-src
COPY openplc-src/ /opt/openplc/

WORKDIR /opt/openplc

# Run the automated installer (Linux target)
RUN chmod +x install.sh && ./install.sh linux

# Patch monitoring.py — fix two bugs present in the upstream source:
#
#   1. split(' ') on VAR declaration lines: any alignment padding (multiple
#      spaces between the variable name and AT) produces empty tokens that
#      shift subsequent index lookups, giving wrong name/location/type in the
#      Monitoring page.  Fix: use split() with no arg so whitespace runs
#      collapse to a single separator.
#
#   2. Type field parsing: declarations like "pump_run AT %QX0.0 : BOOL"
#      leave tmp[4] = "BOOL" clean, but "BOOL := TRUE;" leaves
#      tmp[4] = "BOOL" (correct — the ":=" shifts to tmp[5]).  However the
#      old code only stripped the trailing semicolon; the extra split(':')[0]
#      + strip() handles any edge-case residue.
#
# Using Python string replace rather than sed to avoid shell-escaping issues
# with brackets and apostrophes in the match strings.
RUN python3 - <<'PYEOF'
p = 'webserver/monitoring.py'
s = open(p).read()
s = s.replace(
    "tmp = line.strip().split(' ')",
    "tmp = line.strip().split()"
)
s = s.replace(
    "debug_data.type = tmp[4].split(';')[0]",
    "debug_data.type = tmp[4].split(';')[0].split(':')[0].strip()"
)
open(p, 'w').write(s)
print('monitoring.py patched OK')
PYEOF

# Expose all protocol ports served by OpenPLC Runtime v3 Linux driver:
#   8080     — OpenPLC web interface (REST API for program upload, status)
#   502/tcp  — Modbus TCP slave
#   44818/tcp — EtherNet/IP explicit messaging (CIP over TCP)
#   2222/udp  — EtherNet/IP implicit messaging (real-time I/O data)
EXPOSE 8080
EXPOSE 502
EXPOSE 44818
EXPOSE 2222/udp

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=plc-1 \
    DEVICE_CATEGORY=plc \
    OPENPLC_PORT=8080 \
    MODBUS_PORT=502 \
    ENIP_PORT=44818 \
    ENIP_SLOT=0

ENTRYPOINT ["/entrypoint.sh"]
