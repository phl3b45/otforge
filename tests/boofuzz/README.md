# Phase 7 - Boofuzz ICS Protocol Fuzzing

## Prerequisites
- Lab 01 simulation running (docker compose up)
- Kali attack machine container running

## Setup

Copy scripts into the Kali container:
```powershell
docker cp tests/boofuzz/fuzz_modbus.py     <project>-attack-1:/root/
docker cp tests/boofuzz/fuzz_openplc_http.py <project>-attack-1:/root/
docker cp tests/boofuzz/fuzz_bacnet.py     <project>-attack-1:/root/
```

Open a terminal in the Kali container and install boofuzz:
```bash
pip install boofuzz --break-system-packages
```

## Running the fuzzers

### 1. Modbus TCP (port 502)
```bash
python3 fuzz_modbus.py
```
PLC_IP and PLC_PORT are already set in the container environment.

### 2. OpenPLC HTTP (port 8080)
```bash
python3 fuzz_openplc_http.py
```

### 3. BACnet/IP UDP (port 47808)
```bash
# Pass the sensor container IP as an argument
python3 fuzz_bacnet.py 10.200.10.20
```

## What to watch

While each fuzzer runs, monitor in a separate terminal:
```bash
docker logs <project>-suricata -f
docker logs <project>-zeek -f
```

## Pass / Fail criteria

- **Pass:** No container crashes, no unexpected Suricata/Zeek alerts beyond normal traffic
- **P0 (block Phase 14):** OpenPLC or sensor container crashes/becomes unresponsive on valid-looking input
- **P1:** Suricata fires no alert on a clearly malformed Modbus frame (detection gap)
- **P2:** Minor unexpected responses with no crash or data loss
