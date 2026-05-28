#!/usr/bin/env python3
"""
server.py — BACnet/IP device server (raw UDP — no bacpypes3 required).

Implements a minimal BACnet/IP outstation using asyncio UDP sockets and
hand-rolled BVLC/NPCI/APDU encoding. Responds to ReadProperty requests
for objectList, presentValue, and objectName — the only services used by
the Lab_02 protocol survey script.

The bacpypes3 high-level API changed its NormalApplication constructor
signature across minor versions (string address → IPv4Address object,
direct instantiation → async context manager). Raw UDP removes the
dependency entirely so the server works regardless of the bacpypes3
version installed in the container.

Object layout:
    Device Object   — instance BACNET_DEVICE_INSTANCE
    Analog Input 1  — Temperature  (°C,    drifts ±2.0 per tick)
    Analog Input 2  — Pressure     (kPa,   drifts ±1.5 per tick)
    Analog Input 3  — FlowRate     (L/min, drifts ±3.0 per tick)
    Analog Input 4  — TankLevel    (mm,    drifts ±10.0 per tick)
    Binary Input 1  — PumpRunning  (active)
    Binary Input 2  — ValveOpen    (active)

Environment variables (all have defaults):
    DEVICE_ID              — string label used in logging
    DEVICE_CATEGORY        — device category for traceability
    BACNET_DEVICE_INSTANCE — BACnet device instance number
    BACNET_PORT            — UDP port (default 47808)

Protocol reference: ASHRAE 135-2020 (BACnet)
"""

import asyncio
import logging
import os
import random
import struct

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

# ── BACnet object type codes (ASHRAE 135 Table 12-1) ─────────────────────────
OBJ_ANALOG_INPUT = 0
OBJ_BINARY_INPUT = 3
OBJ_DEVICE       = 8

# ── BACnet property identifier codes (ASHRAE 135 Table 12-2) ─────────────────
PROP_OBJECT_LIST   = 76
PROP_OBJECT_NAME   = 77
PROP_PRESENT_VALUE = 85

# ── BACnet application tag numbers ───────────────────────────────────────────
TAG_REAL        = 4
TAG_CHAR_STRING = 7
TAG_ENUMERATED  = 9
TAG_OBJECT_ID   = 12

# ── Process variable definitions ─────────────────────────────────────────────

# (instance, name, initial_value, drift_magnitude)
ANALOG_OBJECTS: list[tuple[int, str, float, float]] = [
    (1, "Temperature",  25.0,  2.0),
    (2, "Pressure",     101.3, 1.5),
    (3, "FlowRate",     15.0,  3.0),
    (4, "TankLevel",    500.0, 10.0),
]

# (instance, name, initial_value)
BINARY_OBJECTS: list[tuple[int, str, bool]] = [
    (1, "PumpRunning", True),
    (2, "ValveOpen",   True),
]

# ── In-memory object store ────────────────────────────────────────────────────
# Key: (obj_type, instance) — Value: dict with name, value, value_type, drift
_objects: dict[tuple[int, int], dict] = {}

def _init_objects() -> None:
    """Populate the in-memory object store from the definitions above."""
    obj_list = [(OBJ_DEVICE, DEVICE_INSTANCE)]
    for inst, _, __, ___ in ANALOG_OBJECTS:
        obj_list.append((OBJ_ANALOG_INPUT, inst))
    for inst, _, __ in BINARY_OBJECTS:
        obj_list.append((OBJ_BINARY_INPUT, inst))

    _objects[(OBJ_DEVICE, DEVICE_INSTANCE)] = {
        'name': DEVICE_ID,
        'objectList': obj_list,
    }
    for inst, name, initial, drift in ANALOG_OBJECTS:
        _objects[(OBJ_ANALOG_INPUT, inst)] = {
            'name': name, 'value': initial, 'value_type': 'real', 'drift': drift,
        }
    for inst, name, initial in BINARY_OBJECTS:
        _objects[(OBJ_BINARY_INPUT, inst)] = {
            'name': name, 'value': initial, 'value_type': 'bool',
        }


# ── BACnet encoding helpers ───────────────────────────────────────────────────

def _app_tag(tag_num: int, data: bytes) -> bytes:
    """Wrap data in a BACnet application tag."""
    n = len(data)
    if n <= 4:
        return bytes([(tag_num << 4) | n]) + data
    elif n <= 253:
        return bytes([(tag_num << 4) | 5, n]) + data
    else:
        return bytes([(tag_num << 4) | 5, 0xFE]) + struct.pack(">H", n) + data


def _ctx_tag(tag_num: int, data: bytes) -> bytes:
    """Wrap data in a BACnet context tag."""
    n = len(data)
    if n <= 4:
        return bytes([(tag_num << 4) | 0x08 | n]) + data
    elif n <= 253:
        return bytes([(tag_num << 4) | 0x08 | 5, n]) + data
    else:
        return bytes([(tag_num << 4) | 0x08 | 5, 0xFE]) + struct.pack(">H", n) + data


