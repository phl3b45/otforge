#!/usr/bin/env python3
"""
server.py — PROFINET DCP (Discovery and Configuration Protocol) IO device.

Implements DCP only, over a raw AF_PACKET Ethernet socket (EtherType 0x8892 —
no IP/UDP framing at all, straight Ethernet payload). PROFINET's full stack
has two more layers above this:
    - Context Manager (DCE/RPC over UDP 34964) — establishes the Application
      Relationship (AR) between an IO Controller (PLC) and this IO Device
      before any process data can flow.
    - RT (Real-Time) cyclic data — raw Ethernet frames, sub-millisecond cycle
      times, the actual I/O exchange a live PLC would scan.
Both are a much larger undertaking (real-time framing + connection-oriented
state machine) — the same kind of scope cut this project already made for
EtherNet/IP Class 1 cyclic I/O and IEC 61850 GOOSE/Sampled Values.

DCP on its own is still a complete, real, and pedagogically useful protocol
surface: it is how every PROFINET engineering tool (Siemens' Primary Setup
Tool, TIA Portal's "Accessible Devices") discovers devices on a segment and
assigns their station name / IP address — and it does so with **zero
authentication**. Anyone on the same Ethernet segment can:
    - Identify (fingerprint) every PROFINET device with one multicast frame.
    - Set (rename) a device's NameOfStation.
    - Set (reassign) a device's IP address.
    - Reset a device to factory settings.
This device implements all four, faithfully reproducing that lack of
authentication — the same property this project's other protocol servers
(EtherNet/IP Set_Attribute_Single, IEC 61850 SetDataValues) demonstrate.

Services implemented (DCP ServiceID):
    Identify (5) — multicast request (dst MAC 01:0E:CF:00:00:00), unicast
                   response carrying NameOfStation, Device ID, Device Role,
                   and IP Parameter blocks — a complete device fingerprint.
    Get      (3) — unicast request for specific blocks, or all of them.
    Set      (4) — unicast request to change NameOfStation, IP Parameter,
                   trigger Reset to Factory Settings, or Flash (Signal) the
                   device's identification LED (logged only — no real LED).
    Hello    (6) — sent once at startup (unsolicited device announcement);
                   received Hello frames from other devices are logged only.

Environment variables (all have defaults):
    DEVICE_ID             — string label used in logging
    DEVICE_CATEGORY       — device category for traceability
    PROFINET_IFACE        — network interface to bind the raw socket to (default eth0)
    PROFINET_STATION_NAME — initial NameOfStation
    PROFINET_VENDOR_ID    — 16-bit Vendor ID reported in the Device ID block
    PROFINET_DEVICE_ID    — 16-bit Device ID reported in the Device ID block

Protocol reference: IEC 61158-6-10 (PROFINET DCP), IEC 61784-2. FrameIDs and
block layout also documented in Wireshark's packet-dcp.c dissector.
"""

import logging
import os
import socket
import struct
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-profinet")

DEVICE_ID_LABEL = os.getenv("DEVICE_ID", "profinet-1")
CATEGORY        = os.getenv("DEVICE_CATEGORY", "profinet-device")
IFACE           = os.getenv("PROFINET_IFACE", "eth0")
VENDOR_ID       = int(os.getenv("PROFINET_VENDOR_ID", "42"))
DEVICE_ID_NUM   = int(os.getenv("PROFINET_DEVICE_ID", "1"))
DEFAULT_STATION_NAME = os.getenv("PROFINET_STATION_NAME", "profinet-device-1")

# ── Wire-format constants ─────────────────────────────────────────────────────
ETHERTYPE_PROFINET = 0x8892
DCP_MULTICAST_MAC = bytes.fromhex("010ECF000000")

# DCP FrameIDs (2 bytes, immediately after the Ethernet EtherType)
FRAME_ID_HELLO       = 0xFEFF
FRAME_ID_IDENTIFY_REQ = 0xFEFE
FRAME_ID_IDENTIFY_RSP = 0xFEFD
FRAME_ID_GET_SET     = 0xFEFC

# DCP ServiceID
SVC_GET      = 3
SVC_SET      = 4
SVC_IDENTIFY = 5
SVC_HELLO    = 6

