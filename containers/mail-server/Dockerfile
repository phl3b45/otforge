# containers/mail-server/Dockerfile
#
# Meridian Process Controls -- corporate mail server for the simulated internet DMZ.
#
# Runs a minimal Python SMTP server (aiosmtpd) that accepts all inbound mail
# for the configured domain without authentication -- a deliberately misconfigured
# "open relay" that students exploit in the spear-phishing tutorial.
#
# Students on Kali send phishing emails using:
#   curl --url smtp://<mail-ip>:25/ \
#        --mail-from attacker@evil.com \
#        --mail-rcpt it@meridian-process.com \
#        -T phishing.txt
#
# Every received message is logged to stdout (visible via 'docker logs') and
# saved as a .eml file in /var/mail/ so students can verify delivery with:
#   docker exec <container> ls /var/mail/
#   docker exec <container> cat /var/mail/<file>
#
# Environment variables (with defaults):
#   MAIL_DOMAIN  -- Domain to display in the startup banner  (default: meridian-process.com)
#
# Image: alpine:3.20 + python3 + aiosmtpd (~30 MB total)
FROM alpine:3.20

RUN apk add --no-cache python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages aiosmtpd==1.4.6

COPY smtp_server.py /smtp_server.py

RUN mkdir -p /var/mail

ENV MAIL_DOMAIN=meridian-process.com

# Standard SMTP port
EXPOSE 25

ENTRYPOINT ["python3", "/smtp_server.py"]
