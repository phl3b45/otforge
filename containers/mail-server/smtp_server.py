#!/usr/bin/env python3
"""
containers/mail-server/smtp_server.py

OTForge simulated corporate mail server for the internet DMZ zone.

Intentionally misconfigured as an open relay -- no authentication required,
no SPF/DKIM checks, no recipient validation. All mail to any address is
accepted and logged. This models the kind of poorly secured mail server
that is common in legacy ICS environments and enables the spear-phishing
tutorial attack chain.

Attack chain (from Kali):
  1. OSINT: scrape email addresses from meridian-process.com HTML source
  2. Send phishing email:
       curl --url smtp://<MAIL_IP>:25/              \
            --mail-from "noreply@update-notice.com" \
            --mail-rcpt "it@meridian-process.com"   \
            --upload-file phishing.txt
  3. Observe delivery in docker logs or /var/mail/

Every received message is:
  - Logged to stdout in full (From, To, Subject, Body) for 'docker logs' visibility
  - Saved to /var/mail/<timestamp>_<recipient>.eml for forensic inspection

Environment variables:
  MAIL_DOMAIN  Displayed in the startup banner (default: meridian-process.com)
"""

import asyncio
import email
import email.policy
import logging
import os
import time

from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MAIL_DOMAIN = os.environ.get("MAIL_DOMAIN", "meridian-process.com")
MAIL_DIR = "/var/mail"

os.makedirs(MAIL_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="[otforge-mail] %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SMTP handler
# ---------------------------------------------------------------------------

class OpenRelayHandler:
    """
    Accepts all mail unconditionally (open relay).
    Logs every message and writes it to /var/mail/.
    """

    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        """Accept any recipient without validation."""
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        """Receive message, log it, and save it to disk."""
        raw = envelope.content  # bytes

        # Parse with Python's email library for structured access
        msg = email.message_from_bytes(raw, policy=email.policy.default)

        sender = envelope.mail_from
        recipients = envelope.rcpt_tos
        subject = msg.get("Subject", "(no subject)")

        # Extract plain-text body for logging
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    body = part.get_content()
                    break
        else:
            try:
                body = msg.get_content()
            except Exception:
                body = raw.decode("utf-8", errors="replace")

        # Log to stdout so students see it in 'docker logs'
        sep = "=" * 62
        log.info(sep)
        log.info("MESSAGE RECEIVED")
        log.info(f"  From:    {sender}")
        log.info(f"  To:      {', '.join(recipients)}")
        log.info(f"  Subject: {subject}")
        log.info("  --- Body ---")
        for line in body.strip().splitlines():
            log.info(f"  {line}")
        log.info(sep)

        # Save one .eml file per recipient
        ts = int(time.time())
        for rcpt in recipients:
            safe = rcpt.replace("@", "_at_").replace("/", "_").replace("..", "_")
            filename = f"{ts}_{safe}.eml"
            filepath = os.path.join(MAIL_DIR, filename)
            with open(filepath, "wb") as f:
                f.write(raw)
            log.info(f"Saved: {filepath}")

        return "250 Message accepted for delivery"


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

async def main():
    handler = OpenRelayHandler()
    controller = Controller(
        handler,
        hostname="0.0.0.0",
        port=25,
    )

    sep = "=" * 62
    log.info(sep)
    log.info("OTForge Mail Server")
    log.info(f"  Domain:   {MAIL_DOMAIN}")
    log.info( "  SMTP:     port 25  (open relay -- no authentication)")
    log.info(f"  Storage:  {MAIL_DIR}")
    log.info( "")
    log.info( "  Configured mailboxes:")
    log.info(f"    webmaster@{MAIL_DOMAIN}")
    log.info(f"    it@{MAIL_DOMAIN}")
    log.info(f"    support@{MAIL_DOMAIN}")
    log.info( "")
    log.info( "  Attack vector (from Kali):")
    log.info( "    curl --url smtp://<mail-ip>:25/         \\")
    log.info( "         --mail-from attacker@evil.com      \\")
    log.info(f"         --mail-rcpt it@{MAIL_DOMAIN} \\")
    log.info( "         --upload-file phishing.txt")
    log.info(sep)
    log.info("")
    log.info("Waiting for connections...")

    controller.start()
    try:
        await asyncio.sleep(float("inf"))
    finally:
        controller.stop()


if __name__ == "__main__":
    asyncio.run(main())
