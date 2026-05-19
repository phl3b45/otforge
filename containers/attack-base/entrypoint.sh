#!/bin/bash
# entrypoint.sh — Kali attack machine container startup
#
# Startup sequence:
#   1. Print device identity and available tools
#   2. Start TigerVNC server on display :1 (port 5901)
#      TigerVNC automatically runs ~/.config/tigervnc/xstartup, which calls
#      dbus-launch --exit-with-session startxfce4. No separate Xfce4 launch needed.
#   3. Wait for VNC socket + TCP readiness (nc probes) before starting websockify
#   4. Start websockify to bridge noVNC WebSocket (port 6080) → VNC TCP (5901)
#   5. Keep the container alive for docker exec terminal sessions
#
# Port map:
#   5901  — VNC TCP (internal; not published to host)
#   6080  — noVNC WebSocket (published to host via Docker Compose port mapping)
#           Accessible in the Electron Desktop view at http://localhost:<hostPort>/vnc.html

set -e

echo "[otforge-attack] =============================================="
echo "[otforge-attack] Device:   ${DEVICE_ID}"
echo "[otforge-attack] Category: ${DEVICE_CATEGORY}"
echo "[otforge-attack] Zone:     External network (attacker-controlled)"
echo "[otforge-attack] =============================================="
echo ""
echo "[otforge-attack] CLI Tools:     nmap, masscan, netcat, tshark, scapy, pymodbus"
echo "[otforge-attack] Frameworks:    metasploit-framework, armitage"
echo "[otforge-attack] Passwords:     hydra, medusa, john, hashcat"
echo "[otforge-attack] ICS Protocol:  pymodbus, dnp3-python, opcua, bacpypes3, python-snap7"
echo "[otforge-attack] Desktop:       Xfce4 via noVNC at container port 6080"
echo "[otforge-attack]                (Wireshark GUI, Armitage, Firefox available)"
echo ""

# ── Network interface report ──────────────────────────────────────────────────
echo "[otforge-attack] Network interfaces:"
ip addr show
echo ""

# ── Start TigerVNC server ─────────────────────────────────────────────────────
echo "[otforge-attack] Starting TigerVNC server on display :1 (port 5901)..."

# Clean up any stale lock files from a previous unclean shutdown
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# Geometry matches a standard 16:9 monitor — suitable for Wireshark's layout.
# -SecurityTypes None: password-free VNC — safe because port 5901 is not
#   published to the host; VNC is only reachable via websockify on port 6080.
# -localhost yes: bind VNC to 127.0.0.1 only (not all interfaces) so that newer
#   TigerVNC versions do NOT reject the start-up. websockify connects to
#   localhost:5901, so binding to loopback is sufficient. Using -localhost no with
#   -SecurityTypes None causes TigerVNC ≥ 1.14 to refuse with a security error.
vncserver :1 \
    -geometry 1920x1080 \
    -depth 24 \
    -localhost yes \
    -SecurityTypes None \
    -fg &
VNC_PID=$!

# Wait for VNC socket to appear before starting websockify
for i in $(seq 1 15); do
    if [ -S /tmp/.X11-unix/X1 ] || ss -tln | grep -q ':5901'; then
        echo "[otforge-attack] VNC server ready (attempt ${i})"
        break
    fi
    sleep 1
done

# ── Xfce4 is launched via VNC xstartup, not here ─────────────────────────────
# TigerVNC automatically executes ~/.config/tigervnc/xstartup after creating the
# X session. That script runs `dbus-launch --exit-with-session startxfce4`, which
# is the correct single launch path.
#
# We deliberately do NOT start startxfce4 here. A second call would start a second
# Xfce4 instance on the same display — its xfwm4 would fail with "Another Window
# Manager is already running", leaving the desktop without titlebars and resize handles.

# Wait for TigerVNC to actually accept TCP connections on port 5901 before starting
# websockify. The socket-file / port check above confirmed VNC started, but there is
# a brief window where TigerVNC has the socket open but rejects incoming connections
# while it finishes initialising the X session. A TCP connection probe is more
# reliable than a sleep-based heuristic.
echo "[otforge-attack] Waiting for VNC to accept TCP connections on port 5901..."
for i in $(seq 1 20); do
    # Try a TCP connection; nc exits 0 immediately on success, 1 on refused/timeout
    if nc -z -w1 localhost 5901 2>/dev/null; then
        echo "[otforge-attack] VNC accepting connections (attempt ${i})"
        break
    fi
    sleep 1
done

# ── Start noVNC WebSocket bridge ─────────────────────────────────────────────
# websockify translates WebSocket frames from the Electron BrowserWindow (noVNC page)
# into raw VNC TCP frames that TigerVNC understands. The --wrap-mode=ignore flag
# prevents websockify from exiting when the VNC connection drops (e.g. client refresh).
echo "[otforge-attack] Starting noVNC websockify bridge on port 6080..."
websockify \
    --web /opt/novnc/ \
    --wrap-mode=ignore \
    0.0.0.0:6080 \
    localhost:5901 &
NOVNC_PID=$!

# Verify websockify is listening on port 6080 before declaring the container ready.
# Without this check the host-side isPortOpen() probe may succeed while websockify
# is still in its startup phase and the WebSocket handshake fails.
echo "[otforge-attack] Waiting for noVNC websockify to listen on port 6080..."
for i in $(seq 1 15); do
    if nc -z -w1 localhost 6080 2>/dev/null; then
        echo "[otforge-attack] noVNC ready on port 6080 (attempt ${i})"
        break
    fi
    sleep 1
done

echo "[otforge-attack] Desktop ready — connect at container port 6080"
echo "[otforge-attack] VNC: no password required (SecurityTypes None; isolated within Docker network)"
echo ""
echo "[otforge-attack] Waiting for terminal sessions (docker exec)..."

# ── Keep container alive ──────────────────────────────────────────────────────
# The Electron xterm.js terminal attaches via `docker exec -i <name> /bin/bash`.
# The process here just holds the container open; exec sessions are independent.
exec tail -f /dev/null
