#!/usr/bin/env python3
"""
server.py — Real DCS (Distributed Control System) controller for the ICS Simulator.

Models a real-world DCS (Honeywell Experion, Emerson DeltaV, ABB 800xA style):
polls the field devices wired to it over Modbus TCP, then re-exposes what it
reads as a browseable OPC UA namespace, exactly the "field I/O in, operator/
historian view out" role a real DCS plays. This is the "aggregation and
visibility" layer connectionRules.ts already describes for dcs-controller —
until now the device category existed only as a bare, unconfigured stub.

Scope (read-only upward, deliberately — see containers/dcs/README-less design
note below): this container polls field devices and mirrors their state via
OPC UA. It does NOT write setpoints back down to the field devices yet — that
is a natural follow-up once this read path is proven, not something silently
half-implemented here. Two independent, already-real attack surfaces exist
without it: (1) this OPC UA server itself, unauthenticated by default exactly
like containers/opcua's scada-server, and (2) the field device's own Modbus
server (smart-controller), already directly attackable — this DCS's OPC UA
readout is what would show an analyst the effect of that Modbus attack.

Node layout (all under ns=<OPCUA_NAMESPACE>):
    Objects/
      FieldDevices/
        <nodeId>/
          Coil0        — BOOL,  mirrors the field device's Modbus coil 0 (FC01)
          HoldingReg0  — FLOAT, mirrors the field device's Modbus holding register 0 (FC03)

Environment variables:
    DEVICE_ID          — node identifier string, used in the server display name
    DEVICE_CATEGORY    — logged at startup for Docker Compose traceability
    OPCUA_PORT         — TCP port for the OPC UA binary endpoint (default 4840)
    OPCUA_NAMESPACE    — namespace URI registered with the server (default urn:otforge:ics)
    DCS_FIELD_DEVICES  — comma-separated "nodeId|ip" pairs, one per field device this
                         DCS is wired to on the canvas (compose-generator.ts derives
                         this from canvas edges — see connectionRules.ts's
                         dcs-controller.sensor entry). Empty/unset means the DCS was
                         placed but not wired to anything yet; the server still starts
                         cleanly with an empty namespace.

Protocol references: Modbus Application Protocol Specification (field I/O polling),
OPC UA Part 4 (Services) / Part 6 (Mappings) — same as containers/opcua.
Library versions: pymodbus 3.7.4 (client mode — containers/modbus only uses its
server-side API), asyncua 1.1.x.
"""

import asyncio
import logging
import os

from asyncua import Server, ua
from pymodbus.client import AsyncModbusTcpClient

# ── Configuration ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-dcs")

DEVICE_ID  = os.getenv("DEVICE_ID", "dcs-1")
CATEGORY   = os.getenv("DEVICE_CATEGORY", "dcs-controller")
PORT       = int(os.getenv("OPCUA_PORT", "4840"))
NAMESPACE  = os.getenv("OPCUA_NAMESPACE", "urn:otforge:ics")

MODBUS_PORT = 502
# Field devices in this simulator are seeded at Modbus unit id 1 by default
# (see e.g. compose-generator.ts's MODBUS_UNIT_ID default) — this DCS polls
# that default unit id. A field device configured with a non-default unit id
# will simply time out and be logged as unreachable, same as any other polling
# error; making the unit id itself configurable per field device is a
# reasonable follow-up if that assumption ever stops holding.
FIELD_DEVICE_UNIT_ID = 1

POLL_INTERVAL_SECONDS = 2
# Generous but bounded — a stalled connect() must not stall polling every
# other field device behind it.
POLL_TIMEOUT_SECONDS = 3


def parse_field_devices(raw: str) -> list[tuple[str, str]]:
    """
    Parses DCS_FIELD_DEVICES ("nodeId|ip,nodeId|ip,...") into a list of
    (nodeId, ip) tuples. Malformed entries are logged and skipped rather than
    raising — one bad entry must not take down the whole DCS.
    """
    devices: list[tuple[str, str]] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split("|")
        if len(parts) != 2:
            log.warning("Skipping malformed DCS_FIELD_DEVICES entry: %r", entry)
            continue
        node_id, ip = parts[0].strip(), parts[1].strip()
        if node_id and ip:
            devices.append((node_id, ip))
    return devices


# ── Modbus polling ────────────────────────────────────────────────────────────

