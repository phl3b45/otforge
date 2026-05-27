#!/usr/bin/env python3
"""
modbus_read.py — Read Modbus holding registers from an RTU or PLC.

Usage:
    python3 modbus_read.py <host> [--port 502] [--unit 1] [--address 0] [--count 10]

Examples:
    python3 modbus_read.py 10.200.10.10              # PLC at default address
    python3 modbus_read.py 10.200.10.11 --count 5   # RTU, first 5 registers

Protocol:  Modbus TCP (RFC-based, IANA port 502)
Function:  FC03 — Read Holding Registers
"""

import argparse
import sys

from pymodbus.client import ModbusTcpClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Modbus holding register reader")
    parser.add_argument("host", help="IP address of the Modbus device")
    parser.add_argument("--port", type=int, default=502, help="TCP port (default 502)")
    parser.add_argument("--unit", type=int, default=1, help="Modbus unit/device ID (default 1)")
    parser.add_argument("--address", type=int, default=0, help="Start register address (default 0)")
    parser.add_argument("--count", type=int, default=10, help="Number of registers to read (default 10)")
    args = parser.parse_args()

    print(f"[modbus] Connecting to {args.host}:{args.port} ...")
    client = ModbusTcpClient(args.host, port=args.port)
    if not client.connect():
        print(f"[modbus] ERROR: Could not connect to {args.host}:{args.port}")
        sys.exit(1)

    print(f"[modbus] Reading {args.count} holding registers from address {args.address} (device_id={args.unit})")
    result = client.read_holding_registers(args.address, count=args.count, device_id=args.unit)

    if result.isError():
        print(f"[modbus] ERROR: {result}")
        client.close()
        sys.exit(1)

    print(f"\n{'Register':<12} {'Value (raw)':<14} {'Value (/10)'}")
    print("-" * 40)
    for i, val in enumerate(result.registers):
        addr = args.address + i
        print(f"HR{addr:<10} {val:<14} {val / 10:.1f}")

    client.close()
    print(f"\n[modbus] Done.")


if __name__ == "__main__":
    main()
