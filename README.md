# ICS Simulator

[![Build](https://github.com/iburres/ics-simulator/actions/workflows/build.yml/badge.svg)](https://github.com/iburres/ics-simulator/actions/workflows/build.yml)
[![Docker Images](https://github.com/iburres/ics-simulator/actions/workflows/docker.yml/badge.svg)](https://github.com/iburres/ics-simulator/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A free, open-source ICS/SCADA cybersecurity training platform for researchers, educators, and students. Build realistic industrial control system environments on your laptop — no hardware, no subscription, no cost.

Developed by **Ian Burres**, Professor of Practice at the University of Texas at San Antonio (UTSA), in support of ICS/SCADA security education and research.

---

## What It Does

ICS Simulator lets you design, deploy, and attack realistic ICS/SCADA environments using a visual drag-and-drop canvas. Each device in your scenario runs as a real Docker container on an isolated virtual network — protocol traffic is genuine, not simulated at the application layer.

**Author a scenario** → drag PLCs, RTUs, IEDs, sensors, and network devices onto the canvas, wire them with protocol edges, write IEC 61131-3 ladder logic, configure the firewall — then click **Run**. Docker Compose spins up the full environment in seconds.

**Attack the scenario** → open the embedded Kali Linux terminal or full Xfce4 desktop (Wireshark, Armitage, Metasploit) and work through the mission.

**Monitor and analyze** → live Grafana dashboards show Suricata IPS alerts and Zeek protocol logs alongside the InfluxDB process historian.

---

## Features

### Visual Scenario Builder
- Drag-and-drop SCADA canvas with ISA-5.1 / IEC 81346 standard P&ID symbols
- Four-zone Purdue Model network topology (OT / IT / DMZ / External)
- Zone-aware firewall rule editor
- Export scenarios as `.icslab` files — share with students or the community

### PLC IDE
- Structured Text (ST) editor with syntax highlighting
- SVG ladder logic viewer
- Live deploy to running OpenPLC Runtime containers via the web API
- IEC 61131-3 compliant (Ladder, ST, FBD, SFC, IL)

### Attack Machine — Hybrid Terminal
- **Terminal tab:** xterm.js interactive bash session in the Electron window
- **Desktop tab:** Full Xfce4 desktop via embedded noVNC (Wireshark GUI, Armitage, Firefox)
- Kali Linux with a complete ICS-focused toolkit (see below)

### Security Monitoring
- Suricata IPS with Emerging Threats ICS ruleset (Modbus, DNP3, EIP anomaly detection)
- Zeek deep-packet analysis with ICS protocol scripts
- Grafana dashboards for real-time alert visualization
- InfluxDB 1.8 process historian

---

## Protocol Support

Real protocol packets flow on Docker virtual networks — scanner tools and exploit frameworks see genuine service fingerprints.

| Protocol | Implementation | Port |
|---|---|---|
| Modbus TCP / RTU / ASCII | pymodbus (Python) | TCP 502 |
| DNP3 | OpenDNP3 (C++) | TCP 20000 |
| OPC UA | node-opcua (Node.js) | TCP 4840 |
| BACnet/IP | bacpypes (Python) | UDP 47808 |
| Ethernet/IP CIP | cpppo (Python) | TCP 44818 |
| IEC 61850 | libiec61850 (C) | TCP 102 |

---

## Attack Toolkit (Kali Linux Container)

| Category | Tools |
|---|---|
| Reconnaissance | nmap, masscan, netdiscover, arp-scan |
| Packet analysis | Wireshark (GUI), tshark, tcpdump, Scapy |
| Exploitation | Metasploit Framework, Armitage (GUI) |
| Credentials | Hydra, Medusa, Patator, John the Ripper, Hashcat |
| ICS/OT specific | pymodbus, dnp3-python, opcua, bacpypes3, python-snap7, impacket, ike-scan |
| Desktop | Xfce4 via noVNC — accessible directly in the Electron app |

---

## Requirements

| Requirement | Minimum |
|---|---|
| OS | Windows 10/11, macOS 13+, Ubuntu 22.04+ |
| RAM | 8 GB (16 GB recommended for attack machine scenarios) |
| Disk | 20 GB free (Docker images downloaded on first run) |
| Docker Desktop | Latest stable |
| Node.js | 20+ (development only) |

---

## Quick Start

### Run from source

```bash
git clone https://github.com/iburres/ics-simulator.git
cd ics-simulator
npm install
npm run dev
```

Docker Desktop must be running before launching the app.

### Build a distributable

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

---

## Project Structure

```
ics-simulator/
├── packages/
│   ├── app/                  # Electron application
│   │   └── src/
│   │       ├── main/         # Node.js main process (IPC, Docker, OpenPLC API)
│   │       ├── preload/      # contextBridge API surface
│   │       └── renderer/     # React + TypeScript UI
│   │           └── src/
│   │               ├── canvas/       # React Flow SCADA canvas
│   │               ├── palette/      # Device palette (ISA-5.1 symbols)
│   │               ├── properties/   # Device inspector panel
│   │               ├── terminal/     # Attack terminal modal (xterm.js + noVNC)
│   │               └── icons/        # SVG device icons
│   ├── orchestrator/         # Docker Compose generator + DockerClient
│   └── schema/               # Shared TypeScript types (ICSLabScenario, DeviceConfig…)
├── containers/               # Docker image source (one per device category)
│   ├── attack-base/          # Kali Linux — attack machine
│   ├── modbus/               # pymodbus Modbus server
│   ├── dnp3/                 # OpenDNP3 outstation
│   ├── openplc/              # OpenPLC Runtime
│   ├── suricata/             # Suricata IPS with ICS rules
│   ├── zeek/                 # Zeek network monitor
│   ├── firewall/             # nftables firewall
│   ├── router/               # Inter-zone router
│   └── switch/               # Layer-2 switch
└── .github/
    └── workflows/            # CI: build, Docker image publish, CodeQL, secret scan
```

---

## Scenario Format

Scenarios are saved as `.icslab` JSON files with four layers:

```json
{
  "meta":     { "name": "Water Treatment Plant", "sector": "water", "version": "1.0" },
  "visual":   { "nodes": [...], "edges": [...] },
  "network":  { "segments": [...], "protocolEdges": [...] },
  "devices":  { "devices": { "plc-1": { ... }, "rtu-1": { ... } } },
  "security": { "firewallRules": [...], "idsConfig": { ... } }
}
```

Share your scenarios with the community — open a pull request against the [ics-sim-scenarios](https://github.com/iburres/ics-sim-scenarios) repository (coming soon).

---

## Development Status

| Phase | Feature | Status |
|---|---|---|
| 0 | Electron shell, Docker check, first-launch flow | ✅ Complete |
| 1 | Orchestration engine (Compose generator, LevelDB, resource estimator) | ✅ Complete |
| 2 | SCADA canvas (React Flow, ISA-5.1 icons, zones, drag-drop) | ✅ Complete |
| 3 | Container images (9 GHCR images, GitHub Actions CI/CD) | ✅ Complete |
| 4 | PLC IDE (ST editor, ladder viewer, variable bindings, live deploy) | ✅ Complete |
| — | Attack terminal (xterm.js + noVNC Xfce4 desktop) | ✅ Complete |
| 5 | DNP3 IED auto-config + security stack UI (FirewallPanel, IDSPanel, nftables/Suricata/Zeek orchestration) | ✅ Complete |
| — | Connection validation — Purdue Reference Model matrix (IEC 62443-3-2 / NIST SP 800-82); invalid targets dimmed + educational tooltip | ✅ Complete |
| 6 | Monitoring panels (Grafana embed, Loki log viewer) | 🔜 Next |
| 7 | FUXA HMI embed + student mission brief panel | 🔜 Planned |
| 8 | Author / Student mode split + locked scenario distribution | 🔜 Planned |
| 9 | Community scenario pack format | 🔜 Planned |
| 10 | Conpot legacy device emulation (Siemens S7, IEC 104) | 🔜 Planned |
| 11 | Physical process simulation (tank, pump, valve dynamics) | 🔜 Planned |
| 12 | macOS + Linux packaging and distribution | 🔜 Planned |

---

## Open Source Components

This project would not be possible without these open-source tools:

| Component | Role | License |
|---|---|---|
| [OpenPLC Runtime](https://github.com/thiagoralves/OpenPLC_v3) | IEC 61131-3 PLC execution engine | GPL-3.0 |
| [FUXA](https://github.com/frangoteam/FUXA) | Web-based SCADA/HMI | MIT |
| [Suricata](https://github.com/OISF/suricata) | Network IPS / IDS | GPL-2.0 |
| [Zeek](https://github.com/zeek/zeek) | Network traffic analysis | BSD-3 |
| [Grafana](https://github.com/grafana/grafana) | Dashboards and visualization | AGPL-3.0 |
| [Loki](https://github.com/grafana/loki) | Log aggregation | AGPL-3.0 |
| [InfluxDB 1.8](https://github.com/influxdata/influxdb) | Time-series process historian | MIT |
| [React Flow](https://github.com/xyflow/xyflow) | SCADA canvas | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js) | Terminal emulator | MIT |
| [noVNC](https://github.com/novnc/noVNC) | Browser-based VNC client | MPL-2.0 |
| [Kali Linux](https://www.kali.org) | Penetration testing OS | Various |

Third-party Docker images are pulled from public registries at runtime and are not bundled in this repository.

---

## Contributing

Contributions are welcome — bug reports, new device types, scenario packs, protocol implementations, and documentation improvements are all valuable.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/dnp3-master-station`)
3. Commit your changes with clear messages
4. Open a pull request

For large changes, open an issue first to discuss the approach.

---

## License

Application source code: [MIT](LICENSE)

Runtime Docker images are governed by their own licenses — see the [LICENSE](LICENSE) file for a full list.

---

## Author

**Ian Burres**
Professor of Practice — Cybersecurity, University of Texas at San Antonio (UTSA)
Former: Sandia National Laboratories
ORCID: [0009-0006-1320-9956](https://orcid.org/0009-0006-1320-9956)
