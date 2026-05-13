FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies for OpenPLC Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config bison flex autoconf \
    libssl-dev libffi-dev python3 python3-pip \
    curl wget sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Prevent git from trying to open an interactive credential prompt.
# Without this, git clone fails in the Docker build context because there is
# no TTY available ("could not read Username: No such device or address").
# The OpenPLC Runtime repository is public, so no credentials are needed —
# this just stops git from attempting to ask for them.
ENV GIT_TERMINAL_PROMPT=0

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