def _open_tag(tag_num: int) -> bytes:
    return bytes([(tag_num << 4) | 0x0E])  # (tag<<4) | 0x08 | 0x06


def _close_tag(tag_num: int) -> bytes:
    return bytes([(tag_num << 4) | 0x0F])  # (tag<<4) | 0x08 | 0x07


def _encode_obj_id_bytes(obj_type: int, instance: int) -> bytes:
    """Pack a BACnet Object Identifier as 4 raw bytes."""
    return struct.pack(">I", (obj_type << 22) | (instance & 0x3FFFFF))


# ── BACnet decoding helpers ───────────────────────────────────────────────────

def _decode_tag(data: bytes, pos: int) -> tuple[int, int, int, int]:
    """
    Decode one BACnet tag at pos.
    Returns (tag_num, ctx_class, length, next_pos).
    length=-1 means opening tag, -2 means closing tag.
    """
    b = data[pos];  pos += 1
    tag_num   = (b >> 4) & 0x0F
    ctx_class = (b >> 3) & 0x01
    length    = b & 0x07

    if tag_num == 0x0F:
        tag_num = data[pos];  pos += 1

    if length == 5:
        ext = data[pos];  pos += 1
        if ext == 0xFE:
            length = struct.unpack_from(">H", data, pos)[0];  pos += 2
        elif ext == 0xFF:
            length = struct.unpack_from(">I", data, pos)[0];  pos += 4
        else:
            length = ext
    elif length == 6:
        length = -1   # opening tag
    elif length == 7:
        length = -2   # closing tag

    return tag_num, ctx_class, length, pos


def _strip_bvlc(data: bytes) -> bytes:
    """Remove BVLC header (4 bytes)."""
    if len(data) < 4 or data[0] != 0x81:
        raise ValueError("Not a BACnet/IP frame")
    return data[4:]


def _strip_npci(data: bytes) -> bytes:
    """Remove the NPCI header and return the raw APDU."""
    if len(data) < 2:
        raise ValueError("NPCI too short")
    control = data[1]
    offset  = 2
    if control & 0x20:            # DNET/DADR present
        if len(data) < offset + 3:
            raise ValueError("NPCI DNET truncated")
        dlen = data[offset + 2]
        offset += 3 + dlen + 1   # +1 for hop count that follows DNET
    if control & 0x08:            # SNET/SADR present
        if len(data) < offset + 3:
            raise ValueError("NPCI SNET truncated")
        slen = data[offset + 2]
        offset += 3 + slen
    return data[offset:]


# ── ReadProperty request parser ───────────────────────────────────────────────

def _parse_read_property(apdu: bytes) -> tuple[int, int, int, int] | None:
    """
    Parse a ReadProperty Confirmed Request APDU.
    Returns (obj_type, obj_inst, prop_id, invoke_id) or None if not a valid request.
    """
    if len(apdu) < 4:
        return None
    pdu_type = (apdu[0] >> 4) & 0x0F
    if pdu_type != 0:      # 0 = Confirmed Service Request
        return None
    invoke_id = apdu[2]
    service   = apdu[3]
    if service != 0x0C:    # 0x0C = ReadProperty
        return None

    pos = 4
    obj_type = obj_inst = prop_id = None

    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = _decode_tag(apdu, pos)
        except (IndexError, ValueError):
            break
        if ctx_class == 1 and tag_num == 0 and length == 4:    # context[0] = Object ID
            raw      = apdu[next_pos:next_pos + 4]
            val      = struct.unpack(">I", raw)[0]
            obj_type = (val >> 22) & 0x3FF
            obj_inst = val & 0x3FFFFF
            pos      = next_pos + 4
        elif ctx_class == 1 and tag_num == 1 and length >= 1:  # context[1] = Property ID
            prop_id = int.from_bytes(apdu[next_pos:next_pos + length], 'big')
            pos     = next_pos + length
        else:
            pos = next_pos + length if length >= 0 else next_pos

    if None in (obj_type, obj_inst, prop_id):
        return None
    return obj_type, obj_inst, prop_id, invoke_id


# ── Response builders ─────────────────────────────────────────────────────────

def _wrap_frame(apdu: bytes) -> bytes:
    """Wrap an APDU in NPCI + BVLC for unicast transmission."""
    npci    = bytes([0x01, 0x00])   # version=1, no data-expecting-reply in responses
    payload = npci + apdu
    bvlc    = bytes([0x81, 0x0A]) + struct.pack(">H", 4 + len(payload))
    return bvlc + payload


def _build_ack(invoke_id: int, obj_type: int, obj_inst: int,
               prop_id: int, value_bytes: bytes) -> bytes:
    """Build a ReadProperty Complex-ACK frame."""
    prop_enc = bytes([prop_id]) if prop_id < 256 else struct.pack(">H", prop_id)
    apdu = (
        bytes([0x30, invoke_id & 0xFF, 0x0C])    # Complex-ACK, invoke, ReadProperty
        + _ctx_tag(0, _encode_obj_id_bytes(obj_type, obj_inst))  # echo obj ID
        + _ctx_tag(1, prop_enc)                                   # echo prop ID
        + _open_tag(3)
        + value_bytes
        + _close_tag(3)
    )
    return _wrap_frame(apdu)


