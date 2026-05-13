#!/bin/bash

echo "[ics-attack] Device=${DEVICE_ID}  ready"
echo "[ics-attack] Kali Linux attack machine — external network segment"
echo "[ics-attack] Available tools: nmap, masscan, metasploit, scapy, pymodbus, tshark"
echo ""
echo "[ics-attack] Network interfaces:"
ip addr show

# Keep the container running — the xterm.js terminal panel (Phase 8) attaches here via exec
exec tail -f /dev/null
