# containers/influxdb/Dockerfile — InfluxDB 1.8 multi-platform image (MIT licensed).
#
# The official influxdb:1.8-alpine image is linux/amd64 only. This Dockerfile
# builds for both amd64 and arm64 by downloading the appropriate release tarball
# from dl.influxdata.com. Debian slim is used as the base (instead of Alpine) to
# avoid musl/glibc compatibility issues with the dynamically-linked InfluxDB binary.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG INFLUXDB_VERSION=1.8.10

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Download the InfluxDB 1.8 release tarball for the build target architecture.
# Both amd64 and arm64 binaries are available from InfluxData's release page.
RUN set -eux; \
    ARCH="${TARGETARCH:-amd64}"; \
    wget -q "https://dl.influxdata.com/influxdb/releases/influxdb-${INFLUXDB_VERSION}_linux_${ARCH}.tar.gz" \
        -O /tmp/influxdb.tar.gz; \
    mkdir /tmp/influxdb-src; \
    tar -xzf /tmp/influxdb.tar.gz -C /tmp/influxdb-src --strip-components=1; \
    find /tmp/influxdb-src -name "influxd"  -exec install -m755 {} /usr/bin/influxd \;; \
    # Match only the root 'influx' binary, not influx_inspect / influx_stress etc.
    find /tmp/influxdb-src -name "influx" -not -name "influx_*" \
        -exec install -m755 {} /usr/bin/influx \;; \
    rm -rf /tmp/influxdb*; \
    mkdir -p /var/lib/influxdb /etc/influxdb; \
    # Create a non-root user for runtime (mirrors official image convention)
    groupadd -r influxdb && useradd -r -g influxdb influxdb; \
    chown -R influxdb:influxdb /var/lib/influxdb /etc/influxdb

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8086

VOLUME /var/lib/influxdb

ENTRYPOINT ["/entrypoint.sh"]
CMD ["influxd"]
