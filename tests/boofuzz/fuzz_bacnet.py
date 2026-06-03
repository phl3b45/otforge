"""
fuzz_bacnet.py - Boofuzz BACnet/IP UDP fuzzer for OTForge Phase 7 testing.

Targets the bacpypes3 BACnet/IP server running on sensor devices (port 47808 UDP).
Fuzzes BVLC headers, NPDU fields, and APDU service types to find crashes or
unexpected behavior in the BACnet stack.

Usage (from inside Kali container):
    pip install boofuzz
    python3 fuzz_bacnet.py [SENSOR_IP]

Arguments:
    SENSOR_IP - IP of the BACnet sensor container (default: 10.200.10.20)
                Override by passing as first positional arg or setting SENSOR_IP env var.

Results are written to ./boofuzz-results/bacnet/ and printed to stdout.

BACnet/IP frame layout:
  [BVLC Type: 1B 0x81] [BVLC Function: 1B] [BVLC Length: 2B]
  [NPDU Version: 1B 0x01] [NPDU Control: 1B]
  [APDU Type+Flags: 1B] [Service Choice: 1B] [Service Data: NB]
"""

import os
import sys
from boofuzz import Session, Target, UDPSocketConnection
from boofuzz import s_initialize, s_block, s_byte, s_word, s_string, s_static, s_get


SENSOR_IP   = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SENSOR_IP", "10.200.10.20")
TARGET_PORT = 47808  # BACnet/IP standard port


def build_bacnet_requests():
    """Define fuzz cases for BACnet/IP APDU types.

    BVLC function codes:
      0x0A = Original-Unicast-NPDU (most common for direct device communication)
      0x04 = Forwarded-NPDU
      0x0B = Original-Broadcast-NPDU

    APDU type nibble (high 4 bits of first APDU byte):
      0x0_ = Confirmed-Request
      0x1_ = Unconfirmed-Request
      0x2_ = Simple-ACK
      0x3_ = Complex-ACK
      0x5_ = Error
      0x6_ = Reject
      0x7_ = Abort

    Unconfirmed service choices of interest:
      0x00 = I-Am
      0x08 = Who-Is  (discovery — safe to fuzz heavily)
      0x0B = Unconfirmed-COV-Notification
    """

    # Fuzz Who-Is broadcast (safe discovery request — any device must respond)
    s_initialize("who_is")
    with s_block("bvlc"):
        s_byte(0x81, name="bvlc_type",     fuzzable=False)  # always 0x81 for BACnet/IP
        s_byte(0x0B, name="bvlc_function", fuzzable=True)   # broadcast function
        s_word(0x000C, name="bvlc_length", fuzzable=True, endian=">")
    with s_block("npdu"):
        s_byte(0x01, name="npdu_version",  fuzzable=False)  # always 1
        s_byte(0x20, name="npdu_control",  fuzzable=True)   # fuzz control flags
    with s_block("apdu"):
        s_byte(0x10, name="apdu_type",     fuzzable=True)   # 0x1X = Unconfirmed-Request
        s_byte(0x08, name="service_choice",fuzzable=True)   # Who-Is = 0x08
        # Who-Is range (optional context tags) — fuzz with random data
        s_string("", name="service_data", max_len=64)

    # Fuzz Confirmed ReadProperty request (reads object properties)
    s_initialize("read_property")
    with s_block("bvlc"):
        s_byte(0x81, name="bvlc_type",     fuzzable=False)
        s_byte(0x0A, name="bvlc_function", fuzzable=True)
        s_word(0x0011, name="bvlc_length", fuzzable=True, endian=">")
    with s_block("npdu"):
        s_byte(0x01, name="npdu_version",  fuzzable=False)
        s_byte(0x04, name="npdu_control",  fuzzable=True)
    with s_block("apdu"):
        s_byte(0x00, name="apdu_type",     fuzzable=True)   # 0x0X = Confirmed-Request
        s_byte(0x00, name="max_segments",  fuzzable=True)   # max segments/response
        s_byte(0x0C, name="service_choice",fuzzable=True)   # ReadProperty = 0x0C
        s_byte(0x00, name="invoke_id",     fuzzable=True)
        # Object identifier context tag 0 — fuzz object type and instance
        s_static(b'\x0c')                                   # context tag 0, length 4
        s_dword(0x00C00001, name="object_id", fuzzable=True, endian=">")
        # Property identifier context tag 1
        s_static(b'\x19')                                   # context tag 1, length 1
        s_byte(0x55, name="property_id",   fuzzable=True)   # 0x55 = Present-Value

    # Fuzz BVLC type and function with fixed valid NPDU/APDU
    s_initialize("fuzz_bvlc")
    with s_block("bvlc"):
        s_byte(0x81, name="bvlc_type",     fuzzable=True)   # fuzz the type byte too
        s_byte(0x0A, name="bvlc_function", fuzzable=True)
        s_word(0x000C, name="bvlc_length", fuzzable=True, endian=">")
    # Fixed minimal NPDU + Who-Is APDU after fuzzed BVLC
    s_static(b'\x01\x00\x10\x08')


def main():
    print(f"[*] BACnet/IP UDP fuzzer -> {SENSOR_IP}:{TARGET_PORT}")
    print("[*] Results in ./boofuzz-results/bacnet/")
    print("[*] Ctrl+C to stop\n")

    build_bacnet_requests()

    session = Session(
        target=Target(
            connection=UDPSocketConnection(SENSOR_IP, TARGET_PORT)
        ),
        sleep_time=0.05,
        restart_sleep_time=5,
        db_filename="./boofuzz-results/bacnet/fuzz.db"
    )

    session.connect(s_get("who_is"))
    session.connect(s_get("read_property"))
    session.connect(s_get("fuzz_bvlc"))

    session.fuzz()


if __name__ == "__main__":
    import pathlib
    pathlib.Path("./boofuzz-results/bacnet").mkdir(parents=True, exist_ok=True)
    main()
