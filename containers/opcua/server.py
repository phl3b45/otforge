#!/usr/bin/env python3
"""
server.py — OPC UA server for the ICS Simulator device container.

Implements an OPC UA 1.04 server using asyncua (opcua-asyncio). The server
exposes a realistic process namespace containing analog and discrete variables
that drift over time so that polling clients see live-looking data.

This container is used by the scada-server device category in OTForge. It
provides students with a browseable OPC UA address space that they can explore
using UA Expert, the asyncua Python client, or OTForge's built-in FUXA HMI.

Node layout (all under ns=<OPCUA_NAMESPACE>):
    Objects/
      Process/
        Temperature      — FLOAT,  25.0 °C  (±2 °C drift)
        Pressure         — FLOAT,  101.3 kPa (±1.5 kPa drift)
        FlowRate         — FLOAT,  15.0 L/min (±3 L/min drift)
        TankLevel        — FLOAT,  500.0 mm  (±10 mm drift)
        PumpRunning      — BOOL,   True
        ValvePosition    — FLOAT,  100.0 % open (±5 % drift)
        EmergencyStop    — BOOL,   False

Environment variables (all have defaults):
    DEVICE_ID        — node identifier string, used in the server display name
    DEVICE_CATEGORY  — logged at startup for Docker Compose traceability
    OPCUA_PORT       — TCP port for the OPC UA binary endpoint (default 4840)
    OPCUA_NAMESPACE  — namespace URI registered with the server (default urn:otforge:ics)

Protocol reference: OPC UA Part 4 (Services), Part 6 (Mappings) — OPC Foundation
asyncua version: 1.1.x (https://github.com/FreeOpcUa/opcua-asyncio)
"""

import asyncio
import logging
import os
import random

from asyncua import Server, ua

# ── Configuration ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-opcua")

DEVICE_ID  = os.getenv("DEVICE_ID", "opcua-1")
CATEGORY   = os.getenv("DEVICE_CATEGORY", "scada-server")
PORT       = int(os.getenv("OPCUA_PORT", "4840"))
NAMESPACE  = os.getenv("OPCUA_NAMESPACE", "urn:otforge:ics")

# ── Initial process values ────────────────────────────────────────────────────

PROCESS_DEFAULTS: dict[str, tuple[object, float, float]] = {
    # variable_name: (initial_value, drift_magnitude, min, max)
    # stored as (initial, half_range) — actual bounds applied in simulate()
    "Temperature":   (25.0,  2.0),
    "Pressure":      (101.3, 1.5),
    "FlowRate":      (15.0,  3.0),
    "TankLevel":     (500.0, 10.0),
    "ValvePosition": (100.0, 5.0),
}

BOOL_DEFAULTS: dict[str, bool] = {
    "PumpRunning":    True,
    "EmergencyStop":  False,
}

# ── Simulation ────────────────────────────────────────────────────────────────

async def simulate(nodes: dict[str, object]) -> None:
    """
    Background task — drifts all analog variables ±magnitude every 2 seconds.

    Boolean variables are left unchanged so that students can see a stable
    True/False value unless they use the OPC UA Write service to change them,
    which demonstrates that OPC UA (unlike older protocols) supports write-back
    by default with no authentication in SecurityMode=None.
    """
    current: dict[str, float] = {name: float(val) for name, (val, _) in PROCESS_DEFAULTS.items()}

    while True:
        await asyncio.sleep(2)
        for name, (_, magnitude) in PROCESS_DEFAULTS.items():
            delta = random.uniform(-magnitude, magnitude)
            current[name] = max(0.0, current[name] + delta)
            node = nodes[name]
            await node.write_value(round(current[name], 2))

# ── Server setup ──────────────────────────────────────────────────────────────

async def main() -> None:
    """
    Start the OPC UA server and register the process namespace.

    Security is intentionally left at SecurityMode=None / SecurityPolicy=None
    so students can connect without certificates. This mirrors the default
    configuration found on many real-world OPC UA deployments and is the
    starting point for the security discussion in Lab_02.
    """
    server = Server()
    await server.init()

    server.set_endpoint(f"opc.tcp://0.0.0.0:{PORT}/otforge/{DEVICE_ID}")
    server.set_server_name(f"OTForge OPC UA — {DEVICE_ID}")

    # Register our namespace; idx is the integer used to address nodes
    idx = await server.register_namespace(NAMESPACE)

    # Build the Objects/Process/ folder
    objects  = server.nodes.objects
    process  = await objects.add_object(idx, "Process")

    # Populate analog (Float) variables
    var_nodes: dict[str, object] = {}
    for name, (initial, _) in PROCESS_DEFAULTS.items():
        node = await process.add_variable(idx, name, float(initial), varianttype=ua.VariantType.Float)
        await node.set_writable()   # allow Write service — intentionally open
        var_nodes[name] = node

    # Populate discrete (Boolean) variables
    for name, initial in BOOL_DEFAULTS.items():
        node = await process.add_variable(idx, name, initial, varianttype=ua.VariantType.Boolean)
        await node.set_writable()
        var_nodes[name] = node

    log.info(
        "OPC UA server ready — endpoint opc.tcp://0.0.0.0:%d  ns=%d (%s)",
        PORT, idx, NAMESPACE,
    )
    log.info(
        "Nodes: %s",
        ", ".join(f"{n}" for n in var_nodes),
    )

    # Start the simulation background task, then run the server forever
    async with server:
        asyncio.create_task(simulate(var_nodes))
        log.info("Simulation running — values drift ±magnitude every 2 s")
        await asyncio.Future()  # run until cancelled


if __name__ == "__main__":
    asyncio.run(main())