async def poll_field_device(node_id: str, ip: str) -> tuple[bool | None, float | None]:
    """
    Opens a fresh Modbus TCP client connection to one field device, reads
    Coil 0 (FC01) and Holding Register 0 (FC03), then closes the connection.

    Reconnecting every poll cycle (rather than holding a persistent client
    per field device) trades a little efficiency for much simpler, more
    robust recovery: a field device that's mid-restart, not up yet, or
    briefly unreachable just produces one skipped poll, not a client left in
    a broken state that needs its own reconnect logic.

    Returns (coil0, holding_reg0) — either element is None if that specific
    read failed or the device was unreachable at all (both None in that case).
    """
    client = AsyncModbusTcpClient(ip, port=MODBUS_PORT, timeout=POLL_TIMEOUT_SECONDS)
    coil0: bool | None = None
    hr0: float | None = None
    try:
        await client.connect()
        if not client.connected:
            log.warning("%s (%s): connection failed", node_id, ip)
            return None, None

        coil_result = await client.read_coils(0, count=1, slave=FIELD_DEVICE_UNIT_ID)
        if not coil_result.isError():
            coil0 = bool(coil_result.bits[0])

        hr_result = await client.read_holding_registers(0, count=1, slave=FIELD_DEVICE_UNIT_ID)
        if not hr_result.isError():
            hr0 = float(hr_result.registers[0])
    except Exception as exc:  # noqa: BLE001 — one field device's failure must not crash the poll loop
        log.warning("%s (%s): poll error — %s", node_id, ip, exc)
    finally:
        client.close()

    return coil0, hr0


async def poll_loop(field_devices: list[tuple[str, str]], opcua_nodes: dict[str, dict[str, object]]) -> None:
    """
    Background task — polls every field device every POLL_INTERVAL_SECONDS.

    Each field device's poll+write is wrapped in its own try/except so one
    device's failure (a bad write, a dropped connection mid-cycle, anything
    unexpected) can't silently kill polling for every other device forever —
    this task is a fire-and-forget asyncio.create_task() with no supervisor,
    so an uncaught exception here would end the loop permanently with only an
    "exception was never retrieved" warning as evidence.
    """
    if not field_devices:
        log.info("No field devices configured — DCS namespace will stay empty until wired to something.")
        return

    while True:
        for node_id, ip in field_devices:
            try:
                coil0, hr0 = await poll_field_device(node_id, ip)
                nodes = opcua_nodes[node_id]
                if coil0 is not None:
                    await nodes["coil0"].write_value(ua.Variant(coil0, ua.VariantType.Boolean))
                if hr0 is not None:
                    # Explicit Variant typing required — a bare Python float writes as
                    # Double (type 11), which asyncua rejects with BadTypeMismatch
                    # against a node created with varianttype=ua.VariantType.Float
                    # (type 10). Confirmed live: an unwrapped write here crashed this
                    # entire background task on the very first poll cycle.
                    await nodes["holding_reg0"].write_value(ua.Variant(hr0, ua.VariantType.Float))
            except Exception as exc:  # noqa: BLE001 — one field device's OPC UA write failing must not end polling for the rest
                log.warning("%s: OPC UA write error — %s", node_id, exc)
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


# ── Server setup ──────────────────────────────────────────────────────────────

async def main() -> None:
    """
    Start the OPC UA server, register one object per configured field device,
    then run the Modbus poll loop forever alongside it.

    Security is intentionally left at SecurityMode=None / SecurityPolicy=None,
    same as containers/opcua — mirrors the common real-world default and is
    the actual attack surface this device is meant to teach.
    """
    field_devices = parse_field_devices(os.getenv("DCS_FIELD_DEVICES", ""))
    log.info(
        "Field devices wired to this DCS: %s",
        ", ".join(f"{n}@{ip}" for n, ip in field_devices) or "(none)",
    )

    server = Server()
    await server.init()

    server.set_endpoint(f"opc.tcp://0.0.0.0:{PORT}/otforge/{DEVICE_ID}")
    server.set_server_name(f"OTForge DCS Controller — {DEVICE_ID}")

    idx = await server.register_namespace(NAMESPACE)

    objects = server.nodes.objects
    field_devices_folder = await objects.add_object(idx, "FieldDevices")

    # Build one Coil0/HoldingReg0 node pair per field device. Read-only (no
    # set_writable()) — this DCS only mirrors what it polls in this pass, see
    # the module docstring for why write-down is deferred rather than faked.
    opcua_nodes: dict[str, dict[str, object]] = {}
    for node_id, _ip in field_devices:
        device_folder = await field_devices_folder.add_object(idx, node_id)
        coil_node = await device_folder.add_variable(idx, "Coil0", False, varianttype=ua.VariantType.Boolean)
        hr_node = await device_folder.add_variable(idx, "HoldingReg0", 0.0, varianttype=ua.VariantType.Float)
        opcua_nodes[node_id] = {"coil0": coil_node, "holding_reg0": hr_node}

    log.info(
        "OPC UA server ready — endpoint opc.tcp://0.0.0.0:%d  ns=%d (%s)",
        PORT, idx, NAMESPACE,
    )

    async with server:
        asyncio.create_task(poll_loop(field_devices, opcua_nodes))
        log.info("Poll loop running — field devices refreshed every %ds", POLL_INTERVAL_SECONDS)
        await asyncio.Future()  # run until cancelled


if __name__ == "__main__":
    asyncio.run(main())
