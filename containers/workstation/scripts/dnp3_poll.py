#!/usr/bin/env python3
"""
dnp3_poll.py — Poll a DNP3 outstation with a Class 0 Data Read request.

Usage:
    python3 dnp3_poll.py <host> [--port 20000] [--master 1] [--outstation 10]

Examples:
    python3 dnp3_poll.py 10.200.10.11                   # IED at default addresses
    python3 dnp3_poll.py 10.200.10.11 --outstation 10

Protocol:  DNP3 over TCP (IEEE 1815-2012)
Function:  Class 0 Data Poll (Read Group 60 Var 1)
Response:  Group 30 Var 5 (IEEE 754 float Analog Inputs)

How it works
------------
A DNP3 message travels through three layers stacked inside each other:

  [Link Layer Frame]
      start bytes 0x05 0x64
      length, ctrl, dest addr, src addr
      CRC on header + 16-byte payload blocks
    └─ [Transport Layer segment]
           FIR/FIN flags + sequence
         └─ [Application Layer APDU]
                function code + object headers + data

This script sends one outbound READ request and reads back one response
frame, then decodes Group 30 Var 5 floating-point analog-input objects.
"""

import argparse
import socket
import struct
import sys
from typing import Optional

# ── DNP3 CRC-16/DNP ──────────────────────────────────────────────────────────

def _build_crc_table() -> list:
    """Pre-compute the 256-entry CRC-16/DNP lookup table (polynomial 0xA6BC)."""
    table = []
    for i in range(256):
        crc = i
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA6BC if crc & 1 else crc >> 1
        table.append(crc)
    return table

_CRC_TABLE = _build_crc_table()


def crc16(data: bytes) -> int:
    """Compute CRC-16/DNP over data bytes. Result is inverted at end."""
    crc = 0
    for byte in data:
        crc = (crc >> 8) ^ _CRC_TABLE[(crc ^ byte) & 0xFF]
    return crc ^ 0xFFFF


def crc_le(data: bytes) -> bytes:
    """Return the 2-byte little-endian CRC for a block."""
    return struct.pack("<H", crc16(data))


# ── Link layer ─────────────────────────────────────────────────────────────

def build_link_frame(ctrl: int, dest: int, src: int, payload: bytes) -> bytes:
    """
    Encode a DNP3 link-layer frame.

    The frame layout:
        0x05 0x64  — start bytes (sync)
        length     — count of bytes from ctrl through end of user data
        ctrl       — direction, PRM, FCB, FCV, function code
        dest[2]    — destination address (little-endian)
        src[2]     — source address (little-endian)
        CRC[2]     — CRC over the 8-byte header above
        [payload blocks of up to 16 bytes, each followed by CRC[2]]

    length = 5 (ctrl + dest + src) + len(payload)
    """
    data_len = 5 + len(payload)
    header = bytes([0x05, 0x64, data_len, ctrl]) + struct.pack("<HH", dest, src)
    frame = header + crc_le(header)
    for i in range(0, len(payload), 16):
        block = payload[i : i + 16]
        frame += block + crc_le(block)
    return frame


def parse_link_frame(raw: bytes) -> Optional[dict]:
    """
    Decode a raw DNP3 link frame.

    Returns a dict with keys: ctrl, dest, src, payload.
    Returns None if the start bytes are wrong or data is too short.
    """
    if len(raw) < 10 or raw[0] != 0x05 or raw[1] != 0x64:
        return None
    ctrl = raw[3]
    dest = struct.unpack_from("<H", raw, 4)[0]
    src  = struct.unpack_from("<H", raw, 6)[0]

    # Reassemble payload from 16-byte blocks (skip the 2-byte CRC after each)
    payload = bytearray()
    offset  = 10
    while offset < len(raw):
        end   = min(offset + 16, len(raw) - 2)  # block data, not the CRC
        block = raw[offset:end]
        payload.extend(block)
        offset = end + 2                         # skip 2 trailing CRC bytes
    return {"ctrl": ctrl, "dest": dest, "src": src, "payload": bytes(payload)}


