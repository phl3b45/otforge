FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies for OpenPLC Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config bison flex autoconf \
    libssl-dev libffi-dev python3 python3-pip \
    curl wget sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Clone and build OpenPLC Runtime (shallow clone for speed)
RUN git clone --depth=1 https://github.com/thiagoralves/OpenPLC_Runtime.git openplc

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
