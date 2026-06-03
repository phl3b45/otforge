"""
fuzz_modbus.py - Boofuzz Modbus TCP fuzzer for OTForge Phase 7 testing.

Targets the OpenPLC Runtime Modbus TCP server on port 502.
Fuzzes MBAP header fields and PDU function codes / data to find crashes,
hangs, or unexpected responses that could indicate vulnerabilities.

Usage (from inside Kali container):
    pip install boofuzz
    python3 fuzz_modbus.py

Environment variables (auto-set by compose-generator):
    PLC_IP    - IP address of the OpenPLC container (default: 10.200.10.10)
    PLC_PORT  - Modbus TCP port (default: 502)

Results are written to ./boofuzz-results/modbus/ and printed to stdout.
Watch Suricata/Zeek logs during fuzzing for unexpected alerts.
"""

import os
from boofuzz import Session, Target, TCPSocketConnection
from boofuzz import s_initialize, s_block, s_byte, s_word, s_dword, s_string, s_static, s_get

TARGET_IP   = os.environ.get("PLC_IP",   "10.200.10.10")
TARGET_PORT = int(os.environ.get("PLC_PORT", "502"))

def build_modbus_requests():
    """Define fuzz cases for Modbus TCP PDU types.

    Modbus TCP frame layout:
      [Transaction ID: 2B] [Protocol ID: 2B] [Length: 2B] [Unit ID: 1B] [Function Code: 1B] [Data: NB]

    We fuzz all mutable fields. Protocol ID is left at 0x0000 (required by spec)
    so the server stays in Modbus parsing mode; fuzzing it separately would just
    cause the server to drop frames before reaching the PDU.
    """

    # FC01 - Read Coils (the function used in the tutorial attack)
    s_initialize("fc01_read_coils")
    with s_block("mbap"):
        s_word(0x0001, name="transaction_id", fuzzable=True, endian=">")
        s_word(0x0000, name="protocol_id",    fuzzable=False, endian=">")
        s_word(0x0006, name="length",         fuzzable=True,  endian=">")
        s_byte(0x01,   name="unit_id",        fuzzable=True)
    with s_block("pdu"):
        s_byte(0x01,   name="function_code",  fuzzable=False)  # FC01 fixed
        s_word(0x0000, name="start_address",  fuzzable=True,  endian=">")
        s_word(0x0001, name="quantity",       fuzzable=True,  endian=">")

    # FC05 - Write Single Coil (the actual attack vector)
    s_initialize("fc05_write_coil")
    with s_block("mbap"):
        s_word(0x0001, name="transaction_id", fuzzable=True, endian=">")
        s_word(0x0000, name="protocol_id",    fuzzable=False, endian=">")
        s_word(0x0006, name="length",         fuzzable=True,  endian=">")
        s_byte(0x01,   name="unit_id",        fuzzable=True)
    with s_block("pdu"):
        s_byte(0x05,   name="function_code",  fuzzable=False)  # FC05 fixed
        s_word(0x0000, name="coil_address",   fuzzable=True,  endian=">")
        s_word(0xFF00, name="coil_value",     fuzzable=True,  endian=">")  # 0xFF00=ON, 0x0000=OFF

    # FC03 - Read Holding Registers
    s_initialize("fc03_read_holding")
    with s_block("mbap"):
        s_word(0x0001, name="transaction_id", fuzzable=True, endian=">")
        s_word(0x0000, name="protocol_id",    fuzzable=False, endian=">")
        s_word(0x0006, name="length",         fuzzable=True,  endian=">")
        s_byte(0x01,   name="unit_id",        fuzzable=True)
    with s_block("pdu"):
        s_byte(0x03,   name="function_code",  fuzzable=False)  # FC03 fixed
        s_word(0x0000, name="start_address",  fuzzable=True,  endian=">")
        s_word(0x0001, name="quantity",       fuzzable=True,  endian=">")

    # Fuzz the function code itself with all other fields fixed
    s_initialize("fuzz_function_code")
    with s_block("mbap"):
        s_word(0x0001, name="transaction_id", fuzzable=False, endian=">")
        s_word(0x0000, name="protocol_id",    fuzzable=False, endian=">")
        s_word(0x0006, name="length",         fuzzable=False, endian=">")
        s_byte(0x01,   name="unit_id",        fuzzable=False)
    with s_block("pdu"):
        s_byte(0x01,   name="function_code",  fuzzable=True)  # All 256 values
        s_word(0x0000, name="address",        fuzzable=False, endian=">")
        s_word(0x0001, name="data",           fuzzable=False, endian=">")


def main():
    print(f"[*] Modbus TCP fuzzer -> {TARGET_IP}:{TARGET_PORT}")
    print("[*] Results in ./boofuzz-results/modbus/")
    print("[*] Ctrl+C to stop\n")

    build_modbus_requests()

    session = Session(
        target=Target(
            connection=TCPSocketConnection(TARGET_IP, TARGET_PORT)
        ),
        sleep_time=0.05,          # 50 ms between cases — fast but not overwhelming
        restart_sleep_time=5,     # wait 5 s after a crash before reconnecting
        db_filename="./boofuzz-results/modbus/fuzz.db"
    )

    # Chain all request types
    session.connect(s_get("fc01_read_coils"))
    session.connect(s_get("fc05_write_coil"))
    session.connect(s_get("fc03_read_holding"))
    session.connect(s_get("fuzz_function_code"))

    session.fuzz()


if __name__ == "__main__":
    import pathlib
    pathlib.Path("./boofuzz-results/modbus").mkdir(parents=True, exist_ok=True)
    main()
