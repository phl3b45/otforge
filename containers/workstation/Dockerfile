FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# ── Layer 0: Security baseline — upgrade all base packages ────────────────────
# Ubuntu 22.04 base image packages are frozen at the image publish date.
# Running apt-get upgrade here ensures every subsequent layer starts from a
# fully-patched baseline. Fixes CVE-2026-45447 (OpenSSL heap use-after-free
# in PKCS7_verify, fixed in openssl/libssl 3.0.2-0ubuntu1.25).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 1: Core system + desktop environment ─────────────────────────────────
# Firefox is intentionally NOT installed via `apt install firefox`.
# On Ubuntu 22.04, that package is a snap stub — it tries to exec `snap run firefox`
# at runtime, but snapd is not available inside Docker containers, so every Firefox
# launch silently fails with no error message.
#
# Fix: use Mozilla's own official apt repository (packages.mozilla.org).
# curl downloads the repository signing key directly — no add-apt-repository and
# no gpg-agent dependency, both of which fail in minimal Docker base images.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xfce4 xfce4-terminal xfce4-taskmanager \
    dbus-x11 x11-xserver-utils xdg-utils \
    tigervnc-standalone-server \
    ca-certificates curl \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg \
       -o /etc/apt/keyrings/packages.mozilla.org.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
       > /etc/apt/sources.list.d/mozilla.list \
    && printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' \
       > /etc/apt/preferences.d/mozilla \
    && apt-get update && apt-get install -y --no-install-recommends firefox \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Network and protocol analysis tools ───────────────────────────────
# Wireshark runs as root inside Docker — no setuid/group dance needed.
# nmap includes the ICS NSE scripts (enip-info, modbus-discover, bacnet-info).
RUN apt-get update && apt-get install -y --no-install-recommends \
    wireshark \
    tshark \
    nmap \
    netcat-openbsd \
    iputils-ping \
    iproute2 \
    tcpdump \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 3: Python ICS protocol libraries ────────────────────────────────────
# Same protocol libraries as the attack machine so scripts are portable;
# uses the latest pymodbus (device_id= API, consistent with attack-base).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir \
        pymodbus \
        asyncua \
        bacpypes3 \
        dnp3-python \
        python-snap7

# ── Layer 4: OpenPLC Editor (IEC 61131-3 PLC programming IDE) ─────────────────
#
# The OpenPLC Editor is a wxPython-based desktop IDE for writing PLC programs
# in Ladder Diagram (LD), Function Block Diagram (FBD), Sequential Function
# Chart (SFC), Instruction List (IL), and Structured Text (ST). Students write
# their program here, then upload the saved .st project file to the OpenPLC
# Runtime via its web UI — the Runtime handles compilation, not the editor.
#
# MatIEC (the embedded IEC 61131-3 → ANSI C compiler) is NOT compiled here.
# It is only needed for the editor's internal "Compile" button, which generates
# a C preview. Our student workflow never uses that button — students save in
# the editor, then upload to the Runtime which does its own compilation.
# Skipping the MatIEC build avoids a fragile autotools/g++ chain in Docker.
#
# python3-wxgtk4.0 must come from the Ubuntu apt repo — the pip wxPython wheel
# requires a full GUI build toolchain and fails in headless Docker builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-wxgtk4.0 \
    python3-six \
    python3-lxml \
    python3-dateutil \
    python3-requests \
    python3-future \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 \
       https://github.com/thiagoralves/OpenPLC_Editor.git \
       /opt/openplc-editor \
    && cd /opt/openplc-editor \
    && git submodule update --init --depth 1 editor \
    && EDITOR_PY=$(find /opt/openplc-editor \( -name 'OpenPLC_Editor.py' -o -name 'Beremiz.py' \) | head -1) \
    && test -n "$EDITOR_PY" \
    && chmod +x "$EDITOR_PY" \
    && ln -sf "$EDITOR_PY" /usr/local/bin/openplc-editor

# ── Layer 5: noVNC WebSocket bridge ───────────────────────────────────────────
RUN pip3 install --no-cache-dir websockify \
    && mkdir -p /opt/novnc \
    && curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
       | tar -xz --strip-components=1 -C /opt/novnc

# ── Layer 6: Protocol sample scripts ──────────────────────────────────────────
# Pre-placed on the Desktop so students can run them without typing in noVNC.
COPY scripts/ /root/Desktop/Protocols/
RUN chmod +x /root/Desktop/Protocols/*.py 2>/dev/null || true

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=workstation-1 \
    DEVICE_CATEGORY=engineering-workstation \
    DISPLAY=:1

# noVNC WebSocket bridge — same port as attack-base for consistency
EXPOSE 6080

ENTRYPOINT ["/entrypoint.sh"]
