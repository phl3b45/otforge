#!/usr/bin/env python3
"""
server.py — Modbus TCP server + browser-based configuration web UI for the
ICS Simulator RTU/sensor device container.

Two servers run concurrently in the same asyncio event loop:

  Port 502  Modbus TCP server (pymodbus 3.7 async API)
            Exposes coils, discrete inputs, holding registers, and input
            registers. Register values drift over time to simulate live
            field measurements.

  Port 80   HTTP configuration web server (asyncio.start_server)
            Serves a single HTML page showing the device identity,
            communication configuration (injected via env vars from the
            compose generator), and current register values. The page
            auto-refreshes every 5 seconds so students see live data.
            From the engineering workstation VNC, type the RTU IP address
            in Firefox — no port number needed since port 80 is the HTTP default.

Register map:
    HR0  Primary process value (fixed-point x10 where applicable):
           sensor: 250 -> 25.0 C
           pressure-transmitter: 1013 -> 101.3 kPa
           flow-meter: 150 -> 15.0 L/min
           pump: 1 -> running, HR1 = RPM
           valve: 1000 -> 100.0% open
           rtu: 250 -> 25.0 C  (HR1=1013 kPa, HR2=150 L/min -- all drift)
    HR1-HR99  Reserved / secondary values
    IR mirrors HR so both function codes (FC3/FC4) return valid data.

Protocol reference: Modbus Application Protocol v1.1b3
pymodbus version: 3.7+ (asyncio API)
"""
import asyncio
import logging
import os
import random
from datetime import datetime, timezone

from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusServerContext,
    ModbusSlaveContext,
)
from pymodbus.server import StartAsyncTcpServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-modbus")

# ── Configuration from environment (injected by compose-generator.ts) ───────────
DEVICE_ID    = os.getenv("DEVICE_ID", "device-1")
DEVICE_LABEL = os.getenv("DEVICE_LABEL", DEVICE_ID)
CATEGORY     = os.getenv("DEVICE_CATEGORY", "sensor")
PORT         = int(os.getenv("MODBUS_PORT", "502"))
UNIT_ID      = int(os.getenv("MODBUS_UNIT_ID", "1"))

# RTU panel configuration -- displayed on the web configuration page.
# These are only set for rtu/iec104-rtu devices; sensors/actuators leave them empty.
RTU_COMM_TYPE = os.getenv("RTU_COMM_TYPE", "")
RTU_PROTOCOL  = os.getenv("RTU_PROTOCOL", "")
RTU_MODE      = os.getenv("RTU_OPERATING_MODE", "")
RTU_POWER     = os.getenv("RTU_POWER_SOURCE", "")
RTU_SITE      = os.getenv("RTU_SITE_TYPE", "")
RTU_POLL_INT  = os.getenv("RTU_POLL_INTERVAL", "")

WEB_PORT = 80

# ── Initial holding register values per device category ──────────────────────────
# HR0 holds the primary process value. For fixed-point values, divide by 10 to get
# the engineering-unit reading (e.g., HR0=250 -> 25.0 C).
# A full 100-register block is allocated for each device; unused registers are 0.
DEFAULTS: dict[str, list[int]] = {
    "sensor":               [250]  + [0] * 99,          # 25.0 C ambient temperature
    "pressure-transmitter": [1013] + [0] * 99,          # 101.3 kPa (1 atm)
    "flow-meter":           [150]  + [0] * 99,          # 15.0 L/min
    "pump":                 [1, 1500] + [0] * 98,       # HR0=run(1=on), HR1=RPM
    "valve":                [1000] + [0] * 99,          # 100.0% open (fully open)
    "actuator":             [0] * 100,                  # Off/zero by default
    "plc":                  [0] * 100,                  # Cleared (PLC loads its own program)
    # RTU: HR0=Temperature(x10), HR1=Pressure(x10), HR2=FlowRate(x10)
    # All three drift independently to simulate a real remote measurement unit.
    "rtu":                  [250, 1013, 150] + [0] * 97,
}

# ── Simulation drift configuration ───────────────────────────────────────────────
# Each entry maps a device category to a list of (register_index, magnitude) pairs.
# Every pair drifts independently: value += random.uniform(-magnitude, +magnitude)
# each tick. Devices not listed here have static registers (PLCs, infrastructure).
DRIFT: dict[str, list[tuple[int, float]]] = {
    "sensor":               [(0, 3.0)],              # +-0.3 C per tick (x10 -> +-3 units)
    "pressure-transmitter": [(0, 1.5)],              # +-0.15 kPa per tick
    "flow-meter":           [(0, 5.0)],              # +-0.5 L/min per tick
    "pump":                 [(1, 20.0)],             # RPM register drifts +-20 per tick
    # RTU drifts all three measurement registers independently.
    "rtu":                  [(0, 5.0), (1, 3.0), (2, 10.0)],
    #                         HR0 temp +-0.5C  HR1 pressure +-0.3kPa  HR2 flow +-1.0L/min
}