# DCP ServiceType
SVC_TYPE_REQUEST  = 0
SVC_TYPE_RESPONSE = 1

# DCP Option/Suboption pairs implemented here
OPT_IP = 1
SUBOPT_IP_PARAMETER = 2

OPT_DEVICE_PROPERTIES = 2
SUBOPT_NAME_OF_STATION = 1
SUBOPT_DEVICE_ID = 2
SUBOPT_DEVICE_ROLE = 3

OPT_CONTROL = 5
SUBOPT_CONTROL_RESET_FACTORY = 3
SUBOPT_CONTROL_SIGNAL = 4

OPT_ALL_SELECTOR = 0xFF
SUBOPT_ALL_SELECTOR = 0xFF

# ── Device state (mutable via unauthenticated DCP Set — faithful to the real protocol) ──
_state = {
    "station_name": DEFAULT_STATION_NAME,
    "ip": "0.0.0.0",
    "subnet_mask": "255.255.255.0",
    "gateway": "0.0.0.0",
}
_factory_defaults = {}  # captured once at startup, restored by Reset to Factory Settings


def _get_own_mac(iface: str) -> bytes:
    """Reads the interface's MAC address straight from sysfs — no extra deps needed."""
    with open(f"/sys/class/net/{iface}/address", encoding="ascii") as f:
        mac_str = f.read().strip()
    return bytes(int(b, 16) for b in mac_str.split(":"))


