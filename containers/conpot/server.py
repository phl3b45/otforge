#!/usr/bin/env python3
"""
server.py — Conpot-inspired legacy ICS device emulator for ICS Simulator.

Implements two legacy OT protocols dispatched by DEVICE_CATEGORY:

  legacy-plc  → Siemens S7 Communication (S7comm) server on port 102
                Transport: ISO-TSAP / RFC 1006 (TPKT) + COTP + S7 PDU
                Emulates a Siemens S7-300 / S7-400 / S7-1200 / S7-1500 CPU.
                Attack tool compatibility:
                  - Nmap: s7-enumerate NSE script (reads SZL 0x001C, 0x0011)
                  - Metasploit: auxiliary/scanner/scada/siemens_simatic_manager
                  - snap7 / python-snap7: Setup Communication handshake
                  - s7scan, PLCScan: COTP fingerprinting

  iec104-rtu  → IEC 60870-5-104 RTU emulator on port 2404
                Transport: TCP with APCI (Application Protocol Control Info)
                Implements IEC 60870-5-104 (ISO 60870-5-101 over TCP/IP)
                Attack tool compatibility:
                  - iec104client (Python iec104 library)
                  - scapy IEC 104 dissector
                  - Nmap: probes port 2404 for valid STARTDT response
                  - Metasploit: IEC 104 interrogation modules

S7comm protocol references:
  RFC 1006 — ISO Transport Service on TCP
  ISO 8073 — Connection-Oriented Transport Protocol (COTP)
  Siemens S7comm protocol (reverse-engineered, Wireshark dissector)
  "The PLC Security Issue" — Klick, Lau, Marzin, Malchow, Roth (S4x14)

IEC 60870-5-104 references:
  IEC 60870-5-104:2006 — Telecontrol Equipment and Systems
  IEC 60870-5-101:2003 — Companion Standard for Basic Telecontrol Tasks
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
log = logging.getLogger("ics-conpot")

# ── Environment configuration ─────────────────────────────────────────────────

DEVICE_ID    = os.getenv("DEVICE_ID", "device-1")
CATEGORY     = os.getenv("DEVICE_CATEGORY", "legacy-plc")

# S7comm settings
S7_TYPE      = os.getenv("S7_DEVICE_TYPE", "300")
S7_PORT      = int(os.getenv("S7_PORT", "102"))

# IEC 104 settings
IEC104_CA    = int(os.getenv("IEC104_COMMON_ADDRESS", "1"))
IEC104_PORT  = int(os.getenv("IEC104_PORT", "2404"))

# ── S7 device identity database ────────────────────────────────────────────────

# Maps S7_DEVICE_TYPE → (order_number, module_name, plant_id, firmware_version)
# Order numbers are real Siemens part numbers — this is what Nmap / Metasploit
# display after a successful enumeration scan.
S7_PROFILES = {
    "300": {
        "order":    "6ES7 315-2EH14-0AB0",
        "module":   "CPU 315-2 PN/DP",
        "plant_id": "ICS-SIM-OT-1",
        "firmware": (3, 3),     # version 3.3 (V3.3)
    },
    "400": {
        "order":    "6ES7 412-2XJ05-0AB0",
        "module":   "CPU 412-2 PN",
        "plant_id": "ICS-SIM-OT-1",
        "firmware": (7, 0),     # version 7.0
    },
    "1200": {
        "order":    "6ES7 214-1AG40-0XB0",
        "module":   "CPU 1214C DC/DC/DC",
        "plant_id": "ICS-SIM-OT-1",
        "firmware": (4, 4),     # firmware V4.4
    },
    "1500": {
        "order":    "6ES7 513-1AL02-0AB0",
        "module":   "CPU 1513-1 PN",
        "plant_id": "ICS-SIM-OT-1",
        "firmware": (3, 0),     # firmware V3.0
    },
}

# ── S7comm TPKT / COTP helpers ────────────────────────────────────────────────

def tpkt(payload: bytes) -> bytes:
    """
    Wraps payload in an RFC 1006 TPKT header.

    TPKT format (4 bytes):
      byte 0: version = 0x03
      byte 1: reserved = 0x00
      bytes 2–3: total packet length (big-endian, includes the 4-byte header)

    All S7comm communication rides inside TPKT frames on port 102.
    """
    total = len(payload) + 4
    return bytes([0x03, 0x00, total >> 8, total & 0xFF]) + payload


def cotp_dt(payload: bytes) -> bytes:
    """
    Wraps payload in a COTP Data Transfer (DT) header.

    COTP DT format:
      byte 0: header length = 0x02 (not including the length byte itself)
      byte 1: PDU type = 0xF0 (Data Transfer)
      byte 2: 0x80  (EOT=1 end-of-TPDU, TPDU-NR sequence number = 0)

    The S7 PDU follows immediately after this 3-byte header.
    """
    return bytes([0x02, 0xF0, 0x80]) + payload


def build_s7_ack(pdu_ref: int, params: bytes, data: bytes = b"") -> bytes:
    """
    Builds an S7 ack-data PDU (type 3 = acknowledge + data) and wraps it in
    TPKT + COTP DT for transmission.

    S7 header for ack-data (12 bytes):
      32           — protocol ID (always 0x32)
      03           — PDU type: ack-data
      00 00        — reserved
      ref_hi ref_lo — PDU reference (echo from request)
      pl_hi pl_lo  — parameter length
      dl_hi dl_lo  — data length
      00 00        — error class + error code (no error)

    @param pdu_ref - PDU reference number to echo back (identifies the request).
    @param params  - S7 parameter bytes (e.g., function 0xF0 for Setup Comm).
    @param data    - S7 data bytes (e.g., SZL data block).
    """
    hdr = bytes([
        0x32, 0x03, 0x00, 0x00,
        (pdu_ref >> 8) & 0xFF, pdu_ref & 0xFF,
        (len(params) >> 8) & 0xFF, len(params) & 0xFF,
        (len(data) >> 8) & 0xFF, len(data) & 0xFF,
        0x00, 0x00,  # no error
    ])
    return tpkt(cotp_dt(hdr + params + data))


def build_s7_userdata_response(pdu_ref: int, szl_data: bytes) -> bytes:
    """
    Builds an S7 userdata PDU (type 7) carrying an SZL read response.

    S7 userdata PDUs are used for diagnostic/system functions not covered by
    the standard read/write PDU types. The structure differs from type 3:

    S7 header for userdata (10 bytes):
      32 07 00 00 [ref] [param_len] [data_len]
      (no error class/code field)

    Parameters (12 bytes for SZL response):
      00 01 12 08  — subfunction descriptor
      12 84 01 00  — function 0x12=SZL read, 0x84=response, seq=1, last=0
      [data_len 2 bytes]

    Data:
      FF 09 [data_len 2 bytes] [szl_data]
      FF = transport status (OK), 09 = OCTETs transport

    @param pdu_ref  - PDU reference to echo back.
    @param szl_data - SZL response data block bytes.
    """
    data_len = len(szl_data)
    # Parameter block for userdata SZL response (12 bytes)
    params = bytes([
        0x00, 0x01, 0x12, 0x08,
        0x12, 0x84, 0x01, 0x00,
        (data_len >> 8) & 0xFF, data_len & 0xFF,
        0x00, 0x00,
    ])
    # Data block: transport descriptor + SZL payload
    data = bytes([
        0xFF, 0x09,
        (data_len >> 8) & 0xFF, data_len & 0xFF,
    ]) + szl_data

    hdr = bytes([
        0x32, 0x07, 0x00, 0x00,
        (pdu_ref >> 8) & 0xFF, pdu_ref & 0xFF,
        (len(params) >> 8) & 0xFF, len(params) & 0xFF,
        (len(data) >> 8) & 0xFF, len(data) & 0xFF,
    ])
    return tpkt(cotp_dt(hdr + params + data))


def build_s7_error(pdu_ref: int, err_class: int = 0x81, err_code: int = 0x04) -> bytes:
    """
    Builds an S7 error response PDU (type 3, non-zero error class/code).

    Used to reject requests for unsupported functions or out-of-range addresses.
    Common error codes:
      err_class=0x81 (Application error), err_code=0x04 = item not supported
      err_class=0x80 (Hardware fault),    err_code=0x01 = hardware fault

    @param pdu_ref   - PDU reference to echo.
    @param err_class - S7 error class (default 0x81 = application error).
    @param err_code  - S7 error code (default 0x04 = function not available).
    """
    hdr = bytes([
        0x32, 0x03, 0x00, 0x00,
        (pdu_ref >> 8) & 0xFF, pdu_ref & 0xFF,
        0x00, 0x00,  # param_len = 0
        0x00, 0x00,  # data_len  = 0
        err_class, err_code,
    ])
    return tpkt(cotp_dt(hdr))


# ── S7 SZL (System Status List) data builders ─────────────────────────────────

def build_szl_0011(profile: dict) -> bytes:
    """
    Builds the SZL-ID 0x0011 (Module Identification) data block.

    This is the primary fingerprinting sublist queried by Nmap s7-enumerate
    and Metasploit siemens_simatic_manager. It contains the Siemens order
    number (part number), which uniquely identifies the CPU model family.

    SZL-0011 block layout:
      szl_id:    2 bytes — 0x00 0x11
      szl_index: 2 bytes — 0x00 0x01
      n:         2 bytes — number of data records (1)
      dr_len:    2 bytes — bytes per record (28)
      Record:
        order_number: 20 bytes ASCII, space-padded
        reserved:     4 bytes 0x00
        hw_version:   2 bytes
        fw_version:   2 bytes
    """
    order = profile["order"].encode("ascii").ljust(20)[:20]
    fwv   = profile["firmware"]
    record = order + b"\x00" * 4 + bytes([0x01, 0x00, fwv[0], fwv[1]])
    return bytes([0x00, 0x11, 0x00, 0x01, 0x00, 0x01, 0x00, 0x1C]) + record


def build_szl_001c(profile: dict) -> bytes:
    """
    Builds the SZL-ID 0x001C (Component Identification) data block.

    Contains the automation system (plant) name, module name, serial number,
    and manufacturer/plant location. Nmap's s7-enumerate reads this sublist
    to report the plant_id, module name, and system description.

    SZL-001C block layout per record (same header as 0x0011):
      Index 1: automation system name (plant_id)
      Index 2: module name / type identifier
      Index 3: plant identification string (location)
      Index 4: copyright string

    We return index 1 (automation system name) only.
    """
    plant  = profile["plant_id"].encode("ascii").ljust(24)[:24]
    module = profile["module"].encode("ascii").ljust(24)[:24]
    # Record = 24-byte string + 8 reserved bytes = 32 bytes
    record1 = plant + b"\x00" * 8
    record2 = module + b"\x00" * 8
    n_records = 2
    dr_len = 32
    header = bytes([0x00, 0x1C, 0x00, 0x01,
                    (n_records >> 8) & 0xFF, n_records & 0xFF,
                    (dr_len >> 8) & 0xFF, dr_len & 0xFF])
    return header + record1 + record2


# ── S7comm connection handler ─────────────────────────────────────────────────

async def handle_s7_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    profile: dict,
) -> None:
    """
    Handles one S7comm TCP connection from a master/client.

    Session state machine:
      1. Wait for TPKT + COTP Connection Request (CR) → send Connection Confirm (CC)
      2. Wait for TPKT + COTP DT + S7 Setup Communication request → respond
      3. Loop: process S7 PDUs (userdata SZL reads, read-variable requests, etc.)

    The connection is kept open until the client closes it or an I/O error occurs.
    Real PLCs hold connections open for long durations — this behavior is authentic.

    @param reader  - asyncio StreamReader for the accepted TCP connection.
    @param writer  - asyncio StreamWriter for the accepted TCP connection.
    @param profile - S7 device profile dict (order number, module name, etc.).
    """
    peer = writer.get_extra_info("peername")
    log.info("S7comm client connected from %s", peer)
    connected = False

    try:
        while True:
            # ── Read TPKT header (4 bytes) ────────────────────────────────────
            try:
                hdr = await asyncio.wait_for(reader.readexactly(4), timeout=60)
            except asyncio.TimeoutError:
                log.info("S7comm client %s timed out", peer)
                break
            except asyncio.IncompleteReadError:
                log.info("S7comm client %s disconnected", peer)
                break

            if hdr[0] != 0x03:
                # Not a TPKT frame — discard and wait for re-sync
                log.warning("Non-TPKT byte 0x%02X from %s, discarding", hdr[0], peer)
                continue

            total_len = (hdr[2] << 8) | hdr[3]
            payload_len = total_len - 4
            if payload_len <= 0:
                continue

            payload = await asyncio.wait_for(reader.readexactly(payload_len), timeout=10)

            # ── COTP header ───────────────────────────────────────────────────
            # payload[0] = COTP header length (bytes that follow, not including itself)
            # payload[1] = COTP PDU type
            if len(payload) < 2:
                continue

            cotp_pdu_type = payload[1]

            if cotp_pdu_type == 0xE0 and not connected:
                # ── COTP Connection Request → send Connection Confirm ──────────
                # The CC mirrors the CR: swap dst/src references, keep TSAP params.
                # dst-ref in CC = src-ref from CR (bytes 4-5 of COTP variable part)
                cotp_hdr_len = payload[0]

                # Extract src-ref from the CR (bytes 2-3 of the variable header,
                # which is payload bytes 4-5 when base header occupies bytes 0-3).
                src_ref = (payload[2] << 8) | payload[3]   # CR dst-ref
                dst_ref = (payload[4] << 8) | payload[5]   # CR src-ref → becomes our dst

                # Build CC with identical TSAP parameters, just swapping PDU type
                # and exchanging src/dst references.
                cc_cotp = bytes([
                    0x11,           # COTP header length = 17
                    0xD0,           # PDU type: CC
                    (dst_ref >> 8) & 0xFF, dst_ref & 0xFF,   # dst-ref
                    0x00, 0x01,     # src-ref
                    0x00,           # class + option
                    0xC0, 0x01, 0x0A,       # TPDU-size = 1024
                    0xC1, 0x02, 0x01, 0x00,  # src TSAP
                    0xC2, 0x02, 0x01, 0x02,  # dst TSAP (rack 0, slot 2)
                ])
                writer.write(tpkt(cc_cotp))
                await writer.drain()
                connected = True
                log.info("S7comm connection established for %s (S7-%s)", peer, S7_TYPE)

            elif cotp_pdu_type == 0xF0 and connected:
                # ── COTP DT — extract and process S7 PDU ──────────────────────
                # COTP DT header is 3 bytes: len(1) + type(1) + seq(1)
                # S7 PDU starts at payload[3]
                if len(payload) < 4:
                    continue
                s7_pdu = payload[3:]
                if len(s7_pdu) < 10:
                    continue

                # S7 header fields
                # s7_pdu[0] = 0x32 (protocol ID)
                # s7_pdu[1] = PDU type (1=req, 3=ack, 7=userdata)
                # s7_pdu[4:6] = PDU reference
                if s7_pdu[0] != 0x32:
                    continue

                s7_type = s7_pdu[1]
                pdu_ref = (s7_pdu[4] << 8) | s7_pdu[5]
                param_len = (s7_pdu[6] << 8) | s7_pdu[7]
                params = s7_pdu[10 : 10 + param_len] if len(s7_pdu) >= 10 + param_len else b""

                # ── PDU type 1: Request ───────────────────────────────────────
                if s7_type == 0x01 and params:
                    fn = params[0]

                    if fn == 0xF0:
                        # Setup Communication — negotiate MaxAMQ and PDU length.
                        # We accept whatever the client proposes and respond with
                        # our own limits. Real S7-300 CPUs use PDU length 240.
                        resp_params = bytes([0xF0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0xF0])
                        writer.write(build_s7_ack(pdu_ref, resp_params))
                        await writer.drain()
                        log.info("S7 Setup Comm handshake complete for %s", peer)

                    elif fn == 0x04:
                        # Read Variable (FC 0x04) — return zeros for all requested items.
                        # This prevents snap7 from crashing when it probes memory areas.
                        # A real implementation would return actual data block contents;
                        # for a honeypot/simulator, zeros suffice for connectivity testing.
                        item_count = params[1] if len(params) > 1 else 1
                        data_items = b""
                        for _ in range(item_count):
                            # Return success (0xFF), data type BYTE (0x04),
                            # length 2 bytes (16 bits), value 0x0000
                            data_items += bytes([0xFF, 0x04, 0x00, 0x10, 0x00, 0x00])
                        resp_params = bytes([0x04, item_count])
                        writer.write(build_s7_ack(pdu_ref, resp_params, data_items))
                        await writer.drain()

                    else:
                        # Unknown function — return application error
                        writer.write(build_s7_error(pdu_ref))
                        await writer.drain()

                # ── PDU type 7: Userdata (SZL reads, diagnostic functions) ────
                elif s7_type == 0x07 and len(params) >= 4:
                    # params[2] = subfunction (0x12 = SZL read/write)
                    # params[4] = function group (0x11 = SZL)
                    # Userdata data starts after the S7 header (10 bytes) + params
                    data_start = 10 + param_len
                    ud_data = s7_pdu[data_start:] if len(s7_pdu) > data_start else b""

                    # SZL read request: ud_data = FF 09 00 04 [szl_id 2B] [szl_index 2B]
                    if len(ud_data) >= 8 and ud_data[0] == 0xFF:
                        szl_id    = (ud_data[4] << 8) | ud_data[5]
                        # szl_index = (ud_data[6] << 8) | ud_data[7]  # not needed for response

                        if szl_id == 0x0011:
                            szl_block = build_szl_0011(profile)
                        elif szl_id == 0x001C:
                            szl_block = build_szl_001c(profile)
                        else:
                            # Unsupported SZL ID — return function-not-available error.
                            # Many S7 controllers return this for unlicensed sublists;
                            # it is not considered an emulation failure.
                            writer.write(build_s7_error(pdu_ref, 0x81, 0x04))
                            await writer.drain()
                            continue

                        writer.write(build_s7_userdata_response(pdu_ref, szl_block))
                        await writer.drain()
                        log.info("SZL 0x%04X response sent to %s", szl_id, peer)
                    else:
                        writer.write(build_s7_error(pdu_ref))
                        await writer.drain()
                else:
                    # Unrecognised PDU type — silently drop
                    pass

    except asyncio.IncompleteReadError:
        log.info("S7comm client %s disconnected", peer)
    except Exception as exc:
        log.warning("S7comm handler error for %s: %s", peer, exc)
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


# ── IEC 60870-5-104 helpers ───────────────────────────────────────────────────

# U-frame control field values (4 bytes, type=11 in bits 1-0)
_STARTDT_ACT = bytes([0x07, 0x00, 0x00, 0x00])
_STARTDT_CON = bytes([0x0B, 0x00, 0x00, 0x00])
_STOPDT_ACT  = bytes([0x13, 0x00, 0x00, 0x00])
_STOPDT_CON  = bytes([0x23, 0x00, 0x00, 0x00])
_TESTFR_ACT  = bytes([0x43, 0x00, 0x00, 0x00])
_TESTFR_CON  = bytes([0x83, 0x00, 0x00, 0x00])


def apci(control: bytes, asdu: bytes = b"") -> bytes:
    """
    Builds an IEC 104 APCI (Application Protocol Control Information) frame.

    APCI format:
      byte 0: 0x68  — start byte (always)
      byte 1: APDU length (bytes that follow, not including start+length bytes)
      bytes 2–5: control field (4 bytes)
      bytes 6+: ASDU (optional, only for I-frames)

    @param control - 4-byte control field (I/S/U frame encoding).
    @param asdu    - Application Service Data Unit (empty for S and U frames).
    """
    body = control + asdu
    return bytes([0x68, len(body)]) + body


def build_iec104_asdu(
    type_id: int,
    cot: int,
    common_addr: int,
    objects: list[tuple[int, bytes]],
) -> bytes:
    """
    Builds an IEC 60870-5-104 ASDU (Application Service Data Unit).

    ASDU structure:
      Type ID:    1 byte — identifies the information object type
      VSQ:        1 byte — Variable Structure Qualifier
                    bit 7: SQ=0 (non-sequential information object addresses)
                    bits 6-0: number of information objects
      COT:        2 bytes — Cause of Transmission
                    byte 1: COT value (3=spontaneous, 7=ACT_CON, 10=ACT_TERM, etc.)
                    byte 2: originator address (0)
      CA:         2 bytes — Common Address (little-endian)
      Objects:    repeated (IOA: 3 bytes LE + value bytes)

    @param type_id     - ASDU type identifier (e.g., 13 for M_ME_NC_1 floating point).
    @param cot         - Cause of transmission code.
    @param common_addr - ASDU common address (identifies the RTU).
    @param objects     - List of (IOA, value_bytes) tuples.
    """
    n = len(objects)
    vsq = n & 0x7F   # SQ=0, count=n
    header = bytes([
        type_id,
        vsq,
        cot & 0xFF, 0x00,            # COT low byte, originator address
        common_addr & 0xFF, (common_addr >> 8) & 0xFF,  # CA little-endian
    ])
    body = bytearray()
    for ioa, val in objects:
        # IOA: 3 bytes little-endian
        body += bytes([ioa & 0xFF, (ioa >> 8) & 0xFF, (ioa >> 16) & 0xFF])
        body += val
    return header + bytes(body)


def build_m_me_nc_1(value: float, quality: int = 0x00) -> bytes:
    """
    Builds the value bytes for a single M_ME_NC_1 object (Type 13 — measured value,
    short floating point, no timestamp).

    Structure: quality descriptor (1 byte) + IEEE 754 float (4 bytes, little-endian).
    Quality flags: 0x00 = valid (OV=0, BL=0, SB=0, NT=0, IV=0).

    @param value   - Floating-point process value (e.g., 101.3 for pressure in kPa).
    @param quality - Quality descriptor byte (default 0x00 = no error flags set).
    """
    return bytes([quality]) + struct.pack("<f", value)


# ── IEC 104 process values (simulated RTU data points) ────────────────────────

# Each entry: (Information Object Address, description, initial value, drift range)
# These are the "process image" that the RTU reports to the SCADA master.
_IEC104_POINTS: list[dict] = [
    {"ioa": 1,  "desc": "Power output kW",      "value": 4500.0,  "drift": 50.0},
    {"ioa": 2,  "desc": "Grid frequency Hz",     "value": 50.02,   "drift": 0.02},
    {"ioa": 3,  "desc": "Voltage L1 V",          "value": 230.8,   "drift": 1.5},
    {"ioa": 4,  "desc": "Line current A",        "value": 19.6,    "drift": 0.3},
    {"ioa": 5,  "desc": "Active power factor",   "value": 0.97,    "drift": 0.01},
    {"ioa": 6,  "desc": "Tap position",          "value": 3.0,     "drift": 0.0},
    {"ioa": 7,  "desc": "Reactive power kVAR",   "value": 420.0,   "drift": 5.0},
    {"ioa": 8,  "desc": "Station temp °C",       "value": 22.5,    "drift": 0.5},
]


async def drift_iec104_values() -> None:
    """
    Background task that drifts IEC 104 process values every 3 seconds to simulate
    realistic telemetry variation. Values are bounded to physically plausible ranges.
    """
    while True:
        await asyncio.sleep(3)
        for pt in _IEC104_POINTS:
            if pt["drift"] > 0:
                pt["value"] += random.uniform(-pt["drift"], pt["drift"])
                # Keep values positive and within a reasonable range
                pt["value"] = max(0.0, min(pt["value"], pt["value"] * 2 + 1.0))


# ── IEC 104 connection handler ─────────────────────────────────────────────────

async def handle_iec104_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    common_addr: int,
) -> None:
    """
    Handles one IEC 60870-5-104 TCP connection from a control station (master).

    IEC 104 session lifecycle:
      1. Master sends STARTDT ACT (U-frame) to begin data transfer
      2. RTU responds with STARTDT CON — data transfer is now active
      3. Master may send TESTFR ACT to verify the link is alive
         RTU responds with TESTFR CON
      4. Master sends General Interrogation (type 100, COT=6 Activation)
         RTU responds: ACT_CON → data objects → ACT_TERM
      5. RTU sends spontaneous updates (cyclic, type 13 float values)
      6. Master sends STOPDT ACT when done — RTU responds STOPDT CON

    Send/receive sequence numbers (VSS/VRS) are simplified here: I-frames use
    sequence number 0 for all transmissions, which is acceptable for a single-
    connection honeypot but would not pass conformance testing.

    @param reader      - asyncio StreamReader for the accepted TCP connection.
    @param writer      - asyncio StreamWriter for the accepted TCP connection.
    @param common_addr - ASDU Common Address for this RTU (from env IEC104_COMMON_ADDRESS).
    """
    peer = writer.get_extra_info("peername")
    log.info("IEC 104 client connected from %s", peer)
    data_transfer_active = False

    async def send_spontaneous_updates() -> None:
        """Sends all 8 process values as an unprompted update every 10 seconds."""
        while data_transfer_active:
            await asyncio.sleep(10)
            if not data_transfer_active:
                break
            try:
                objects = [
                    (pt["ioa"], build_m_me_nc_1(pt["value"])) for pt in _IEC104_POINTS
                ]
                asdu = build_iec104_asdu(13, 1, common_addr, objects)  # COT=1 (cyclic)
                frame = apci(bytes([0x00, 0x00, 0x00, 0x00]), asdu)   # I-frame seq=0
                writer.write(frame)
                await writer.drain()
            except Exception:
                break

    spontaneous_task: asyncio.Task | None = None

    try:
        while True:
            # ── Read APCI header (6 bytes) ────────────────────────────────────
            try:
                hdr = await asyncio.wait_for(reader.readexactly(2), timeout=60)
            except asyncio.TimeoutError:
                log.info("IEC 104 client %s timed out", peer)
                break
            except asyncio.IncompleteReadError:
                break

            if hdr[0] != 0x68:
                log.warning("IEC 104: unexpected start byte 0x%02X from %s", hdr[0], peer)
                continue

            apdu_len = hdr[1]
            if apdu_len < 4:
                continue

            body = await asyncio.wait_for(reader.readexactly(apdu_len), timeout=10)
            control = body[:4]

            # ── U-frame detection: bits 1-0 of control[0] = 11 (0x03) ────────
            if (control[0] & 0x03) == 0x03:
                if control == _STARTDT_ACT:
                    writer.write(apci(_STARTDT_CON))
                    await writer.drain()
                    data_transfer_active = True
                    log.info("IEC 104 STARTDT: data transfer active for %s", peer)
                    # Start background spontaneous update task
                    if spontaneous_task is None or spontaneous_task.done():
                        spontaneous_task = asyncio.ensure_future(send_spontaneous_updates())

                elif control == _STOPDT_ACT:
                    writer.write(apci(_STOPDT_CON))
                    await writer.drain()
                    data_transfer_active = False
                    log.info("IEC 104 STOPDT: data transfer stopped for %s", peer)

                elif control == _TESTFR_ACT:
                    writer.write(apci(_TESTFR_CON))
                    await writer.drain()

            # ── I-frame: bit 0 of control[0] = 0 ─────────────────────────────
            elif (control[0] & 0x01) == 0x00 and len(body) > 4:
                asdu_bytes = body[4:]
                if len(asdu_bytes) < 6:
                    continue

                type_id = asdu_bytes[0]
                cot     = asdu_bytes[2] & 0x3F

                # ── General Interrogation (type 100 = C_IC_NA_1, COT=6 ACT) ──
                if type_id == 100 and cot == 6:
                    # Step 1: Activation Confirmation (COT=7 = ACT_CON)
                    ack_asdu = build_iec104_asdu(100, 7, common_addr,
                                                 [(0, bytes([0x14]))])  # QOI=20 = station
                    writer.write(apci(bytes([0x00, 0x00, 0x00, 0x00]), ack_asdu))
                    await writer.drain()

                    # Step 2: Send all current process values (COT=20 = inrogen station)
                    objects = [
                        (pt["ioa"], build_m_me_nc_1(pt["value"])) for pt in _IEC104_POINTS
                    ]
                    data_asdu = build_iec104_asdu(13, 20, common_addr, objects)
                    writer.write(apci(bytes([0x00, 0x00, 0x00, 0x00]), data_asdu))
                    await writer.drain()

                    # Step 3: Activation Termination (COT=10 = ACT_TERM)
                    term_asdu = build_iec104_asdu(100, 10, common_addr,
                                                  [(0, bytes([0x14]))])
                    writer.write(apci(bytes([0x00, 0x00, 0x00, 0x00]), term_asdu))
                    await writer.drain()
                    log.info("IEC 104 General Interrogation completed for %s (%d objects)",
                             peer, len(objects))

    except asyncio.IncompleteReadError:
        log.info("IEC 104 client %s disconnected", peer)
    except Exception as exc:
        log.warning("IEC 104 handler error for %s: %s", peer, exc)
    finally:
        data_transfer_active = False
        if spontaneous_task and not spontaneous_task.done():
            spontaneous_task.cancel()
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


# ── Main ───────────────────────────────────────────────────────────────────────

async def main() -> None:
    """
    Starts the appropriate protocol server based on DEVICE_CATEGORY.

    legacy-plc:  S7comm server on S7_PORT (default 102)
    iec104-rtu:  IEC 60870-5-104 server on IEC104_PORT (default 2404)

    Also launches the IEC 104 background value-drift task before serving.
    """
    if CATEGORY == "legacy-plc":
        profile = S7_PROFILES.get(S7_TYPE, S7_PROFILES["300"])
        log.info(
            "Device=%s  S7-%s  order=%s  module=%s  port=%d",
            DEVICE_ID, S7_TYPE, profile["order"], profile["module"], S7_PORT,
        )
        server = await asyncio.start_server(
            lambda r, w: handle_s7_client(r, w, profile),
            "0.0.0.0", S7_PORT,
        )
        log.info("S7comm server listening on port %d", S7_PORT)
        async with server:
            await server.serve_forever()

    elif CATEGORY == "iec104-rtu":
        asyncio.ensure_future(drift_iec104_values())
        log.info(
            "Device=%s  IEC-104  common_addr=%d  port=%d  data_points=%d",
            DEVICE_ID, IEC104_CA, IEC104_PORT, len(_IEC104_POINTS),
        )
        server = await asyncio.start_server(
            lambda r, w: handle_iec104_client(r, w, IEC104_CA),
            "0.0.0.0", IEC104_PORT,
        )
        log.info("IEC 104 server listening on port %d", IEC104_PORT)
        async with server:
            await server.serve_forever()

    else:
        log.error(
            "Unknown DEVICE_CATEGORY=%r  (expected 'legacy-plc' or 'iec104-rtu'). Exiting.",
            CATEGORY,
        )


if __name__ == "__main__":
    asyncio.run(main())