# ── Security notes per comm type (mirrors the RTU panel in the canvas) ───────────
# Displayed on the web config page so students understand the attack surface
# of each communication technology while looking at real device configuration.
SECURITY_NOTES: dict[str, str] = {
    "cellular":     "Cellular-connected RTUs are often internet-exposed when using a public APN "
                    "instead of a private one or VPN tunnel. This is one of the most common "
                    "misconfigurations found in pipeline and power-grid ICS assessments.",
    "radio":        "900 MHz licensed-band and ISM-band radio links transmit frames without "
                    "encryption or authentication by default. An attacker within radio range can "
                    "replay or inject control commands using a software-defined radio (SDR).",
    "satellite":    "Satellite uplinks (VSAT) introduce 500-1500 ms round-trip latency and often "
                    "route outside the corporate security stack, bypassing IDS/SIEM visibility. "
                    "Jamming the uplink is a viable physical denial-of-service technique.",
    "mqtt":         "MQTT brokers are commonly cloud-hosted with shared or hardcoded credentials "
                    "and wildcard topic ACLs. Any subscriber with the broker address can enumerate "
                    "all RTU telemetry topics and inject spoofed sensor readings.",
    "dnp3-serial":  "DNP3 over serial (RS-485/232) to a radio or telephone modem is "
                    "unauthenticated by default -- DNP3 Secure Authentication v5 exists but is "
                    "rarely deployed. Physical access to the serial bus allows frame injection.",
}

# Module-level store reference so the HTTP handler can read live register values.
# Set in main() after the store is created.
_store: ModbusSlaveContext | None = None


def build_store() -> ModbusSlaveContext:
    """
    Creates a pymodbus slave context initialized with category-appropriate register values.

    All four data blocks are allocated (DI, CO, HR, IR):
      - DI (Discrete Inputs, FC2): all zero
      - CO (Coils, FC1): all zero
      - HR (Holding Registers, FC3): initialized from DEFAULTS, category-specific
      - IR (Input Registers, FC4): mirrors HR initial values

    IR is kept in sync with HR by the simulate() task so both FC3 and FC4 reads
    return consistent values, matching real device behavior where holding and input
    registers often reflect the same physical measurement.

    Returns:
        ModbusSlaveContext configured for this device category.
    """
    hr = list(DEFAULTS.get(CATEGORY, [0] * 100))
    return ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [0] * 100),
        co=ModbusSequentialDataBlock(0, [0] * 100),
        hr=ModbusSequentialDataBlock(0, hr),
        ir=ModbusSequentialDataBlock(0, list(hr)),  # IR mirrors HR so FC4 reads are valid
    )


async def simulate(store: ModbusSlaveContext) -> None:
    """
    Background task that drifts one or more process registers every 2 seconds.

    Each drift spec is a (register_index, magnitude) pair from DRIFT[CATEGORY].
    Reads the current HR value, adds a random offset in [-magnitude, +magnitude],
    clamps to [0, 65535] (valid Modbus register range), and writes back to both
    HR (FC3) and IR (FC4) to keep them in sync.

    Function codes in pymodbus 3.x datastore:
        1 = Coil, 2 = Discrete Input, 3 = Holding Register, 4 = Input Register

    Args:
        store: The ModbusSlaveContext created by build_store().
    """
    if CATEGORY not in DRIFT:
        # Infrastructure devices (PLC, firewall, switch) have no drift configured
        return
    drift_specs = DRIFT[CATEGORY]
    for reg, magnitude in drift_specs:
        log.info("Process simulation: register HR%d drifts +/-%.1f per tick", reg, magnitude)
    while True:
        await asyncio.sleep(2)
        for reg, magnitude in drift_specs:
            try:
                # getValues(function_code, start_address, count) -- FC3 = holding registers
                [val] = store.getValues(3, reg, 1)
                new_val = int(val + random.uniform(-magnitude, magnitude))
                # Clamp to unsigned 16-bit range -- Modbus registers are uint16
                new_val = max(0, min(65535, new_val))
                store.setValues(3, reg, [new_val])  # Update HR (FC3)
                store.setValues(4, reg, [new_val])  # Keep IR (FC4) in sync
            except Exception as exc:
                log.warning("Simulation tick error (HR%d): %s", reg, exc)


# ── HTTP configuration web server ─────────────────────────────────────────────────

def _row(label: str, value: str) -> str:
    """Returns one <tr> row for the configuration table."""
    return (
        f'<tr><td class="lbl">{label}</td>'
        f'<td class="val">{value}</td></tr>'
    )


