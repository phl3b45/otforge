#!/usr/bin/env python3
"""
Minimal DNP3 Level 1 outstation — ICS Simulator device container.

Implements the DNP3 link/transport/application layers in pure Python
(no C++ bindings required). Handles Class 0 data polls from a master
and responds with synthetic analog input values that drift over time.

Protocol reference: IEEE 1815-2012 (DNP3)
"""
import asyncio
import logging
import os
import random
import struct

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-dnp3")

DEVICE_ID       = os.getenv("DEVICE_ID", "ied-1")
CATEGORY        = os.getenv("DEVICE_CATEGORY", "ied")
PORT            = int(os.getenv("DNP3_PORT", "20000"))
OUTSTATION_ADDR = int(os.getenv("DNP3_OUTSTATION_ADDRESS", "10"))
MASTER_ADDR     = int(os.getenv("DNP3_MASTER_ADDRESS", "1"))

# ── DNP3 CRC-16/DNP ──────────────────────────────────────────────────────────

def _build_crc_table() -> list[int]:
    table = []
    for i in range(256):
        crc = i
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA6BC if crc & 1 else crc >> 1
        table.append(crc)
    return table

_CRC_TABLE = _build_crc_table()


def crc16(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc = (crc >> 8) ^ _CRC_TABLE[(crc ^ byte) & 0xFF]
    return crc ^ 0xFFFF


def crc_le(data: bytes) -> bytes:
    return struct.pack("<H", crc16(data))


# ── Link layer ────────────────────────────────────────────────────────────────

def build_link_frame(ctrl: int, dest: int, src: int, payload: bytes) -> bytes:
    """Encode a DNP3 link-layer frame with CRC blocks."""
    # Length = bytes from ctrl to end of user data (before final CRC pair)
    data_len = 5 + len(payload)  # ctrl(1) + dest(2) + src(2) = 5
    header = bytes([0x05, 0x64, data_len, ctrl]) + struct.pack("<HH", dest, src)
    frame = header + crc_le(header)
    for i in range(0, len(payload), 16):
        block = payload[i : i + 16]
        frame += block + crc_le(block)
    return frame


def parse_link_frame(raw: bytes) -> dict | None:
    if len(raw) < 10 or raw[0] != 0x05 or raw[1] != 0x64:
        return None
    length = raw[2]
    ctrl   = raw[3]
    dest   = struct.unpack_from("<H", raw, 4)[0]
    src    = struct.unpack_from("<H", raw, 6)[0]
    # Reassemble payload from 16-byte blocks (skip CRC bytes, trust data for now)
    payload = bytearray()
    offset  = 10
    while offset < len(raw):
        block = raw[offset : offset + 16]
        payload.extend(block)
        offset += len(block) + 2  # skip trailing CRC
    return {"ctrl": ctrl, "dest": dest, "src": src, "payload": bytes(payload), "length": length}


# ── Application layer ─────────────────────────────────────────────────────────

def build_class0_response(app_seq: int, values: list[float]) -> bytes:
    """
    Build a DNP3 application-layer Response (FNC=0x81) carrying
    Group 30, Var 5 (32-bit IEEE float, flagged) analog inputs.
    """
    # App header: FIR=1, FIN=1, CON=0, UNS=0, SEQ[3:0]
    app_hdr = bytes([0xC0 | (app_seq & 0x0F), 0x81])
    iin     = bytes([0x00, 0x00])  # no error flags

    if not values:
        return app_hdr + iin

    # Object header: group=30, var=5, qualifier=0x01 (8-bit start/stop)
    obj_hdr  = bytes([30, 5, 0x01, 0, len(values) - 1])
    obj_data = bytearray()
    for v in values:
        obj_data += b"\x01"  # flags: ONLINE
        obj_data += struct.pack("<f", float(v))

    return app_hdr + iin + obj_hdr + bytes(obj_data)


def build_transport_payload(app_data: bytes, trans_seq: int) -> bytes:
    """Wrap application data in a single transport-layer segment (FIR=1, FIN=1)."""
    t_hdr = 0xC0 | (trans_seq & 0x3F)  # FIR=1, FIN=1
    return bytes([t_hdr]) + app_data


# ── Process simulation ────────────────────────────────────────────────────────

# Default analog values: [temperature, pressure, flow, secondary]
_INITIAL: dict[str, list[float]] = {
    "ied":    [25.0, 101.3, 0.0, 0.0],
    "sensor": [25.0, 101.3, 15.0, 0.0],
    "rtu":    [0.0, 0.0, 0.0, 0.0],
}
_values: list[float] = list(_INITIAL.get(CATEGORY, [25.0, 101.3, 15.0, 0.0]))


async def drift_values() -> None:
    while True:
        await asyncio.sleep(2)
        for i in range(len(_values)):
            _values[i] += random.uniform(-0.5, 0.5)
            _values[i]  = max(0.0, min(9999.0, _values[i]))


# ── TCP connection handler ────────────────────────────────────────────────────

async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer      = writer.get_extra_info("peername")
    app_seq   = 0
    trans_seq = 0
    log.info("Master connected from %s", peer)

    try:
        while True:
            # Read the fixed 10-byte link header
            header = await asyncio.wait_for(reader.readexactly(10), timeout=60)
            if header[:2] != b"\x05\x64":
                log.warning("Invalid start bytes, discarding frame")
                continue

            length = header[2]
            # User data after the header: payload blocks follow
            # length covers ctrl(1)+dest(2)+src(2)+payload; subtract 5 for those fields
            payload_len = max(0, length - 5)
            # Payload is split into 16-byte blocks with 2-byte CRC each
            block_count = (payload_len + 15) // 16
            extra_len   = block_count * 18  # 16 data + 2 CRC
            extra = await asyncio.wait_for(reader.read(extra_len), timeout=5)

            frame = parse_link_frame(header + extra)
            if frame is None or frame["dest"] != OUTSTATION_ADDR:
                continue

            ctrl = frame["ctrl"]
            prm  = (ctrl >> 6) & 1  # Primary frame bit
            fc   = ctrl & 0x0F

            if prm == 1 and fc == 4:  # USER_DATA_UNCONFIRMED from master
                app_data = frame["payload"][1:]  # skip transport header byte
                if len(app_data) < 2:
                    continue
                app_fc = app_data[1]

                if app_fc == 0x01:  # READ request
                    resp_app   = build_class0_response(app_seq, _values)
                    app_seq    = (app_seq + 1) & 0x0F
                    t_payload  = build_transport_payload(resp_app, trans_seq)
                    trans_seq  = (trans_seq + 1) & 0x3F
                    # Control: DIR=0, PRM=0, FC=4 (UNCONFIRMED_DATA) from outstation
                    link_frame = build_link_frame(0x44, MASTER_ADDR, OUTSTATION_ADDR, t_payload)
                    writer.write(link_frame)
                    await writer.drain()
                    log.info("Class 0 response sent (%d AI values)", len(_values))

    except asyncio.TimeoutError:
        log.info("Connection from %s timed out", peer)
    except asyncio.IncompleteReadError:
        log.info("Master at %s disconnected", peer)
    except Exception as exc:
        log.warning("Handler error for %s: %s", peer, exc)
    finally:
        writer.close()


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    log.info(
        "Device=%s  category=%s  outstation=%d  master=%d  port=%d",
        DEVICE_ID, CATEGORY, OUTSTATION_ADDR, MASTER_ADDR, PORT,
    )
    asyncio.ensure_future(drift_values())
    server = await asyncio.start_server(handle_client, "0.0.0.0", PORT)
    log.info("DNP3 outstation listening on port %d", PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