# ── Application layer ─────────────────────────────────────────────────────

def build_class0_read_request(app_seq: int) -> bytes:
    """
    Build a DNP3 application-layer READ request for Class 0 Data.

    App header:
        0xC0 | seq  — FIR=1, FIN=1, CON=0, UNS=0, SEQ
        0x01         — function code READ
    Object header for Group 60 Var 1 (Class 0 Data), all objects:
        group=60, var=1, qualifier=0x06 (no range, read all)
    """
    app_seq_byte = 0xC0 | (app_seq & 0x0F)
    return bytes([app_seq_byte, 0x01, 60, 1, 0x06])


def build_transport_segment(app_data: bytes, trans_seq: int) -> bytes:
    """
    Wrap an application PDU in a single transport-layer segment.

    Transport header byte: FIR=1 (bit7), FIN=1 (bit6), SEQ[5:0]
    A single-segment message always has FIR=1 and FIN=1.
    """
    t_hdr = 0xC0 | (trans_seq & 0x3F)
    return bytes([t_hdr]) + app_data


def parse_class0_response(app_data: bytes) -> list:
    """
    Decode a DNP3 application Response and extract Group 30 Var 5 values.

    Group 30 Var 5 = Analog Input, 32-bit IEEE float, with flag byte.
    Each object = 1 flag byte + 4 float bytes = 5 bytes.

    Returns a list of (index, flags, float_value) tuples.
    """
    if len(app_data) < 4:
        return []

    # Bytes 0-1: app header (seq + FNC); bytes 2-3: IIN bytes
    # Object headers start at byte 4
    pos = 4
    results = []

    while pos < len(app_data):
        # Object header needs at least 3 bytes: group, var, qualifier
        if pos + 3 > len(app_data):
            break
        group     = app_data[pos]
        var       = app_data[pos + 1]
        qualifier = app_data[pos + 2]
        pos += 3

        if group == 30 and var == 5:
            # Qualifier 0x01 = 8-bit start/stop index range
            if qualifier == 0x01 and pos + 2 <= len(app_data):
                start = app_data[pos]
                stop  = app_data[pos + 1]
                pos  += 2
                for idx in range(start, stop + 1):
                    if pos + 5 > len(app_data):
                        break
                    flags = app_data[pos]
                    value = struct.unpack_from("<f", app_data, pos + 1)[0]
                    results.append((idx, flags, value))
                    pos += 5
        else:
            # Skip unknown object group — no way to know length, stop parsing
            break

    return results


# ── Master poll ───────────────────────────────────────────────────────────

