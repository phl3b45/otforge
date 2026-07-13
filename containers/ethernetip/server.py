#!/usr/bin/env python3
"""
server.py — EtherNet/IP (CIP) device server (raw TCP — no cpppo/pycomm3 required).

Implements a minimal EtherNet/IP adapter (field device) using a hand-rolled
ENIP encapsulation layer and CIP (Common Industrial Protocol) explicit
messaging. Models a realistic remote I/O adapter — the kind of device that
sits on a real automotive/discrete-manufacturing EtherNet/IP network
(POINT I/O, FLEX I/O, a PowerFlex drive's I/O interface) rather than a PLC.

Scope: unconnected explicit messaging over TCP port 44818 (RegisterSession,
UnRegisterSession, SendRRData carrying Get_Attribute_Single/Set_Attribute_
Single) plus ListIdentity discovery. Class 1 cyclic implicit I/O (UDP port
2222, the real-time producer/consumer data stream a live PLC would actually
scan) is deferred — same kind of scope cut this project already made for
IEC 61850 GOOSE/Sampled Values (both are precisely-timed, layer-2-adjacent
traffic classes that are a different, much larger undertaking from request/
response explicit messaging).

Object model (ODVA CIP Vol 1 standard objects):
    Identity Object   (Class 0x01, Instance 1) — vendor/product/serial/name,
                        read-only. The same object a real ListIdentity /
                        Class 1 Get_Attribute_Single scan uses to fingerprint
                        a device — and, unauthenticated, so can an attacker.
    Assembly Object    (Class 0x04)
        Instance 100 (Input Assembly)  — read-only sensor/status data a real
                        adapter would produce for its scanning PLC.
        Instance 101 (Output Assembly) — writable actuator command data a
                        real PLC would consume; this is the point an
                        unauthorized host can write to just as easily.

Environment variables (all have defaults):
    DEVICE_ID        — string label used in logging
    DEVICE_CATEGORY  — device category for traceability
    ENIP_PORT        — TCP port (default 44818, the standard EtherNet/IP port)
    ENIP_VENDOR_ID   — Identity object Vendor ID (default 1 = "Rockwell
                       Automation/Allen-Bradley" in the real ODVA vendor
                       registry — used here purely so the value looks
                       realistic in a packet capture, not as an impersonation
                       claim; ODVA's registry is public)
    ENIP_PRODUCT_NAME — Identity object Product Name string

Protocol reference: ODVA "The CIP Networks Library", Volume 1 (CIP Common)
and Volume 2 (EtherNet/IP Adaptation of CIP)
"""

import asyncio
import logging
import os
import random
import socket
import struct

# ── Configuration ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-ethernetip")

DEVICE_ID    = os.getenv("DEVICE_ID", "enip-1")
CATEGORY     = os.getenv("DEVICE_CATEGORY", "ethernetip-adapter")
PORT         = int(os.getenv("ENIP_PORT", "44818"))
VENDOR_ID    = int(os.getenv("ENIP_VENDOR_ID", "1"))
PRODUCT_NAME = os.getenv("ENIP_PRODUCT_NAME", "OTForge Remote I/O Adapter")

# ── ENIP encapsulation command codes ─────────────────────────────────────────
CMD_REGISTER_SESSION   = 0x0065
CMD_UNREGISTER_SESSION = 0x0066
CMD_LIST_IDENTITY      = 0x0063
CMD_SEND_RR_DATA       = 0x006F

# ── CIP service codes ─────────────────────────────────────────────────────────
SVC_GET_ATTRIBUTE_SINGLE = 0x0E
SVC_SET_ATTRIBUTE_SINGLE = 0x10
SVC_REPLY_MASK           = 0x80   # set on the service byte in a response

# ── CIP general status codes (Vol 1, Appendix B) ─────────────────────────────
STATUS_SUCCESS               = 0x00
STATUS_PATH_DEST_UNKNOWN     = 0x05   # unknown class/instance/attribute
STATUS_ATTR_NOT_SETTABLE     = 0x0E   # write attempted on a read-only attribute
STATUS_SERVICE_NOT_SUPPORTED = 0x08

# ── CIP class codes ───────────────────────────────────────────────────────────
CLASS_IDENTITY = 0x01
CLASS_ASSEMBLY = 0x04

ASSEMBLY_INPUT_INSTANCE  = 100
ASSEMBLY_OUTPUT_INSTANCE = 101

