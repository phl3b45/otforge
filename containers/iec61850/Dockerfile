# otforge-iec61850 — IEC 61850 substation IED (MMS server on TCP 102).
#
# IEC 61850 is the dominant protocol for electrical substation automation, used
# across power generation and power distribution. This image runs a real IED
# server built on libiec61850 (the de-facto open-source IEC 61850 stack), serving
# the MMS (Manufacturing Message Specification) client/server protocol on TCP 102.
#
# Scope: MMS only for now. GOOSE and Sampled Values are layer-2 multicast and are
# impractical on Docker bridge networks without extra plumbing — deferred.

# ── Build stage: compile libiec61850, then our substation IED server ─────────
FROM debian:bookworm-slim AS build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git make gcc g++ build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/mz-automation/libiec61850.git
# Our custom substation IED server + its Makefile, dropped into the library's
# examples tree so it links via libiec61850's own make flags.
COPY server.c /src/libiec61850/examples/otforge-substation/server.c
COPY substation.Makefile /src/libiec61850/examples/otforge-substation/Makefile
WORKDIR /src/libiec61850
# Build the static library (POSIX make build), then our server against it.
RUN make -j"$(nproc)"
WORKDIR /src/libiec61850/examples/otforge-substation
RUN make

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
# apt-get upgrade pulls current Debian security patches into the runtime base
# (same hygiene as the zeek image). netcat-openbsd is only for readiness probes.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Our substation IED: MMXU measurements (live) + a controllable XCBR breaker,
# served over MMS on port 102 (see server.c).
COPY --from=build \
    /src/libiec61850/examples/otforge-substation/iec61850-server \
    /app/iec61850-server
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV DEVICE_ID=ied-1 \
    DEVICE_CATEGORY=iec61850-ied \
    IEC61850_PORT=102

# MMS / IEC 61850 client-server port.
EXPOSE 102

ENTRYPOINT ["/app/entrypoint.sh"]
