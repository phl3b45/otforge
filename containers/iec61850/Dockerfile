# otforge-iec61850 — IEC 61850 substation IED (MMS server on TCP 102).
#
# IEC 61850 is the dominant protocol for electrical substation automation, used
# across power generation and power distribution. This image runs a real IED
# server built on libiec61850 (the de-facto open-source IEC 61850 stack), serving
# the MMS (Manufacturing Message Specification) client/server protocol on TCP 102.
#
# Scope: MMS only for now. GOOSE and Sampled Values are layer-2 multicast and are
# impractical on Docker bridge networks without extra plumbing — deferred.

# ── Build stage: compile libiec61850 + its example servers ───────────────────
FROM debian:bookworm-slim AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/mz-automation/libiec61850.git
WORKDIR /src/libiec61850
RUN mkdir build && cd build \
    && cmake -DBUILD_EXAMPLES=ON .. \
    && make -j"$(nproc)"
# Surface where the example server binaries landed (aids COPY path below and
# future customization). Non-fatal listing.
RUN find /src/libiec61850/build -type f -perm -111 -name 'server_example*' -print

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
# apt-get upgrade pulls current Debian security patches into the runtime base
# (same hygiene as the zeek image). netcat-openbsd is only for readiness probes.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# server_example_basic_io ships a static IEC 61850 data model (GGIO + analog
# nodes) and serves it over MMS on port 102 — a working IED to start from. A
# later increment swaps in a realistic substation model (MMXU measurements +
# XCBR breaker).
COPY --from=build \
    /src/libiec61850/build/examples/server_example_basic_io/server_example_basic_io \
    /app/iec61850-server
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV DEVICE_ID=ied-1 \
    DEVICE_CATEGORY=iec61850-ied \
    IEC61850_PORT=102

# MMS / IEC 61850 client-server port.
EXPOSE 102

ENTRYPOINT ["/app/entrypoint.sh"]