# ── Device state ───────────────────────────────────────────────────────────────
# Input assembly: 4 bytes — two 16-bit "sensor" values that drift, matching
# the style of process data a real remote I/O block would produce.
_input_assembly = bytearray(4)
# Output assembly: 4 bytes — a writable command word an unauthorized host can
# set exactly like a legitimate scanning PLC would (no authentication in
# unconnected explicit messaging, the same property this project's other
# protocol servers demonstrate).
_output_assembly = bytearray(4)

_serial_number = random.randint(1, 0xFFFFFFFF)


def _update_input_assembly() -> None:
    """Drift the two 16-bit input values, mimicking live sensor data."""
    a = struct.unpack_from(">H", _input_assembly, 0)[0]
    b = struct.unpack_from(">H", _input_assembly, 2)[0]
    a = max(0, min(65535, a + random.randint(-50, 50)))
    b = max(0, min(65535, b + random.randint(-50, 50)))
    struct.pack_into(">H", _input_assembly, 0, a)
    struct.pack_into(">H", _input_assembly, 2, b)


# ── ENIP encapsulation ────────────────────────────────────────────────────────

def _enip_header(command: int, session: int, status: int, data: bytes) -> bytes:
    """Pack a 24-byte ENIP encapsulation header followed by the command data."""
    return struct.pack(
        "<HH I I 8s I",
        command, len(data), session, status, b"\x00" * 8, 0,
    ) + data


def _parse_enip_header(buf: bytes):
    """Unpack the 24-byte ENIP header. Returns (command, length, session, data)."""
    if len(buf) < 24:
        return None
    command, length, session, status = struct.unpack_from("<HH I I", buf, 0)
    data = buf[24:24 + length]
    return command, length, session, data


# ── CIP EPATH parsing ─────────────────────────────────────────────────────────

def _parse_epath(path_bytes: bytes):
    """
    Parse a padded 8-bit logical EPATH (the common case for explicit messaging
    to a simple device): sequences of (segment-type-byte, value-byte) pairs.
    Segment type 0x20 = 8-bit Class ID, 0x24 = 8-bit Instance ID,
    0x30 = 8-bit Attribute ID.

    Returns (class_id, instance_id, attribute_id) — any not present is None.
    """
    class_id = instance_id = attribute_id = None
    pos = 0
    while pos + 1 < len(path_bytes):
        seg_type = path_bytes[pos]
        value = path_bytes[pos + 1]
        if seg_type == 0x20:
            class_id = value
        elif seg_type == 0x24:
            instance_id = value
        elif seg_type == 0x30:
            attribute_id = value
        pos += 2
    return class_id, instance_id, attribute_id


# ── CIP object attribute access ───────────────────────────────────────────────

def _get_identity_attribute(instance: int, attribute: int):
    """Return (status, data_bytes) for a Get_Attribute_Single on the Identity object."""
    if instance != 1:
        return STATUS_PATH_DEST_UNKNOWN, b""
    if attribute == 1:      # Vendor ID (UINT)
        return STATUS_SUCCESS, struct.pack("<H", VENDOR_ID)
    if attribute == 2:      # Device Type (UINT) — 0x0C = Communications Adapter
        return STATUS_SUCCESS, struct.pack("<H", 0x0C)
    if attribute == 3:      # Product Code (UINT)
        return STATUS_SUCCESS, struct.pack("<H", 1)
    if attribute == 4:      # Revision (USINT major, USINT minor)
        return STATUS_SUCCESS, bytes([1, 0])
    if attribute == 5:      # Status (WORD)
        return STATUS_SUCCESS, struct.pack("<H", 0x0000)
    if attribute == 6:      # Serial Number (UDINT)
        return STATUS_SUCCESS, struct.pack("<I", _serial_number)
    if attribute == 7:      # Product Name (SHORT_STRING: 1-byte length + chars)
        name = PRODUCT_NAME.encode("ascii", errors="replace")
        return STATUS_SUCCESS, bytes([len(name)]) + name
    return STATUS_PATH_DEST_UNKNOWN, b""


def _get_assembly_attribute(instance: int, attribute: int):
    """Return (status, data_bytes) for a Get_Attribute_Single on the Assembly object."""
    if attribute != 3:   # only attribute 3 (Data) is implemented
        return STATUS_PATH_DEST_UNKNOWN, b""
    if instance == ASSEMBLY_INPUT_INSTANCE:
        return STATUS_SUCCESS, bytes(_input_assembly)
    if instance == ASSEMBLY_OUTPUT_INSTANCE:
        return STATUS_SUCCESS, bytes(_output_assembly)
    return STATUS_PATH_DEST_UNKNOWN, b""


