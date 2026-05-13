#!/usr/bin/env python3
"""
Modbus TCP server — ICS Simulator device container.
Simulates holding registers and input registers for field devices.
Register HR0 holds the primary process value (×10 fixed-point, e.g. 250 = 25.0°C).
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

DEVICE_ID = os.getenv("DEVICE_ID", "device-1")
CATEGORY  = os.getenv("DEVICE_CATEGORY", "sensor")
PORT      = int(os.getenv("MODBUS_PORT", "502"))
UNIT_ID   = int(os.getenv("MODBUS_UNIT_ID", "1"))

# Initial holding register values per device category
# HR0 = primary process value (fixed-point ×10)
DEFAULTS: dict[str, list[int]] = {
    "sensor":               [250]  + [0] * 99,   # 25.0 °C
    "pressure-transmitter": [1013] + [0] * 99,   # 101.3 kPa
    "flow-meter":           [150]  + [0] * 99,   # 15.0 L/min
    "pump":                 [1, 1500] + [0] * 98, # run=1, RPM=1500
    "valve":                [1000] + [0] * 99,   # 100.0% open
    "actuator":             [0] * 100,
    "plc":                  [0] * 100,
    "rtu":                  [0] * 100,
}

# (register_index, max_drift_per_2s_tick) — drives the process simulation
DRIFT: dict[str, tuple[int, float]] = {
    "sensor":               (0, 3.0),
    "pressure-transmitter": (0, 1.5),
    "flow-meter":           (0, 5.0),
    "pump":                 (1, 20.0),  # RPM column drifts
}


def build_store() -> ModbusSlaveContext:
    hr = list(DEFAULTS.get(CATEGORY, [0] * 100))
    return ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [0] * 100),
        co=ModbusSequentialDataBlock(0, [0] * 100),
        hr=ModbusSequentialDataBlock(0, hr),
        ir=ModbusSequentialDataBlock(0, list(hr)),  # IR mirrors HR
    )


async def simulate(store: ModbusSlaveContext) -> None:
    """Drift the primary register so readings look like a live process."""
    if CATEGORY not in DRIFT:
        return
    reg, magnitude = DRIFT[CATEGORY]
    log.info("Process simulation: register HR%d drifts ±%.1f per tick", reg, magnitude)
    while True:
        await asyncio.sleep(2)
        try:
            [val] = store.getValues(3, reg, 1)
            new_val = int(val + random.uniform(-magnitude, magnitude))
            new_val = max(0, min(65535, new_val))
            store.setValues(3, reg, [new_val])
            store.setValues(4, reg, [new_val])  # keep IR in sync
        except Exception as exc:
            log.warning("Simulation tick error: %s", exc)


async def main() -> None:
    log.info(
        "Device=%s  category=%s  unit=%d  port=%d",
        DEVICE_ID, CATEGORY, UNIT_ID, PORT,
    )
    store = build_store()
    context = ModbusServerContext(slaves={UNIT_ID: store}, single=False)
    asyncio.ensure_future(simulate(store))
    await StartAsyncTcpServer(context, address=("0.0.0.0", PORT))


if __name__ == "__main__":
    asyncio.run(main())
