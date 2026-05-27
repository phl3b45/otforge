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
Exec=firefox http://hmi:1881
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
Exec=firefox http://grafana:3000
Icon=firefox
Terminal=false
Categories=Network;
EOF
chmod +x /root/Desktop/Grafana.desktop

# ── OT network routing ────────────────────────────────────────────────────────
# The workstation sits on the control network (eth0, e.g. 10.200.20.x/24).
# The firewall is always at .254 on that subnet and has IP forwarding enabled
# with nftables rules that permit Modbus/DNP3/BACnet from control → OT.
# Add a /16 summary route so the protocol scripts can reach PLCs and sensors
# on the OT subnet (10.200.10.x) without any extra configuration.
FW_IP=$(ip -4 addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1 | sed 's/\.[0-9]*$/.254/')
if [ -n "$FW_IP" ]; then
    ip route add 10.200.0.0/16 via "$FW_IP" dev eth0 2>/dev/null || true
    echo "[ics-workstation] OT route added: 10.200.0.0/16 via ${FW_IP}"
fi

# ── VNC server ────────────────────────────────────────────────────────────────
# No password setup needed — vncserver is started with -SecurityTypes None so
# no authentication is required and the passwd file is never read.
mkdir -p /root/.vnc

# xstartup: launch Xfce4 desktop
cat > /root/.vnc/xstartup << 'EOF'
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
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
