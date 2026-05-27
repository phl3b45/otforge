#!/usr/bin/env python3
"""
opcua_browse.py — Browse an OPC UA server address space and read process values.

Usage:
    python3 opcua_browse.py <host> [--port 4840]

Examples:
    python3 opcua_browse.py 10.200.20.10           # SCADA server (default port)
    python3 opcua_browse.py 10.200.20.10 --port 4840

Protocol:  OPC UA binary TCP (opc.tcp://)
Services:  Browse, ReadValue
"""

import argparse
import asyncio
import sys

from asyncua import Client


async def browse_and_read(host: str, port: int) -> None:
    url = f"opc.tcp://{host}:{port}"
    print(f"[opcua] Connecting to {url} ...")

    async with Client(url=url) as client:
        print(f"[opcua] Connected — server: {await client.get_namespace_array()}")

        # Walk Objects node looking for the Process folder
        objects = client.get_objects_node()
        print("\n[opcua] Browsing Objects/ ...")

        children = await objects.get_children()
        for child in children:
            name = (await child.read_browse_name()).Name
            print(f"  [{name}]")

            grandchildren = await child.get_children()
            for gc in grandchildren:
                gc_name = (await gc.read_browse_name()).Name
                try:
                    value = await gc.read_value()
                    print(f"    {gc_name:<20} = {value}")
                except Exception:
                    print(f"    {gc_name:<20} (not readable)")


def main() -> None:
    parser = argparse.ArgumentParser(description="OPC UA address space browser")
    parser.add_argument("host", help="IP address of the OPC UA server")
    parser.add_argument("--port", type=int, default=4840, help="TCP port (default 4840)")
    args = parser.parse_args()

    try:
        asyncio.run(browse_and_read(args.host, args.port))
    except Exception as exc:
        print(f"[opcua] ERROR: {exc}")
        sys.exit(1)

    print("\n[opcua] Done.")


if __name__ == "__main__":
    main()
