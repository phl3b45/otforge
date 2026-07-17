#!/bin/sh
set -e

echo "[ics-camera] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  label=${CAMERA_LABEL}"

# ── Weak/default root credentials — the actual vulnerability this device models ──
# CWE-1392/CWE-798 (Default/Hardcoded Credentials). Root SSH login with a never-
# rotated default password is exactly the class of vulnerability behind the
# Mirai botnet and a long, well-documented history of real IP camera compromises.
# No specific commercial product's firmware is being reproduced here.
echo "root:${CAMERA_ROOT_PASSWORD}" | chpasswd
# Strip any existing PermitRootLogin/PasswordAuthentication lines (commented or
# not — Alpine's default sshd_config ships these commented out) and append
# authoritative values, rather than relying on sed matching an exact existing
# line format that could differ between base image versions.
#
# AllowTcpForwarding: Alpine's openssh-server package ships with this
# explicitly set to "no" (not just commented out) — without overriding it,
# any SSH local/dynamic port-forward through this device fails with
# "administratively prohibited" even with fully valid credentials. Real
# camera firmware based on a stripped-down SSH daemon frequently has the
# same default; a real attacker pivoting through one hits this exact wall
# and has to explicitly check for it. Confirmed live while building Lab 04
# (TRITON/TRISIS): the tunnel itself connected fine, credentials worked,
# and only the forwarded channel was refused, which is a very easy failure
# mode to misdiagnose as a network or firewall problem instead.
sed -i '/^#\?PermitRootLogin/d; /^#\?PasswordAuthentication/d; /^#\?AllowTcpForwarding/d' /etc/ssh/sshd_config
{
    echo 'PermitRootLogin yes'
    echo 'PasswordAuthentication yes'
    echo 'AllowTcpForwarding yes'
} >> /etc/ssh/sshd_config
echo "[ics-camera] SSH: root login enabled, password authentication enabled, TCP forwarding enabled"

# ── Recon flavor: a static "camera web admin" page, no real auth logic ──────────
# Confirms to a student doing reconnaissance (nmap + a browser) that this host
# is a camera, without doing anything functional — the exploit path is SSH.
busybox-extras httpd -h /app/www -p 80 &
echo "[ics-camera] HTTP recon page listening on port 80"

/usr/sbin/sshd -D
