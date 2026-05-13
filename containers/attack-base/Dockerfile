FROM kalilinux/kali-rolling

ENV DEBIAN_FRONTEND=noninteractive

# Core attack tools — ICS-focused toolkit
# Installing in a single RUN to minimize layers
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Network reconnaissance
    nmap masscan \
    # Packet crafting and analysis
    python3 python3-pip python3-scapy \
    wireshark-common tshark \
    # General exploitation
    metasploit-framework \
    # Utilities
    netcat-traditional curl wget \
    iputils-ping iproute2 \
    net-tools dnsutils \
    git vim \
    && rm -rf /var/lib/apt/lists/*

# ICS-specific Python tools
# pymodbus: Modbus protocol interaction
# mbtget is a separate Perl tool — install via apt if available, else skip
RUN pip3 install --no-cache-dir --break-system-packages \
    pymodbus \
    scapy 2>/dev/null || true

# Initialize Metasploit DB on first run (speeds up startup)
RUN msfdb init 2>/dev/null || true

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=attack-1 \
    DEVICE_CATEGORY=attack-machine

WORKDIR /root

ENTRYPOINT ["/entrypoint.sh"]
