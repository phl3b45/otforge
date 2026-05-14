FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies for OpenPLC Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config bison flex autoconf \
    libssl-dev libffi-dev python3 python3-pip \
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

# Expose the web interface port and Modbus slave port
EXPOSE 8080
EXPOSE 502

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=plc-1 \
    DEVICE_CATEGORY=plc \
    OPENPLC_PORT=8080 \
    MODBUS_PORT=502

ENTRYPOINT ["/entrypoint.sh"]
