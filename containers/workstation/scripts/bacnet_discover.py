#!/usr/bin/env python3
"""
bacnet_discover.py — Discover BACnet devices and read their process values.

Usage:
    python3 bacnet_discover.py <host> [--port 47808] [--instance 1001]

Examples:
    python3 bacnet_discover.py 10.200.10.12                        # sensor at default instance
    python3 bacnet_discover.py 10.200.10.12 --instance 1001

Protocol:  BACnet/IP (ASHRAE 135, UDP port 47808)
Services:  ReadProperty, ReadPropertyMultiple
"""

import argparse
import asyncio
import sys

from bacpypes3.ipv4.app import NormalApplication
from bacpypes3.local.device import DeviceObject
from bacpypes3.pdu import Address
from bacpypes3.primitivedata import CharacterString
from bacpypes3.apdu import ReadPropertyRequest
from bacpypes3.basetypes import PropertyIdentifier, ObjectIdentifier


async def read_device(host: str, port: int, instance: int) -> None:
    # Minimal local device needed to send BACnet requests
    local_device = DeviceObject(
        objectIdentifier="device,9999",
        objectName=CharacterString("workstation-client"),
        vendorIdentifier=999,
        vendorName=CharacterString("OTForge"),
        modelName=CharacterString("WS-CLIENT"),
        firmwareRevision=CharacterString("1.0"),
        applicationSoftwareVersion=CharacterString("1.0"),
        maxApduLengthAccepted=1024,
        segmentationSupported="noSegmentation",
    )

    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("10.255.255.255", 1))
    local_ip = s.getsockname()[0]
    s.close()

    app = NormalApplication(local_device, f"{local_ip}:{port}")
    target = Address(f"{host}:{port}")

    print(f"[bacnet] Sending ReadProperty to device,{instance} at {host}:{port}")

    # Read the object list to discover all objects on the device
    object_list = await app.read_property(
        target,
        ObjectIdentifier(f"device,{instance}"),
        PropertyIdentifier("objectList"),
    )

    if object_list is None:
        print(f"[bacnet] No response from device,{instance} — is the simulation running?")
        return

    print(f"\n[bacnet] Device {instance} — {len(object_list)} objects found:\n")
    print(f"  {'Object':<30} {'Present Value'}")
    print("  " + "-" * 50)

    for obj_id in object_list:
        obj_type = str(obj_id[0])
        if obj_type in ("analog-input", "binary-input"):
            try:
                pv = await app.read_property(target, obj_id, PropertyIdentifier("presentValue"))
                name = await app.read_property(target, obj_id, PropertyIdentifier("objectName"))
                label = f"{obj_type},{obj_id[1]} ({name})"
                print(f"  {label:<30} {pv}")
            except Exception as exc:
                print(f"  {obj_type},{obj_id[1]:<25} (read error: {exc})")


def main() -> None:
    parser = argparse.ArgumentParser(description="BACnet device reader")
    parser.add_argument("host", help="IP address of the BACnet device")
    parser.add_argument("--port", type=int, default=47808, help="UDP port (default 47808)")
    parser.add_argument("--instance", type=int, default=1001, help="BACnet device instance number (default 1001)")
    args = parser.parse_args()

    try:
        asyncio.run(read_device(args.host, args.port, args.instance))
    except Exception as exc:
        print(f"[bacnet] ERROR: {exc}")
        sys.exit(1)

    print("\n[bacnet] Done.")


if __name__ == "__main__":
    main()
