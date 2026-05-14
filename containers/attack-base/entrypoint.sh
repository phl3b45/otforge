#!/bin/bash
# entrypoint.sh — Kali attack machine container startup
#
# Startup sequence:
#   1. Print device identity and available tools
#   2. Start TigerVNC server on display :1 (port 5901)
#   3. Launch Xfce4 desktop session on the VNC display
#   4. Start websockify to bridge noVNC WebSocket (port 6080) → VNC TCP (5901)
#   5. Keep the container alive for docker exec terminal sessions
#
# Port map:
#   5901  — VNC TCP (internal; not published to host)
#   6080  — noVNC WebSocket (published to host via Docker Compose port mapping)
#           Accessible in the Electron Desktop view at http://localhost:<hostPort>/vnc.html

set -e

echo "[ics-attack] =============================================="
echo "[ics-attack] Device:   ${DEVICE_ID}"
echo "[ics-attack] Category: ${DEVICE_CATEGORY}"
echo "[ics-attack] Zone:     External network (attacker-controlled)"
echo "[ics-attack] =============================================="
echo ""
echo "[ics-attack] CLI Tools:     nmap, masscan, netcat, tshark, scapy, pymodbus"
echo "[ics-attack] Frameworks:    metasploit-framework, armitage"
echo "[ics-attack] Passwords:     hydra, medusa, john, hashcat"
echo "[ics-attack] ICS Protocol:  pymodbus, dnp3-python, opcua, bacpypes3, python-snap7"
echo "[ics-attack] Desktop:       Xfce4 via noVNC at container port 6080"
echo "[ics-attack]                (Wireshark GUI, Armitage, Firefox available)"
echo ""

# ── Network interface report ──────────────────────────────────────────────────
echo "[ics-attack] Network interfaces:"
ip addr show
echo ""

# ── Start TigerVNC server ─────────────────────────────────────────────────────
echo "[ics-attack] Starting TigerVNC server on display :1 (port 5901)..."

# Clean up any stale lock files from a previous unclean shutdown
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# Geometry matches a standard 16:9 monitor — suitable for Wireshark's layout
vncserver :1 \
    -geometry 1920x1080 \
    -depth 24 \
    -localhost no \
    -fg &
VNC_PID=$!

# Wait for VNC socket to appear before starting websockify
for i in $(seq 1 15); do
    if [ -S /tmp/.X11-unix/X1 ] || ss -tln | grep -q ':5901'; then
        echo "[ics-attack] VNC server ready (attempt ${i})"
        break
    fi
    sleep 1
done

# ── Launch Xfce4 desktop session ──────────────────────────────────────────────
echo "[ics-attack] Starting Xfce4 desktop session on DISPLAY=:1..."
DISPLAY=:1 dbus-launch --exit-with-session startxfce4 &

# Give Xfce4 a moment to initialize before accepting connections
sleep 3

# ── Start noVNC WebSocket bridge ─────────────────────────────────────────────
# websockify translates the WebSocket frames from noVNC (in the Electron webview)
# into raw VNC TCP frames that TigerVNC understands.
echo "[ics-attack] Starting noVNC websockify bridge on port 6080..."
websockify \
    --web /opt/novnc/ \
    --wrap-mode=ignore \
    0.0.0.0:6080 \
    localhost:5901 &
NOVNC_PID=$!

echo "[ics-attack] Desktop ready — connect at container port 6080"
echo "[ics-attack] VNC password: kali"
echo ""
echo "[ics-attack] Waiting for terminal sessions (docker exec)..."

# ── Keep container alive ──────────────────────────────────────────────────────
# The Electron xterm.js terminal attaches via `docker exec -i <name> /bin/bash`.
# The process here just holds the container open; exec sessions are independent.
exec tail -f /dev/null
