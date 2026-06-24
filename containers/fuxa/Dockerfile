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
