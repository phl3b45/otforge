#!/usr/bin/env python3
"""
server.py — BACnet/IP device server for the ICS Simulator container.

Implements a BACnet/IP device using bacpypes3 (v0.0.106+). The device
exposes a set of Analog Input and Binary Input objects representing a
generic ICS field device — temperature sensor, pressure transmitter,
flow meter, pump status, valve status.

This container is used by the sensor device category in OTForge and
provides students with a live BACnet/IP target for Lab_02 protocol
survey exercises. All objects respond to:
  - Who-Is / I-Am broadcast discovery
  - ReadProperty (single object/property)
  - ReadPropertyMultiple (bulk read, FUXA integration)
  - SubscribeCOV (change-of-value notifications)

Object layout:
    Device Object   — instance BACNET_DEVICE_INSTANCE, vendor OTForge
    Analog Input 1  — Temperature     (°C,  drifts ±2)
    Analog Input 2  — Pressure        (kPa, drifts ±1.5)
    Analog Input 3  — FlowRate        (L/min, drifts ±3)
    Analog Input 4  — TankLevel       (mm,  drifts ±10)
    Binary Input 1  — PumpRunning     (active / inactive)
    Binary Input 2  — ValveOpen       (active / inactive)

Environment variables (all have defaults):
    DEVICE_ID              — string label used in logging
    DEVICE_CATEGORY        — device category from OTForge compose generator
    BACNET_DEVICE_INSTANCE — BACnet device instance number (0–4194302)
    BACNET_PORT            — UDP port (default 47808)
    BACNET_VENDOR_ID       — numeric vendor identifier
    BACNET_VENDOR_NAME     — vendor name string
    BACNET_MODEL_NAME      — model name string

Protocol reference: ASHRAE 135-2020 (BACnet)
bacpypes3 version: 0.0.106+ (https://github.com/JoelBender/BACpypes3)
"""

import asyncio
import logging
import os
import random
import socket

from bacpypes3.basetypes import EngineeringUnits, Polarity
from bacpypes3.ipv4.app import NormalApplication
from bacpypes3.local.analog import AnalogInputObject
from bacpypes3.local.binary import BinaryInputObject
from bacpypes3.local.device import DeviceObject
from bacpypes3.primitivedata import CharacterString, Real

# ── Configuration ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-bacnet")

DEVICE_ID       = os.getenv("DEVICE_ID", "bacnet-1")
CATEGORY        = os.getenv("DEVICE_CATEGORY", "sensor")
DEVICE_INSTANCE = int(os.getenv("BACNET_DEVICE_INSTANCE", "1001"))
PORT            = int(os.getenv("BACNET_PORT", "47808"))
VENDOR_ID       = int(os.getenv("BACNET_VENDOR_ID", "999"))
VENDOR_NAME     = os.getenv("BACNET_VENDOR_NAME", "OTForge")
MODEL_NAME      = os.getenv("BACNET_MODEL_NAME", "ICS-SIM")

# ── Process variable definitions ──────────────────────────────────────────────

# (initial_value, drift_magnitude, engineering_unit)
ANALOG_OBJECTS: list[tuple[int, str, float, float, str]] = [
    # (instance, name, initial, drift, unit)
    (1, "Temperature",  25.0,  2.0,  "degreesCelsius"),
    (2, "Pressure",     101.3, 1.5,  "kilopascals"),
    (3, "FlowRate",     15.0,  3.0,  "litersPerHour"),
    (4, "TankLevel",    500.0, 10.0, "millimeters"),
]

BINARY_OBJECTS: list[tuple[int, str, str]] = [
    # (instance, name, initial_value)  — 'active' = True, 'inactive' = False
    (1, "PumpRunning", "active"),
    (2, "ValveOpen",   "active"),
]

# ── Simulation ────────────────────────────────────────────────────────────────