def _badge(text: str, color: str = "blue") -> str:
    """Returns a styled badge span."""
    return f'<span class="badge {color}">{text}</span>'


def build_status_page() -> str:
    """
    Renders the complete RTU configuration HTML page.

    Reads live register values from the module-level _store so each browser
    refresh shows the current Modbus data. The page auto-refreshes every 5 s
    via the <meta http-equiv="refresh"> tag so no JavaScript is required.

    Returns:
        UTF-8 HTML string ready to send as an HTTP response body.
    """
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # Read current register values from the live Modbus datastore
    hr_vals = _store.getValues(3, 0, 10) if _store else [0] * 10
    ir_vals = _store.getValues(4, 0, 10) if _store else [0] * 10
    co_vals = _store.getValues(1, 0, 10) if _store else [0] * 10
    di_vals = _store.getValues(2, 0, 10) if _store else [0] * 10

    # Build register cells for the status table
    def reg_cells(name_prefix: str, values: list[int], count: int = 4) -> str:
        cells = ""
        for i in range(count):
            cells += (
                f'<div class="reg">'
                f'<span class="rname">{name_prefix}{i}</span>'
                f'<span class="rval">{values[i]}</span>'
                f'</div>'
            )
        return cells

    # RTU communication configuration section (only shown when vars are set)
    comm_rows = ""
    if RTU_COMM_TYPE:
        comm_rows += _row("Comm Type", _badge(RTU_COMM_TYPE.upper(), "blue"))
    if RTU_PROTOCOL:
        comm_rows += _row("Protocol", _badge(RTU_PROTOCOL.upper(), "green"))
    if RTU_MODE:
        mode_label = {
            "report-by-exception": "Report by Exception (RBE)",
            "polled": "Polled",
            "hybrid": "Hybrid",
        }.get(RTU_MODE, RTU_MODE)
        comm_rows += _row("Operating Mode", mode_label)
    if RTU_POLL_INT:
        comm_rows += _row("Poll Interval", f"{RTU_POLL_INT} s")
    if RTU_POWER:
        power_label = {
            "solar-battery": "Solar + Battery",
            "ac": "AC Mains",
            "battery": "Battery Only",
            "dc": "DC (24 VDC Instrument)",
        }.get(RTU_POWER, RTU_POWER)
        comm_rows += _row("Power Source", power_label)
    if RTU_SITE:
        comm_rows += _row("Site", RTU_SITE)

    comm_section = ""
    if comm_rows:
        comm_section = f"""
    <div class="card">
      <h2>Communication Configuration</h2>
      <table>{comm_rows}</table>
    </div>"""

    # Security note for the selected comm type
    security_section = ""
    note = SECURITY_NOTES.get(RTU_COMM_TYPE, "")
    if note:
        security_section = f"""
    <div class="card warn">
      <h2>&#9888; Security Note</h2>
      <p>{note}</p>
    </div>"""

    is_rtu = CATEGORY in ("rtu", "iec104-rtu")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="5">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RTU Config &mdash; {DEVICE_ID}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    body {{
      background: #0d1117;
      color: #c9d1d9;
      font-family: 'Courier New', Courier, monospace;
      margin: 0;
      padding: 24px;
      max-width: 960px;
    }}
    header {{
      display: flex;
      align-items: baseline;
      gap: 16px;
      border-bottom: 1px solid #30363d;
      padding-bottom: 12px;
      margin-bottom: 20px;
    }}
    header h1 {{
      color: #58a6ff;
      font-size: 22px;
      margin: 0;
    }}
    header .online {{
      font-size: 12px;
      color: #3fb950;
    }}
    h2 {{
      color: #79c0ff;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 0 0 10px;
    }}
    .card {{
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
    }}
    .card.warn {{
      border-color: #9e6a03;
      background: #161208;
    }}
    .card.warn h2 {{ color: #e3b341; }}
    .card.warn p {{ color: #c9a227; font-size: 13px; line-height: 1.5; margin: 0; }}
    table {{ width: 100%; border-collapse: collapse; }}
    tr {{ border-bottom: 1px solid #21262d; }}
    tr:last-child {{ border-bottom: none; }}
    td {{ padding: 6px 4px; font-size: 13px; }}
    td.lbl {{ color: #8b949e; width: 40%; }}
    td.val {{ color: #e6edf3; }}
    .badge {{
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: bold;
    }}
    .badge.blue {{ background: #1f6feb; color: #fff; }}
    .badge.green {{ background: #238636; color: #fff; }}
    .regs {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }}
    .reg {{
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 6px 12px;
      min-width: 68px;
      text-align: center;
    }}
    .rname {{ font-size: 10px; color: #8b949e; display: block; }}
    .rval  {{ font-size: 16px; color: #7ee787; display: block; }}
    .reg-group-label {{
      font-size: 11px;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin: 12px 0 4px;
    }}
    footer {{
      color: #6e7681;
      font-size: 11px;
      text-align: center;
      margin-top: 20px;
      border-top: 1px solid #21262d;
      padding-top: 10px;
    }}
  </style>
</head>
<body>
  <header>
    <h1>&#x1F4F6; {DEVICE_LABEL or DEVICE_ID}</h1>
    <span class="online">&#x25CF; ONLINE</span>
  </header>

  <div class="card">
    <h2>Device Identity</h2>
    <table>
      {_row("Device ID", DEVICE_ID)}
      {_row("Category", _badge(CATEGORY, "blue"))}
      {_row("Modbus Unit ID", str(UNIT_ID))}
      {_row("Modbus Port", str(PORT))}
    </table>
  </div>

  {comm_section}

  {security_section}

  <div class="card">
    <h2>Register Status</h2>
    <p class="reg-group-label">Holding Registers (FC03) &mdash; read/write</p>
    <div class="regs">{reg_cells("HR", hr_vals)}</div>
    <p class="reg-group-label">Input Registers (FC04) &mdash; read-only measurements</p>
    <div class="regs">{reg_cells("IR", ir_vals)}</div>
    {"" if not is_rtu else f'''
    <p class="reg-group-label">Coils (FC01) &mdash; digital outputs</p>
    <div class="regs">{reg_cells("DO", co_vals)}</div>
    <p class="reg-group-label">Discrete Inputs (FC02) &mdash; read-only digital</p>
    <div class="regs">{reg_cells("DI", di_vals)}</div>'''}
  </div>

  <footer>
    OTForge ICS Simulator &nbsp;&bull;&nbsp;
    Auto-refresh: 5 s &nbsp;&bull;&nbsp;
    {ts}
  </footer>
</body>
</html>"""
    return html


async def http_handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """
    Handles a single incoming HTTP connection.

    Reads the request (just enough to identify method and path), then serves:
      GET /           -> RTU configuration HTML page
      GET /favicon.ico -> 404 (suppressed in browser logs)
      Anything else   -> 404

    Errors are silently swallowed so a malformed request or abrupt disconnect
    never propagates to the asyncio event loop and crashes the Modbus server.

    Args:
        reader: asyncio stream reader for the incoming TCP connection.
        writer: asyncio stream writer for the outgoing TCP response.
    """
    try:
        raw = await asyncio.wait_for(reader.read(4096), timeout=5.0)
        path = b"/"
        if raw.startswith(b"GET "):
            parts = raw.split(b" ")
            if len(parts) >= 2:
                path = parts[1]

        if path == b"/favicon.ico":
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        else:
            html = build_status_page()
            body = html.encode("utf-8")
            header = (
                f"HTTP/1.1 200 OK\r\n"
                f"Content-Type: text/html; charset=utf-8\r\n"
                f"Content-Length: {len(body)}\r\n"
                f"Connection: close\r\n"
                f"\r\n"
            ).encode("utf-8")
            writer.write(header + body)

        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    """
    Entry point: initializes both the Modbus TCP server and the HTTP config server,
    then starts the register simulation task.

    Execution order:
      1. Build the Modbus datastore (register map)
      2. Start the HTTP server on port 80 (background task)
      3. Start the register simulation drift task (background task)
      4. Start the Modbus TCP server on port 502 (blocks until shutdown)

    The HTTP server and simulation task run as asyncio background tasks so they
    share the event loop with the Modbus server without blocking it.
    """
    global _store

    log.info(
        "Device=%s  category=%s  unit=%d  modbus-port=%d  web-port=%d",
        DEVICE_ID, CATEGORY, UNIT_ID, PORT, WEB_PORT,
    )

    _store = build_store()

    # Start HTTP configuration web server
    try:
        web_server = await asyncio.start_server(http_handler, "0.0.0.0", WEB_PORT)
        asyncio.ensure_future(web_server.serve_forever())
        log.info("HTTP config page: http://0.0.0.0:%d/", WEB_PORT)
    except OSError as exc:
        # Port 80 may be in use or disallowed -- warn but continue; Modbus still works.
        log.warning("Could not bind HTTP server on port %d: %s", WEB_PORT, exc)

    # Start register simulation drift task
    asyncio.ensure_future(simulate(_store))

    # Multi-slave Modbus context: {unit_id: slave_context}
    context = ModbusServerContext(slaves={UNIT_ID: _store}, single=False)
    await StartAsyncTcpServer(context, address=("0.0.0.0", PORT))


if __name__ == "__main__":
    asyncio.run(main())