def _set_assembly_attribute(instance: int, attribute: int, data: bytes):
    """Apply a Set_Attribute_Single to the Assembly object. Returns a CIP status code."""
    if attribute != 3:
        return STATUS_PATH_DEST_UNKNOWN
    if instance == ASSEMBLY_INPUT_INSTANCE:
        # Real EtherNet/IP adapters never accept a write to their own input
        # (producer) assembly — only the scanner/PLC writes the output
        # assembly. Rejecting this the same way a real device would.
        return STATUS_ATTR_NOT_SETTABLE
    if instance == ASSEMBLY_OUTPUT_INSTANCE:
        n = min(len(data), len(_output_assembly))
        _output_assembly[:n] = data[:n]
        log.info("Set_Attribute_Single Assembly,%d,%d -> %s",
                 instance, attribute, _output_assembly.hex())
        return STATUS_SUCCESS
    return STATUS_PATH_DEST_UNKNOWN


def _handle_cip_request(cip: bytes) -> bytes:
    """
    Handle one CIP explicit-message request (the payload of an Unconnected
    Data Item inside SendRRData) and return the CIP response bytes.

    Request:  service(1) + path_size_words(1) + path(2*path_size_words) + [data]
    Response: (service|0x80)(1) + reserved(1)=0 + status(1) + ext_status_size(1)=0
              + [response data or additional status]
    """
    if len(cip) < 2:
        return bytes([0, 0, STATUS_SERVICE_NOT_SUPPORTED, 0])

    service = cip[0]
    path_size_words = cip[1]
    path_bytes_len = path_size_words * 2
    path_bytes = cip[2:2 + path_bytes_len]
    remainder = cip[2 + path_bytes_len:]

    class_id, instance_id, attribute_id = _parse_epath(path_bytes)

    if service == SVC_GET_ATTRIBUTE_SINGLE:
        if class_id == CLASS_IDENTITY:
            status, data = _get_identity_attribute(instance_id, attribute_id)
        elif class_id == CLASS_ASSEMBLY:
            status, data = _get_assembly_attribute(instance_id, attribute_id)
        else:
            status, data = STATUS_PATH_DEST_UNKNOWN, b""
        log.info("Get_Attribute_Single class=0x%02x inst=%s attr=%s -> status=0x%02x (%d bytes)",
                  class_id or 0, instance_id, attribute_id, status, len(data))
        return bytes([service | SVC_REPLY_MASK, 0, status, 0]) + data

    if service == SVC_SET_ATTRIBUTE_SINGLE:
        if class_id == CLASS_ASSEMBLY:
            status = _set_assembly_attribute(instance_id, attribute_id, remainder)
        elif class_id == CLASS_IDENTITY:
            status = STATUS_ATTR_NOT_SETTABLE   # every Identity attribute here is read-only
        else:
            status = STATUS_PATH_DEST_UNKNOWN
        return bytes([service | SVC_REPLY_MASK, 0, status, 0])

    return bytes([service | SVC_REPLY_MASK, 0, STATUS_SERVICE_NOT_SUPPORTED, 0])


# ── Common Packet Format (CPF) — wraps CIP data inside SendRRData ───────────

def _build_unconnected_send_rr_data(cip_response: bytes) -> bytes:
    """
    Build the SendRRData command-specific data carrying one CIP response as
    an Unconnected Data Item, preceded by a Null Address Item (the standard
    CPF pair for unconnected explicit messaging).
    """
    null_addr_item = struct.pack("<HH", 0x0000, 0)                       # Type 0x0000, len 0
    data_item = struct.pack("<HH", 0x00B2, len(cip_response)) + cip_response  # Type 0x00B2
    body = struct.pack("<H", 2) + null_addr_item + data_item  # item count = 2
    # Interface Handle(4)=0, Timeout(2)=0, then the CPF item list built above
    return struct.pack("<I H", 0, 0) + body


def _parse_send_rr_data(data: bytes) -> bytes | None:
    """Extract the CIP request bytes from a SendRRData command payload."""
    if len(data) < 6:
        return None
    # Interface Handle(4) + Timeout(2), then item count(2)
    pos = 6
    if pos + 2 > len(data):
        return None
    item_count = struct.unpack_from("<H", data, pos)[0]
    pos += 2
    cip_request = None
    for _ in range(item_count):
        if pos + 4 > len(data):
            break
        item_type, item_len = struct.unpack_from("<HH", data, pos)
        pos += 4
        item_data = data[pos:pos + item_len]
        pos += item_len
        if item_type == 0x00B2:   # Unconnected Data Item — carries the CIP request
            cip_request = item_data
    return cip_request


