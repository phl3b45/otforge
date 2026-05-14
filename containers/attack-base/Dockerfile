FROM kalilinux/kali-rolling

# Keep DEBIAN_FRONTEND noninteractive only during build — unset at runtime
ARG DEBIAN_FRONTEND=noninteractive

# ── Layer 1: Core system + desktop environment ─────────────────────────────────
# Xfce4 is the lightest full desktop that pairs well with Kali's tool set.
# tigervnc-standalone-server provides the VNC server; novnc + websockify bridge
# the VNC TCP socket to a WebSocket so the Electron webview can connect directly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Desktop environment
    xfce4 xfce4-terminal xfce4-taskmanager \
    dbus-x11 x11-xserver-utils xdg-utils \
    # VNC + noVNC WebSocket bridge
    tigervnc-standalone-server tigervnc-tools \
    novnc websockify \
    # Fonts and themes needed for a usable Xfce session
    fonts-dejavu-core fonts-noto-color-emoji \
    gtk2-engines-murrine \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Network reconnaissance ───────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    nmap masscan \
    net-tools iproute2 iputils-ping \
    dnsutils traceroute arp-scan \
    netdiscover \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 3: Packet analysis (full GUI + CLI) ──────────────────────────────────
# wireshark pulls in the full GUI; tshark is its CLI sibling.
# Both are required: tshark for scripted capture, Wireshark GUI for visual analysis
# of ICS protocol fields (Modbus, DNP3, EIP, IEC 104) in the Desktop view.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wireshark tshark \
    tcpdump \
    && echo "wireshark-common wireshark-common/install-setuid boolean true" | debconf-set-selections \
    && dpkg-reconfigure -f noninteractive wireshark-common \
    && usermod -aG wireshark root \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 4: Exploitation frameworks ──────────────────────────────────────────
# Armitage (Metasploit GUI) requires metasploit-framework and Java.
# Splitting into its own layer keeps rebuild times manageable since MSF is large.
RUN apt-get update && apt-get install -y --no-install-recommends \
    metasploit-framework \
    armitage \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 5: Password attacks + credential testing ────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    hydra \
    medusa \
    patator \
    john \
    hashcat \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 6: ICS/OT-specific attack tools ─────────────────────────────────────
# python3-impacket: SMB/DCOM attacks on Windows HMI/historian hosts
# ike-scan: IKE/ISAKMP VPN enumeration (common in ICS DMZ)
# python3-construct + python3-crcmod: helpers for custom ICS protocol scripts
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    python3-impacket \
    ike-scan \
    python3-construct python3-crcmod \
    python3-scapy \
    netcat-traditional curl wget \
    git vim nano \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 7: Python ICS protocol libraries ────────────────────────────────────
# Installed with --break-system-packages because Kali uses PEP 668 externally-
# managed Python; these are dev/lab tools, not production packages.
RUN pip3 install --no-cache-dir --break-system-packages \
    pymodbus \
    dnp3-python \
    opcua \
    python-snap7 \
    bacpypes3 \
    scapy 2>/dev/null || pip3 install --no-cache-dir --break-system-packages pymodbus scapy

# ── Layer 8: Metasploit DB initialization ────────────────────────────────────
# Pre-initialize the Metasploit PostgreSQL database so the first msfconsole
# launch inside the container doesn't have to wait for db:init.
RUN msfdb init 2>/dev/null || true

# ── VNC configuration ─────────────────────────────────────────────────────────
# Default VNC password is "kali" — intentionally simple for lab use.
# The VNC server runs on display :1 (port 5901); websockify bridges it to 6080.
RUN mkdir -p /root/.vnc && \
    printf "kali\nkali\nn\n" | vncpasswd && \
    chmod 600 /root/.vnc/passwd

# Xstartup launches Xfce4 when VNC connects
RUN printf '#!/bin/bash\nunset SESSION_MANAGER\nunset DBUS_SESSION_BUS_ADDRESS\nexec startxfce4\n' \
    > /root/.vnc/xstartup && chmod +x /root/.vnc/xstartup

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── Default environment ───────────────────────────────────────────────────────
ENV DEVICE_ID=attack-1 \
    DEVICE_CATEGORY=attack-machine \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISPLAY=:1

# noVNC WebSocket port
EXPOSE 6080

WORKDIR /root

ENTRYPOINT ["/entrypoint.sh"]
