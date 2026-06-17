#!/bin/bash
set -e

echo "[ics-workstation] ============================================="
echo "[ics-workstation] Device:   ${DEVICE_ID}"
echo "[ics-workstation] Category: ${DEVICE_CATEGORY}"
echo "[ics-workstation] ============================================="
echo "[ics-workstation] Tools:    Wireshark, tshark, nmap, tcpdump"
echo "[ics-workstation] Protocols: pymodbus, asyncua, bacpypes3, dnp3-python, python-snap7"
echo "[ics-workstation] Desktop:   Xfce4 via noVNC at container port 6080"

# ── FUXA browser shortcut ──────────────────────────────────────────────────────
# Create a .desktop launcher so students can open the FUXA HMI with one click.
# The hmi service is always reachable at port 1881 on the control-net.
mkdir -p /root/Desktop
cat > /root/Desktop/FUXA-HMI.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=FUXA HMI
Comment=Open the FUXA process HMI
Exec=firefox --new-window http://fuxa:1881
Icon=firefox
Terminal=false
Categories=Network;
EOF
chmod +x /root/Desktop/FUXA-HMI.desktop

# Grafana shortcut
cat > /root/Desktop/Grafana.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Grafana Dashboards
Comment=Open ICS monitoring dashboards
Exec=firefox --new-window http://grafana:3000
Icon=firefox
Terminal=false
Categories=Network;
EOF
chmod +x /root/Desktop/Grafana.desktop

# ── OpenPLC Editor shortcut ───────────────────────────────────────────────────
# Launches the IEC 61131-3 desktop IDE so students can write Ladder Diagram,
# Function Block Diagram, or Structured Text programs. After writing a program,
# students export the .st file and upload it via the OpenPLC Runtime web UI
# (use the "OpenPLC: <device>" shortcut below to open that interface).
cat > /root/Desktop/OpenPLC-Editor.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=OpenPLC Editor
Comment=Write IEC 61131-3 PLC programs (LD, FBD, ST, SFC, IL)
Exec=bash -c "cd /opt/openplc-editor && python3 OpenPLC_Editor.py"
Icon=applications-development
Terminal=false
Categories=Development;
EOF
chmod +x /root/Desktop/OpenPLC-Editor.desktop
echo "[ics-workstation] Shortcut: OpenPLC Editor → /opt/openplc-editor"

# ── Dynamic shortcuts for PLC OpenPLC web IDEs ───────────────────────────────
# WS_PLC_WEBUIS is injected by the compose generator as a comma-separated list
# of "label|url" pairs, e.g.:
#   plc-main|http://10.200.10.10:8080,plc-backup|http://10.200.10.11:8080
# Each entry gets its own .desktop launcher so students can open the OpenPLC
# IDE (ladder logic, monitoring page, ST source) with one click.
if [ -n "${WS_PLC_WEBUIS:-}" ]; then
    IFS=',' read -ra _plc_entries <<< "$WS_PLC_WEBUIS"
    for _entry in "${_plc_entries[@]}"; do
        _label="${_entry%%|*}"
        _url="${_entry#*|}"
        _desktop="/root/Desktop/OpenPLC-${_label}.desktop"
        cat > "$_desktop" << DESKTOPEOF
[Desktop Entry]
Version=1.0
Type=Application
Name=OpenPLC: ${_label}
Comment=Open the OpenPLC IDE for ${_label}
Exec=firefox --new-window ${_url}
Icon=firefox
Terminal=false
Categories=Development;
DESKTOPEOF
        chmod +x "$_desktop"
        echo "[ics-workstation] Shortcut: OpenPLC: ${_label} → ${_url}"
    done
fi

# ── OT network routing ────────────────────────────────────────────────────────
# The workstation sits on the control network (eth0, e.g. 10.200.20.x/24).
# The firewall is always at .254 on that subnet and has IP forwarding enabled
# with nftables rules that permit Modbus/DNP3/BACnet from control → OT.
# Add a /16 summary route so the protocol scripts can reach PLCs and sensors
# on the OT subnet (10.200.10.x) without any extra configuration.
# monitoring-net is always 10.200.70.0/24 — skip it and find the control-net
# interface so the route goes through the firewall at .254, not the monitoring gateway.
for iface in eth0 eth1 eth2 eth3; do
    ip link show "$iface" > /dev/null 2>&1 || continue
    addr=$(ip -4 addr show "$iface" | awk '/inet / {print $2}' | cut -d/ -f1)
    [ -z "$addr" ] && continue
    echo "$addr" | grep -q "^10\.200\.70\." && continue
    FW_IP=$(echo "$addr" | sed 's/\.[0-9]*$/.254/')
    ip route add 10.200.0.0/16 via "$FW_IP" dev "$iface" 2>/dev/null && \
        echo "[ics-workstation] OT route added: 10.200.0.0/16 via ${FW_IP} (${iface})" || true
    break
done

# ── VNC server ────────────────────────────────────────────────────────────────
# No password setup needed — vncserver is started with -SecurityTypes None so
# no authentication is required and the passwd file is never read.
mkdir -p /root/.vnc

# xstartup: launch Xfce4 desktop with a dbus session.
# Two important changes vs the naive approach:
#   1. dbus-launch --exit-with-session: starts a private dbus-daemon, exports
#      DBUS_SESSION_BUS_ADDRESS so all child processes (including Firefox) can
#      connect to it, and shuts the daemon down when xfce4 exits.
#      Without this, Firefox cannot contact dbus and fails silently.
#   2. Stale lock-file cleanup: Docker kills containers without giving Firefox
#      a chance to remove its profile lock.  The lock persists across container
#      restarts and prevents Firefox from opening ("already running" dialog).
cat > /root/.vnc/xstartup << 'EOF'
#!/bin/bash
unset SESSION_MANAGER
rm -f /root/.mozilla/firefox/*/lock \
      /root/.mozilla/firefox/*/parent.lock 2>/dev/null || true
exec dbus-launch --exit-with-session startxfce4
EOF
chmod +x /root/.vnc/xstartup

# Start TigerVNC on display :1 (port 5901), 1920x1080
echo "[ics-workstation] Starting VNC server on display :1 (port 5901)..."
vncserver :1 -geometry 1920x1080 -depth 24 -SecurityTypes None -localhost yes

# Wait for VNC to accept connections
for i in $(seq 1 15); do
    if nc -z localhost 5901 2>/dev/null; then
        echo "[ics-workstation] VNC accepting connections (attempt ${i})"
        break
    fi
    sleep 1
done

# ── noVNC WebSocket bridge ────────────────────────────────────────────────────
echo "[ics-workstation] Starting noVNC websockify bridge on port 6080..."
websockify --web /opt/novnc 6080 localhost:5901 &

for i in $(seq 1 10); do
    if nc -z localhost 6080 2>/dev/null; then
        echo "[ics-workstation] noVNC ready on port 6080 (attempt ${i})"
        break
    fi
    sleep 1
done

echo "[ics-workstation] Desktop ready — connect at container port 6080"
echo "[ics-workstation] Protocol scripts: ~/Desktop/Protocols/"
echo "[ics-workstation] FUXA HMI shortcut on Desktop"

# Keep container alive
wait
