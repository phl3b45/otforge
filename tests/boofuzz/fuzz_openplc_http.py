"""
fuzz_openplc_http.py - Boofuzz HTTP fuzzer for the OpenPLC Runtime web interface.

Targets the OpenPLC REST API on port 8080. Fuzzes login credentials, program
upload, and run/stop control endpoints to find crashes, auth bypasses, or
path traversal vulnerabilities in the web interface.

Usage (from inside Kali container):
    pip install boofuzz requests
    python3 fuzz_openplc_http.py

Environment variables:
    PLC_IP   - IP of the OpenPLC container (default: 10.200.10.10)

Results are written to ./boofuzz-results/http/ and printed to stdout.
"""

import os
import requests
from boofuzz import Session, Target, TCPSocketConnection
from boofuzz import s_initialize, s_block, s_byte, s_word, s_string, s_static, s_delim

TARGET_IP   = os.environ.get("PLC_IP", "10.200.10.10")
TARGET_PORT = 8080


def build_http_requests():
    """Define fuzz cases for OpenPLC HTTP endpoints.

    OpenPLC Runtime endpoints of interest:
      POST /login                  - username/password auth
      POST /upload-program         - ST/LD program file upload
      GET  /run                    - start the PLC program
      GET  /stop                   - stop the PLC program
      GET  /dashboard              - main status page

    HTTP/1.1 format:
      METHOD /path HTTP/1.1\r\n
      Host: <ip>:<port>\r\n
      Content-Type: <type>\r\n
      Content-Length: <n>\r\n
      \r\n
      <body>
    """

    host_header = f"{TARGET_IP}:{TARGET_PORT}"

    # Fuzz the login POST body (username and password fields)
    s_initialize("post_login")
    s_static("POST /login HTTP/1.1\r\n")
    s_static(f"Host: {host_header}\r\n")
    s_static("Content-Type: application/x-www-form-urlencoded\r\n")
    s_static("Connection: keep-alive\r\n")
    # Fuzz the body — username and password
    with s_block("body"):
        s_static("username=")
        s_string("openplc", name="username")
        s_static("&password=")
        s_string("openplc", name="password")
    # Content-Length computed from body block — use a fixed placeholder for fuzzing
    s_static("Content-Length: 100\r\n\r\n")

    # Fuzz the upload-program endpoint with malformed multipart data
    s_initialize("post_upload")
    s_static("POST /upload-program HTTP/1.1\r\n")
    s_static(f"Host: {host_header}\r\n")
    s_static("Content-Type: multipart/form-data; boundary=----OTForgeFuzz\r\n")
    s_static("Content-Length: 500\r\n")
    s_static("Connection: keep-alive\r\n\r\n")
    with s_block("multipart_body"):
        s_static("------OTForgeFuzz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"")
        s_string("program.st", name="filename")   # fuzz filename for path traversal
        s_static("\"\r\nContent-Type: text/plain\r\n\r\n")
        s_string("PROGRAM prog0\nVAR\nEND_VAR\nEND_PROGRAM\n", name="program_body")
        s_static("\r\n------OTForgeFuzz--\r\n")

    # Fuzz the HTTP method on the run endpoint
    s_initialize("run_endpoint")
    s_string("GET", name="http_method")
    s_static(" /run HTTP/1.1\r\n")
    s_static(f"Host: {host_header}\r\n")
    s_static("Connection: keep-alive\r\n\r\n")

    # Fuzz path traversal on GET requests
    s_initialize("path_traversal")
    s_static("GET /")
    s_string("dashboard", name="path")  # boofuzz will inject ../../../etc/passwd etc.
    s_static(" HTTP/1.1\r\n")
    s_static(f"Host: {host_header}\r\n")
    s_static("Connection: keep-alive\r\n\r\n")


def main():
    print(f"[*] OpenPLC HTTP fuzzer -> {TARGET_IP}:{TARGET_PORT}")
    print("[*] Results in ./boofuzz-results/http/")
    print("[*] Ctrl+C to stop\n")

    build_http_requests()

    session = Session(
        target=Target(
            connection=TCPSocketConnection(TARGET_IP, TARGET_PORT)
        ),
        sleep_time=0.1,
        restart_sleep_time=10,    # longer restart delay — OpenPLC may take time to recover
        db_filename="./boofuzz-results/http/fuzz.db"
    )

    session.connect(s_get("post_login"))
    session.connect(s_get("post_upload"))
    session.connect(s_get("run_endpoint"))
    session.connect(s_get("path_traversal"))

    session.fuzz()


if __name__ == "__main__":
    import pathlib
    pathlib.Path("./boofuzz-results/http").mkdir(parents=True, exist_ok=True)
    main()
