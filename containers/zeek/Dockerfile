FROM zeek/zeek:latest

# Upgrade all base OS packages to pull in the latest security patches.
# Trivy scan found 17 CRITICAL and 52 HIGH CVEs in the upstream zeek/zeek:latest
# image (libgnutls, Python 3.13, Perl, node-undici, etc.) -- all fixed by simply
# running apt-get upgrade against the Debian package repos.
# --no-install-recommends intentionally omitted: security upgrades should pull
# in recommended packages so that patch coverage is complete.
# Fixes CVE-2026-45447 (openssl heap use-after-free, libssl3t64 3.5.6-1~deb13u2).
#
# SECURITY_REFRESH busts this layer's build cache so a rebuild re-runs the
# upgrade against the *current* Debian repos rather than reusing a months-old
# cached layer. Bump the date whenever a newly published security update needs
# to be pulled. 2026-07-06: libssh2 1.11.1-1+deb13u1 fixes CVE-2026-55200
# (CRITICAL out-of-bounds write), CVE-2026-55199 (HIGH DoS), and CVE-2026-7598
# — none of which were in the repos when this image was last built (2026-06-29).
ARG SECURITY_REFRESH=2026-07-06
RUN echo "security-refresh: ${SECURITY_REFRESH}" \
    && apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# ICS protocol monitoring script
COPY ics-monitor.zeek /usr/local/zeek/share/zeek/site/ics-monitor.zeek

# Load our script from the site policy
RUN echo "@load ics-monitor" >> /usr/local/zeek/share/zeek/site/local.zeek

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=zeek-1 \
    ZEEK_IFACE=eth0

ENTRYPOINT ["/entrypoint.sh"]