# ── ListIdentity ───────────────────────────────────────────────────────────────

def _build_list_identity_response() -> bytes:
    """
    Build a ListIdentity response: a single Identity Item (type 0x0C) inside
    a one-item CPF list. This is the same discovery mechanism real EtherNet/IP
    scanning tools (and attackers) use to fingerprint devices on a subnet
    without any authentication.
    """
    name = PRODUCT_NAME.encode("ascii", errors="replace")
    identity_data = (
        struct.pack("<H", 1)                 # Encapsulation Protocol Version
        + b"\x00" * 16                       # Socket Address struct (unused here)
        + struct.pack("<H", VENDOR_ID)
        + struct.pack("<H", 0x0C)            # Device Type: Communications Adapter
        + struct.pack("<H", 1)               # Product Code
        + bytes([1, 0])                      # Revision major/minor
        + struct.pack("<H", 0x0000)          # Status
        + struct.pack("<I", _serial_number)
        + bytes([len(name)]) + name
        + bytes([0xFF])                      # State
    )
    item = struct.pack("<HH", 0x0C, len(identity_data)) + identity_data
    return struct.pack("<H", 1) + item   # item count = 1, then the item


# ── TCP session handling ──────────────────────────────────────────────────────

class _EnipConnection:
    def __init__(self):
        self.session_id = 0

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        try:
            while True:
                header_bytes = await reader.readexactly(24)
                parsed = _parse_enip_header(header_bytes)
                if parsed is None:
                    break
                command, length, session, _status = parsed
                data = await reader.readexactly(length) if length else b""

                response = self._dispatch(command, session, data, peer)
                if response is not None:
                    writer.write(response)
                    await writer.drain()

                if command == CMD_UNREGISTER_SESSION:
                    break
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        finally:
            writer.close()
            log.info("Connection closed: %s", peer)

    def _dispatch(self, command: int, session: int, data: bytes, peer) -> bytes | None:
        if command == CMD_REGISTER_SESSION:
            self.session_id = random.randint(1, 0x7FFFFFFF)
            log.info("RegisterSession from %s -> session=0x%08x", peer, self.session_id)
            # Echo back the same 4-byte protocol-version/options payload
            return _enip_header(CMD_REGISTER_SESSION, self.session_id, 0, data or b"\x01\x00\x00\x00")

        if command == CMD_UNREGISTER_SESSION:
            log.info("UnRegisterSession from %s", peer)
            return None

        if command == CMD_SEND_RR_DATA:
            cip_request = _parse_send_rr_data(data)
            if cip_request is None:
                return _enip_header(CMD_SEND_RR_DATA, session, 1, b"")
            cip_response = _handle_cip_request(cip_request)
            body = _build_unconnected_send_rr_data(cip_response)
            return _enip_header(CMD_SEND_RR_DATA, session, 0, body)

        if command == CMD_LIST_IDENTITY:
            body = _build_list_identity_response()
            return _enip_header(CMD_LIST_IDENTITY, 0, 0, body)

        log.info("Unsupported ENIP command 0x%04x from %s", command, peer)
        return _enip_header(command, session, 0x0001, b"")   # generic error status


async def _simulate() -> None:
    while True:
        await asyncio.sleep(2)
        _update_input_assembly()


async def _handle_connection(reader, writer):
    conn = _EnipConnection()
    await conn.handle(reader, writer)


async def main() -> None:
    log.info(
        "EtherNet/IP adapter starting -- id=%s  category=%s  port=%d  vendor_id=%d",
        DEVICE_ID, CATEGORY, PORT, VENDOR_ID,
    )
    log.info("  Identity: %s (serial=%08x)", PRODUCT_NAME, _serial_number)
    log.info("  Assembly Input  (instance %d, read-only):  2x UINT sensor values",
              ASSEMBLY_INPUT_INSTANCE)
    log.info("  Assembly Output (instance %d, writable):   4-byte command word",
              ASSEMBLY_OUTPUT_INSTANCE)

    server = await asyncio.start_server(_handle_connection, "0.0.0.0", PORT)
    log.info("Listening on TCP port %d (explicit messaging)", PORT)

    asyncio.create_task(_simulate())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
