# containers/fuxa/Dockerfile — Multi-platform mirror of frangoteam/fuxa.
#
# The official frangoteam/fuxa image supports linux/amd64 and linux/arm64.
# This single-FROM Dockerfile lets docker/build-push-action copy both platform
# variants into GHCR so Apple Silicon Macs run the native image without Rosetta 2.
FROM frangoteam/fuxa:latest

# FUXA treats device protocol drivers (Modbus/OPC-UA/BACnet/S7/...) as pluggable npm
# packages loaded from node_modules at server boot (server/runtime/plugins/index.js'
# _checkPluginsSupported()). The base image ships with none of them installed -- without
# this, no Modbus device ever connects (boot log: "plugin is missing!"), regardless of
# how correct configureFuxa()'s API payloads are. Version pinned to match FUXA's own
# plugin registry (createDefaultPlugins() in server/runtime/plugins/index.js).
# --no-save avoids mutating the base image's own package.json/package-lock.json.
RUN npm install modbus-serial@8.0.19 --no-save

# Upstream bug fix: FUXA's Modbus tag loader (runtime/devices/modbus/index.js) builds
# two different lookup keys for a Coil-table address -- the main load() loop keys by
# the tag's raw numeric memaddress (e.g. 0), but getMemoryAddress()'s "askey" branch for
# Coils hardcodes the string literal '000000' instead of the numeric constant used by
# every other table type (DigitalInputs/InputRegisters/HoldingRegisters all return their
# real ModbusMemoryAddress constant). The mismatch means any device with a Coil-type tag
# throws "Cannot read properties of undefined (reading 'Items')" during load -- true for
# both OTForge's RTU (DO_0-3) and smart-controller (CO0) tags. Verified harmless to
# actual polling/writes (confirmed end-to-end against a live container), but it's a
# spurious error on every lab session involving a coil -- worth a clean fix rather than
# living with a confusing log line. Confirmed unique match via the upstream source
# before patching (still present as of FUXA v1.3.3 / current HEAD, not yet fixed there).
RUN sed -i "s/formatAddress('000000', token)/formatAddress(ModbusMemoryAddress.CoilStatus, token)/" \
    runtime/devices/modbus/index.js