def poll_outstation(host: str, port: int, master_addr: int, outstation_addr: int,
                    timeout: float = 5.0) -> None:
    """
    Open a TCP connection to a DNP3 outstation, send a Class 0 Read request,
    receive the response, and print the analog input values.
    """
    print(f"[dnp3] Connecting to {host}:{port} ...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
    except (ConnectionRefusedError, socket.timeout) as exc:
        print(f"[dnp3] ERROR: Could not connect — {exc}")
        sys.exit(1)

    print(f"[dnp3] Connected — master={master_addr}, outstation={outstation_addr}")

    # Build and send the Class 0 Read request
    app_req     = build_class0_read_request(app_seq=0)
    transport   = build_transport_segment(app_req, trans_seq=0)
    # ctrl = 0xC4: DIR=1 (master→outstation), PRM=1, FCB=0, FCV=0, FC=4 (UNCONFIRMED_DATA)
    link_frame  = build_link_frame(0xC4, outstation_addr, master_addr, transport)

    print(f"[dnp3] Sending Class 0 Read request ({len(link_frame)} bytes) ...")
    sock.sendall(link_frame)

    # Receive the response
    try:
        # Read the 10-byte link header first
        header = b""
        while len(header) < 10:
            chunk = sock.recv(10 - len(header))
            if not chunk:
                print("[dnp3] ERROR: Connection closed before response received")
                sys.exit(1)
            header += chunk

        if header[:2] != b"\x05\x64":
            print(f"[dnp3] ERROR: Bad start bytes in response: {header[:2].hex()}")
            sys.exit(1)

        # Length field tells us how many more bytes follow (after the fixed header)
        length     = header[2]
        # Payload bytes = length - 5 (ctrl+dest+src), arranged in 16-byte CRC blocks.
        # Each complete 16-byte block occupies 18 wire bytes (16 data + 2 CRC).
        # The final partial block occupies (k + 2) wire bytes, NOT 18 — using
        # ceil-division here over-estimates and causes a hang waiting for bytes
        # that are never sent.
        payload_bytes   = max(0, length - 5)
        complete_blocks = payload_bytes // 16
        partial_bytes   = payload_bytes % 16
        remaining = complete_blocks * 18 + (partial_bytes + 2 if partial_bytes > 0 else 0)

        body = b""
        while len(body) < remaining:
            chunk = sock.recv(remaining - len(body))
            if not chunk:
                break
            body += chunk

        raw_frame = header + body

    except socket.timeout:
        print(f"[dnp3] ERROR: Timed out waiting for response (>{timeout}s). "
              "Is the simulation running?")
        sys.exit(1)
    finally:
        sock.close()

    # Decode the response frame
    frame = parse_link_frame(raw_frame)
    if frame is None:
        print("[dnp3] ERROR: Could not parse response frame")
        sys.exit(1)

    if frame["dest"] != master_addr:
        print(f"[dnp3] WARNING: Response addressed to {frame['dest']}, expected {master_addr}")

    # payload[0] = transport header; rest = application data
    if len(frame["payload"]) < 2:
        print("[dnp3] ERROR: Response payload too short")
        sys.exit(1)

    app_data = frame["payload"][1:]    # strip transport header byte
    app_fc   = app_data[1] if len(app_data) > 1 else 0xFF

    if app_fc != 0x81:
        print(f"[dnp3] ERROR: Unexpected application function code: 0x{app_fc:02X}")
        sys.exit(1)

    # IIN bytes: warn on any error flags
    if len(app_data) >= 4:
        iin1, iin2 = app_data[2], app_data[3]
        if iin1 & 0x40:
            print("[dnp3] WARNING: IIN1.6 set — class 1 events available")
        if iin2 & 0x02:
            print("[dnp3] WARNING: IIN2.1 set — device restart (not cleared)")

    values = parse_class0_response(app_data)

    if not values:
        print("[dnp3] No Group 30 Var 5 analog input objects in response.")
        print("       The outstation may not have analog inputs in its Class 0 data.")
        return

    # Label map matching the outstation's value list order (index 0-3)
    LABELS = {0: "Temperature (°C)", 1: "Pressure (kPa)", 2: "Flow Rate (L/min)", 3: "Secondary"}

    print(f"\n[dnp3] Outstation {outstation_addr} — {len(values)} Analog Input(s):\n")
    print(f"  {'Index':<8} {'Label':<25} {'Flags':<8} {'Value'}")
    print("  " + "-" * 55)
    for idx, flags, value in values:
        label = LABELS.get(idx, f"AI{idx}")
        flag_str = "ONLINE" if flags & 0x01 else f"0x{flags:02X}"
        print(f"  {idx:<8} {label:<25} {flag_str:<8} {value:.2f}")


# ── CLI entry point ───────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="DNP3 Class 0 Data Poll — reads analog inputs from an outstation"
    )
    parser.add_argument("host", help="IP address of the DNP3 outstation")
    parser.add_argument("--port", type=int, default=20000, help="TCP port (default 20000)")
    parser.add_argument("--master", type=int, default=1,
                        help="DNP3 master address sent in request frames (default 1)")
    parser.add_argument("--outstation", type=int, default=10,
                        help="DNP3 outstation address to poll (default 10)")
    parser.add_argument("--timeout", type=float, default=5.0,
                        help="Socket timeout in seconds (default 5)")
    args = parser.parse_args()

    try:
        poll_outstation(args.host, args.port, args.master, args.outstation, args.timeout)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[dnp3] ERROR: {exc}")
        sys.exit(1)

    print("\n[dnp3] Done.")


if __name__ == "__main__":
    main()