def _build_error(invoke_id: int, error_class: int, error_code: int) -> bytes:
    """Build a BACnet Error PDU for ReadProperty."""
    apdu = (
        bytes([0x50, invoke_id & 0xFF, 0x0C])    # Error PDU, invoke, ReadProperty
        + _app_tag(TAG_ENUMERATED, bytes([error_class]))
        + _app_tag(TAG_ENUMERATED, bytes([error_code]))
    )
    return _wrap_frame(apdu)


# ── Property value encoder ────────────────────────────────────────────────────

def _build_response(obj_type: int, obj_inst: int, prop_id: int,
                    invoke_id: int) -> bytes:
    """Look up the object/property and build the appropriate ACK or Error response."""
    obj = _objects.get((obj_type, obj_inst))
    if obj is None:
        return _build_error(invoke_id, 1, 31)   # error-class=object, unknown-object

    if prop_id == PROP_OBJECT_NAME:
        name_bytes = obj['name'].encode('utf-8')
        value = _app_tag(TAG_CHAR_STRING, b'\x00' + name_bytes)  # 0x00 = UTF-8 encoding

    elif prop_id == PROP_PRESENT_VALUE:
        if 'value' not in obj:
            return _build_error(invoke_id, 2, 32)   # error-class=property, unknown-property
        v = obj['value']
        if obj.get('value_type') == 'real':
            value = _app_tag(TAG_REAL, struct.pack('>f', float(v)))
        else:
            value = _app_tag(TAG_ENUMERATED, bytes([1 if v else 0]))

    elif prop_id == PROP_OBJECT_LIST:
        if obj_type != OBJ_DEVICE:
            return _build_error(invoke_id, 2, 32)
        # Each ObjectIdentifier is an application tag 12 with 4 bytes
        value = b"".join(
            _app_tag(TAG_OBJECT_ID, _encode_obj_id_bytes(t, i))
            for t, i in obj.get('objectList', [])
        )

    else:
        return _build_error(invoke_id, 2, 32)   # error-class=property, unknown-property

    return _build_ack(invoke_id, obj_type, obj_inst, prop_id, value)


# ── Process simulation ────────────────────────────────────────────────────────

async def _simulate() -> None:
    """Drift all analog present-values ±magnitude every 2 seconds."""
    while True:
        await asyncio.sleep(2)
        for inst, _, _, magnitude in ANALOG_OBJECTS:
            key = (OBJ_ANALOG_INPUT, inst)
            if key in _objects:
                cur = _objects[key]['value']
                _objects[key]['value'] = max(0.0, cur + random.uniform(-magnitude, magnitude))


# ── asyncio UDP protocol ──────────────────────────────────────────────────────

class _BACnetProtocol(asyncio.DatagramProtocol):
    """asyncio DatagramProtocol that handles incoming BACnet/IP unicast packets."""

    def __init__(self) -> None:
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.DatagramTransport) -> None:  # type: ignore[override]
        self.transport = transport
        log.info("BACnet/IP server listening on UDP port %d", PORT)

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        try:
            self._handle(data, addr)
        except Exception as exc:
            log.warning("Error handling packet from %s: %s", addr, exc)

    def _handle(self, data: bytes, addr: tuple) -> None:
        # Strip BVLC (4 bytes) — reject non-BACnet frames silently
        try:
            npci_apdu = _strip_bvlc(data)
            apdu      = _strip_npci(npci_apdu)
        except ValueError:
            return

        parsed = _parse_read_property(apdu)
        if parsed is None:
            return  # not a ReadProperty request — ignore silently

        obj_type, obj_inst, prop_id, invoke_id = parsed
        response = _build_response(obj_type, obj_inst, prop_id, invoke_id)

        if self.transport:
            self.transport.sendto(response, addr)
            log.info(
                "ReadProperty(%s,%d, prop=%d) → %d bytes to %s",
                obj_type, obj_inst, prop_id, len(response), addr,
            )

    def error_received(self, exc: Exception) -> None:
        log.warning("UDP error: %s", exc)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    _init_objects()

    log.info(
        "BACnet/IP device starting — id=%s  category=%s  instance=%d  port=%d",
        DEVICE_ID, CATEGORY, DEVICE_INSTANCE, PORT,
    )
    log.info(
        "Analog: %s",
        ", ".join(f"AI:{i} {n}" for i, n, *_ in ANALOG_OBJECTS),
    )
    log.info(
        "Binary: %s",
        ", ".join(f"BI:{i} {n}" for i, n, _ in BINARY_OBJECTS),
    )

    loop = asyncio.get_event_loop()
    transport, _ = await loop.create_datagram_endpoint(
        _BACnetProtocol,
        local_addr=("0.0.0.0", PORT),
    )

    log.info("Device ready — serving ReadProperty requests")

    try:
        asyncio.create_task(_simulate())
        await asyncio.Future()   # run until the container is killed
    finally:
        transport.close()


if __name__ == "__main__":
    asyncio.run(main())
