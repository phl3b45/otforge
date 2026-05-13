#!/usr/bin/env python3
"""
server.py — Modbus TCP server for the ICS Simulator device container.

Implements a pymodbus 3.7 asynchronous Modbus TCP server that simulates
holding registers (HR) and input registers (IR) for a wide variety of
field device categories. The server is configured entirely via environment
variables injected by the Docker Compose generator (compose-generator.ts).

Register map:
    HR0  — Primary process value (fixed-point ×10 where applicable):
              sensor: 250 → 25.0 °C
              pressure-transmitter: 1013 → 101.3 kPa
              flow-meter: 150 → 15.0 L/min
              pump: 1 → running, HR1 = RPM
              valve: 1000 → 100.0% open
    HR1-HR99 — Reserved / secondary values
    IR mirrors HR so both function codes (FC3/FC4) return valid data.

Process simulation:
    A background asyncio task (simulate()) drifts HR0 ±magnitude every 2 seconds
    so that values look like live process measurements rather than static registers.
    This is important for educational scenarios — a frozen value does not demonstrate
    poll-response interaction meaningfully.

Protocol reference: Modbus Application Protocol v1.1b3
pymodbus version: 3.7+ (asyncio API)
"""
import asyncio
import logging
import os
import random

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

# ── Configuration from environment (injected by compose-generator.ts) ──────────
DEVICE_ID = os.getenv("DEVICE_ID", "device-1")
CATEGORY  = os.getenv("DEVICE_CATEGORY", "sensor")
PORT      = int(os.getenv("MODBUS_PORT", "502"))
UNIT_ID   = int(os.getenv("MODBUS_UNIT_ID", "1"))

# ── Initial holding register values per device category ─────────────────────────
# HR0 holds the primary process value. For fixed-point values, divide by 10 to get
# the engineering-unit reading (e.g., HR0=250 → 25.0 °C).
# A full 100-register block is allocated for each device; unused registers are 0.
DEFAULTS: dict[str, list[int]] = {
    "sensor":               [250]  + [0] * 99,    # 25.0 °C ambient temperature
    "pressure-transmitter": [1013] + [0] * 99,    # 101.3 kPa (1 atm)
    "flow-meter":           [150]  + [0] * 99,    # 15.0 L/min
    "pump":                 [1, 1500] + [0] * 98,  # HR0=run(1=on), HR1=RPM
    "valve":                [1000] + [0] * 99,    # 100.0% open (fully open)
    "actuator":             [0] * 100,            # Off/zero by default
    "plc":                  [0] * 100,            # Cleared (PLC loads its own program)
    "rtu":                  [0] * 100,            # Cleared
}

# ── Simulation drift configuration ─────────────────────────────────────────────
# Tuple: (register_index, max_drift_magnitude_per_tick)
# Devices not listed here have static registers (infrastructure devices, PLCs).
DRIFT: dict[str, tuple[int, float]] = {
    "sensor":               (0, 3.0),   # ±0.3 °C per tick (×10 fixed-point → ±3 register units)
    "pressure-transmitter": (0, 1.5),   # ±0.15 kPa per tick
    "flow-meter":           (0, 5.0),   # ±0.5 L/min per tick
    "pump":                 (1, 20.0),  # RPM register drifts ±20 per tick (HR1)
}


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
    Background task that drifts the primary process register every 2 seconds.

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
    reg, magnitude = DRIFT[CATEGORY]
    log.info("Process simulation: register HR%d drifts ±%.1f per tick", reg, magnitude)
    while True:
        await asyncio.sleep(2)
        try:
            # getValues(function_code, start_address, count) — FC3 = holding registers
            [val] = store.getValues(3, reg, 1)
            new_val = int(val + random.uniform(-magnitude, magnitude))
            # Clamp to unsigned 16-bit range — Modbus registers are uint16
            new_val = max(0, min(65535, new_val))
            store.setValues(3, reg, [new_val])  # Update HR (FC3)
            store.setValues(4, reg, [new_val])  # Keep IR (FC4) in sync
        except Exception as exc:
            log.warning("Simulation tick error: %s", exc)


async def main() -> None:
    """
    Entry point: initializes the Modbus server and starts the simulation task.

    Creates a multi-slave server context keyed by UNIT_ID (single=False).
    Using single=False allows the context to be addressed by unit ID in FC requests,
    which is correct Modbus TCP behavior when multiple virtual devices share a server.
    """
    log.info(
        "Device=%s  category=%s  unit=%d  port=%d",
        DEVICE_ID, CATEGORY, UNIT_ID, PORT,
    )
    store = build_store()
    # Multi-slave context: {unit_id: slave_context} — single=False is required here
    # because pymodbus 3.x distinguishes single-device from multi-device contexts
    context = ModbusServerContext(slaves={UNIT_ID: store}, single=False)
    # Start the simulation drift task before the server so it's running immediately
    asyncio.ensure_future(simulate(store))
    await StartAsyncTcpServer(context, address=("0.0.0.0", PORT))


if __name__ == "__main__":
    asyncio.run(main())
