FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Build dependencies for OpenPLC Runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    git build-essential pkg-config bison flex autoconf \
    libssl-dev libffi-dev python3 python3-pip \
    curl wget sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Download OpenPLC Runtime source via GitHub's archive endpoint.
# This is more reliable than git clone in CI: GitHub's /archive/HEAD.tar.gz
# endpoint is served by the CDN and succeeds even when git:// or smart-HTTP
# clone connections are blocked or rate-limited by the runner's network policy.
# curl --retry handles transient HTTP 5xx / network errors with back-off.
# --strip-components=1 drops the top-level "OpenPLC_Runtime-<sha>/" directory
# so the source lands directly in /opt/openplc/ without a rename step.
RUN mkdir openplc && \
    curl -fsSL --retry 3 --retry-delay 15 \
        https://github.com/thiagoralves/OpenPLC_Runtime/archive/HEAD.tar.gz \
    | tar -xz --strip-components=1 -C openplc

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
