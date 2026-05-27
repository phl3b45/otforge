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

# ── VNC server ────────────────────────────────────────────────────────────────
mkdir -p /root/.vnc
echo "" | vncpasswd -f > /root/.vnc/passwd
chmod 600 /root/.vnc/passwd

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
vncserver :1 -geometry 1920x1080 -depth 24 -SecurityTypes None -localhost no \
    2>/dev/null

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