async def simulate(analog_nodes: dict[int, AnalogInputObject]) -> None:
    """
    Drifts all analog present-value properties ±magnitude every 2 seconds.

    Binary inputs are left at their initial state — students can observe that
    BACnet supports COV (change-of-value) subscriptions, which fire when the
    value crosses the COV increment threshold.
    """
    current: dict[int, float] = {
        inst: init for inst, _, init, _, _ in ANALOG_OBJECTS
    }
    drift: dict[int, float] = {
        inst: mag for inst, _, _, mag, _ in ANALOG_OBJECTS
    }

    while True:
        await asyncio.sleep(2)
        for inst, node in analog_nodes.items():
            magnitude = drift[inst]
            current[inst] = max(0.0, current[inst] + random.uniform(-magnitude, magnitude))
            node.presentValue = Real(round(current[inst], 2))

# ── Local IP discovery ────────────────────────────────────────────────────────

def local_ip() -> str:
    """
    Returns the container's primary IPv4 address by opening a UDP socket
    toward a non-routable destination (no packet is actually sent).
    This is the most reliable way to find the Docker-assigned address without
    parsing /proc/net or requiring iproute2 on Alpine.
    """
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "0.0.0.0"

# ── Server setup ──────────────────────────────────────────────────────────────

async def main() -> None:
    """
    Initialise the BACnet/IP device and start serving.

    The NormalApplication binds to the container's primary interface on
    BACNET_PORT (default 47808/UDP). Who-Is broadcasts from other devices
    on the same Docker network will receive an I-Am response, making this
    device discoverable by FUXA and student tools (bacnet-discover, etc.)
    """
    ip = local_ip()
    address = f"{ip}:{PORT}"

    log.info(
        "BACnet/IP device starting — id=%s  instance=%d  address=%s",
        DEVICE_ID, DEVICE_INSTANCE, address,
    )

    # ── Device Object (required by BACnet spec) ────────────────────────────────
    device = DeviceObject(
        objectIdentifier=f"device,{DEVICE_INSTANCE}",
        objectName=CharacterString(DEVICE_ID),
        description=CharacterString(f"OTForge ICS simulator — {CATEGORY}"),
        vendorIdentifier=VENDOR_ID,
        vendorName=CharacterString(VENDOR_NAME),
        modelName=CharacterString(MODEL_NAME),
        firmwareRevision=CharacterString("1.0"),
        applicationSoftwareVersion=CharacterString("1.0"),
        maxApduLengthAccepted=1024,
        segmentationSupported="noSegmentation",
    )

    # ── Analog Input objects ───────────────────────────────────────────────────
    analog_nodes: dict[int, AnalogInputObject] = {}
    for inst, name, initial, _, unit in ANALOG_OBJECTS:
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{inst}",
            objectName=CharacterString(name),
            presentValue=Real(float(initial)),
            units=EngineeringUnits(unit),
            description=CharacterString(f"{name} — OTForge process simulation"),
        )
        analog_nodes[inst] = obj

    # ── Binary Input objects ───────────────────────────────────────────────────
    binary_nodes: list[BinaryInputObject] = []
    for inst, name, initial in BINARY_OBJECTS:
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{inst}",
            objectName=CharacterString(name),
            presentValue=initial,
            polarity=Polarity("normal"),
            description=CharacterString(f"{name} — OTForge process simulation"),
        )
        binary_nodes.append(obj)

    # ── Start the application ──────────────────────────────────────────────────
    app = NormalApplication(device, address)

    # Register all objects with the application so they appear in the address space
    for obj in analog_nodes.values():
        app.add_object(obj)
    for obj in binary_nodes:
        app.add_object(obj)

    log.info(
        "Device ready — %d analog inputs, %d binary inputs",
        len(analog_nodes), len(binary_nodes),
    )
    log.info(
        "Analog: %s",
        ", ".join(f"AI:{i} {n}" for i, n, *_ in ANALOG_OBJECTS),
    )
    log.info(
        "Binary: %s",
        ", ".join(f"BI:{i} {n}" for i, n, _ in BINARY_OBJECTS),
    )

    # Run simulation and server concurrently
    asyncio.create_task(simulate(analog_nodes))
    await asyncio.Future()  # run until cancelled


if __name__ == "__main__":
    asyncio.run(main())