def _get_own_ip() -> str:
    """
    Returns the container's primary IPv4 address via the standard UDP-connect
    trick: connect() on a UDP socket only sets local routing state in the
    kernel, it never actually sends a packet on the wire, so this works even
    with an unreachable destination.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "0.0.0.0"
    finally:
        s.close()


def _mac_str(mac: bytes) -> str:
    return ":".join(f"{b:02x}" for b in mac)


# ── DCP block (TLV) encoding ───────────────────────────────────────────────────

def _pack_block(option: int, suboption: int, block_info_or_qualifier: int, data: bytes) -> bytes:
    """
    Packs one DCP block: Option(1) + Suboption(1) + DCPBlockLength(2) +
    BlockInfo/BlockQualifier(2) + data, padded to an even total length.
    DCPBlockLength covers everything after itself (BlockInfo/Qualifier + data).
    """
    body = struct.pack(">H", block_info_or_qualifier) + data
    block = struct.pack(">BBH", option, suboption, len(body)) + body
    if len(block) % 2 != 0:
        block += b"\x00"
    return block


def _build_name_of_station_block() -> bytes:
    return _pack_block(
        OPT_DEVICE_PROPERTIES, SUBOPT_NAME_OF_STATION, 0,
        _state["station_name"].encode("ascii", errors="replace"),
    )


def _build_device_id_block() -> bytes:
    return _pack_block(
        OPT_DEVICE_PROPERTIES, SUBOPT_DEVICE_ID, 0,
        struct.pack(">HH", VENDOR_ID, DEVICE_ID_NUM),
    )


def _build_device_role_block() -> bytes:
    # Role byte 0x01 = IO Device (as opposed to IO Controller/Supervisor).
    return _pack_block(OPT_DEVICE_PROPERTIES, SUBOPT_DEVICE_ROLE, 0, bytes([0x01, 0x00]))


def _build_ip_block() -> bytes:
    data = (
        socket.inet_aton(_state["ip"])
        + socket.inet_aton(_state["subnet_mask"])
        + socket.inet_aton(_state["gateway"])
    )
    return _pack_block(OPT_IP, SUBOPT_IP_PARAMETER, 0, data)


def _all_blocks() -> bytes:
    return (
        _build_name_of_station_block()
        + _build_device_id_block()
        + _build_device_role_block()
        + _build_ip_block()
    )


_BLOCK_BUILDERS = {
    (OPT_DEVICE_PROPERTIES, SUBOPT_NAME_OF_STATION): _build_name_of_station_block,
    (OPT_DEVICE_PROPERTIES, SUBOPT_DEVICE_ID): _build_device_id_block,
    (OPT_DEVICE_PROPERTIES, SUBOPT_DEVICE_ROLE): _build_device_role_block,
    (OPT_IP, SUBOPT_IP_PARAMETER): _build_ip_block,
}


# ── DCP block (TLV) parsing ────────────────────────────────────────────────────

def _parse_get_request_blocks(data: bytes) -> list:
    """Get-request blocks carry no body — just Option(1)+Suboption(1)+Length(2)=0."""
    blocks = []
    pos = 0
    while pos + 4 <= len(data):
        option, suboption, length = struct.unpack_from(">BBH", data, pos)
        pos += 4 + length + (length % 2)
        blocks.append((option, suboption))
    return blocks


def _parse_set_request_blocks(data: bytes) -> list:
    """Set-request blocks carry BlockQualifier(2) + the new value."""
    blocks = []
    pos = 0
    while pos + 4 <= len(data):
        option, suboption, length = struct.unpack_from(">BBH", data, pos)
        pos += 4
        body = data[pos:pos + length]
        pos += length + (length % 2)
        qualifier, block_data = (0, b"") if len(body) < 2 else (
            struct.unpack_from(">H", body, 0)[0], body[2:]
        )
        blocks.append((option, suboption, qualifier, block_data))
    return blocks


# ── Raw Ethernet frame send/receive ────────────────────────────────────────────

_sock: socket.socket
_own_mac: bytes


def _send_dcp_frame(dst_mac: bytes, frame_id: int, service_id: int,
                     service_type: int, xid: int, blocks: bytes) -> None:
    dcp_header = struct.pack(">BBIHH", service_id, service_type, xid, 0, len(blocks))
    eth_payload = struct.pack(">H", frame_id) + dcp_header + blocks
    frame = dst_mac + _own_mac + struct.pack(">H", ETHERTYPE_PROFINET) + eth_payload
    _sock.send(frame)


def _handle_identify(src_mac: bytes, xid: int) -> None:
    log.info("DCP Identify from %s -> responding with full device fingerprint", _mac_str(src_mac))
    _send_dcp_frame(src_mac, FRAME_ID_IDENTIFY_RSP, SVC_IDENTIFY, SVC_TYPE_RESPONSE, xid, _all_blocks())


def _handle_get(src_mac: bytes, xid: int, data: bytes) -> None:
    requested = _parse_get_request_blocks(data)
    if not requested or (OPT_ALL_SELECTOR, SUBOPT_ALL_SELECTOR) in requested:
        response = _all_blocks()
    else:
        response = b"".join(
            _BLOCK_BUILDERS[key]() for key in requested if key in _BLOCK_BUILDERS
        )
    log.info("DCP Get from %s: requested=%s", _mac_str(src_mac), requested or "ALL")
    _send_dcp_frame(src_mac, FRAME_ID_GET_SET, SVC_GET, SVC_TYPE_RESPONSE, xid, response)


def _handle_set(src_mac: bytes, xid: int, data: bytes) -> None:
    applied = _parse_set_request_blocks(data)
    response_blocks = bytearray()

    for option, suboption, _qualifier, value in applied:
        if (option, suboption) == (OPT_DEVICE_PROPERTIES, SUBOPT_NAME_OF_STATION):
            new_name = value.decode("ascii", errors="replace")
            log.warning(
                "UNAUTHENTICATED DCP Set from %s: station renamed '%s' -> '%s'",
                _mac_str(src_mac), _state["station_name"], new_name,
            )
            _state["station_name"] = new_name

        elif (option, suboption) == (OPT_IP, SUBOPT_IP_PARAMETER) and len(value) >= 12:
            new_ip = socket.inet_ntoa(value[0:4])
            new_mask = socket.inet_ntoa(value[4:8])
            new_gw = socket.inet_ntoa(value[8:12])
            log.warning(
                "UNAUTHENTICATED DCP Set from %s: IP reassigned %s -> %s (mask=%s gw=%s)",
                _mac_str(src_mac), _state["ip"], new_ip, new_mask, new_gw,
            )
            _state["ip"], _state["subnet_mask"], _state["gateway"] = new_ip, new_mask, new_gw

        elif (option, suboption) == (OPT_CONTROL, SUBOPT_CONTROL_RESET_FACTORY):
            log.warning("UNAUTHENTICATED DCP Set from %s: Reset to Factory Settings", _mac_str(src_mac))
            _state.update(_factory_defaults)

        elif (option, suboption) == (OPT_CONTROL, SUBOPT_CONTROL_SIGNAL):
            log.info("DCP Set from %s: Flash/Signal requested (no physical LED to flash)", _mac_str(src_mac))

        else:
            log.info("DCP Set from %s: unsupported block option=0x%02x suboption=0x%02x — ignored",
                      _mac_str(src_mac), option, suboption)
            continue

        response_blocks += _pack_block(option, suboption, 0, b"")  # BlockInfo=0 (success)

    _send_dcp_frame(src_mac, FRAME_ID_GET_SET, SVC_SET, SVC_TYPE_RESPONSE, xid, bytes(response_blocks))


def _send_hello() -> None:
    """
    Unsolicited device announcement, sent once at startup — the same frame a
    real IO Device broadcasts on link-up so an engineering tool can discover
    it without sending an explicit Identify request first. Periodic
    re-announcement is omitted (DCP-only scope, not full RT).
    """
    _send_dcp_frame(DCP_MULTICAST_MAC, FRAME_ID_HELLO, SVC_HELLO, SVC_TYPE_REQUEST, 0, _all_blocks())
    log.info("Sent DCP Hello (station=%s)", _state["station_name"])


def main() -> None:
    global _sock, _own_mac

    try:
        _own_mac = _get_own_mac(IFACE)
    except OSError as err:
        log.error("Could not read MAC address for interface %s: %s", IFACE, err)
        sys.exit(1)

    ip = _get_own_ip()
    if ip != "0.0.0.0":
        prefix = ".".join(ip.split(".")[:3])
        _state["ip"] = ip
        _state["gateway"] = f"{prefix}.1"
    _factory_defaults.update(_state)

    log.info(
        "PROFINET DCP device starting -- id=%s  category=%s  iface=%s  mac=%s",
        DEVICE_ID_LABEL, CATEGORY, IFACE, _mac_str(_own_mac),
    )
    log.info("  NameOfStation=%s  VendorID=0x%04x  DeviceID=0x%04x",
              _state["station_name"], VENDOR_ID, DEVICE_ID_NUM)
    log.info("  IP=%s mask=%s gateway=%s", _state["ip"], _state["subnet_mask"], _state["gateway"])

    try:
        _sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETHERTYPE_PROFINET))
        _sock.bind((IFACE, 0))
    except PermissionError:
        log.error(
            "Permission denied opening a raw AF_PACKET socket — this container "
            "needs cap_add: [NET_RAW] (and NET_ADMIN for promiscuous mode)."
        )
        sys.exit(1)

    log.info("Listening for DCP frames on %s (EtherType 0x%04x)", IFACE, ETHERTYPE_PROFINET)
    _send_hello()

    while True:
        frame = _sock.recv(2048)
        if len(frame) < 16:
            continue
        dst_mac = frame[0:6]
        if dst_mac != _own_mac and dst_mac != DCP_MULTICAST_MAC:
            continue  # not addressed to us and not the DCP multicast group

        src_mac = frame[6:12]
        payload = frame[14:]
        frame_id = struct.unpack_from(">H", payload, 0)[0]
        dcp = payload[2:]
        if len(dcp) < 10:
            continue
        service_id, service_type, xid, _resp_delay, data_len = struct.unpack_from(">BBIHH", dcp, 0)
        block_data = dcp[10:10 + data_len]

        if service_type != SVC_TYPE_REQUEST:
            continue  # ignore anything that isn't a request (e.g. our own reflected frames)

        if frame_id == FRAME_ID_IDENTIFY_REQ and service_id == SVC_IDENTIFY:
            _handle_identify(src_mac, xid)
        elif frame_id == FRAME_ID_GET_SET and dst_mac == _own_mac and service_id == SVC_GET:
            _handle_get(src_mac, xid, block_data)
        elif frame_id == FRAME_ID_GET_SET and dst_mac == _own_mac and service_id == SVC_SET:
            _handle_set(src_mac, xid, block_data)
        elif frame_id == FRAME_ID_HELLO and src_mac != _own_mac:
            # Our own Hello (sent at startup) loops back to this same raw socket —
            # AF_PACKET sees everything on the interface, including our own sends.
            log.info("Observed DCP Hello from %s (informational only)", _mac_str(src_mac))


if __name__ == "__main__":
    main()
