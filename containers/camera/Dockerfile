FROM alpine:latest

# openssh-server: the actual exploitable surface (weak/default root credentials —
# the same CWE-1392/CWE-798 class of vulnerability behind the Mirai botnet and
# countless real IoT camera compromises). busybox-extras provides httpd for a
# minimal static "camera web admin" recon flavor page — decorative only, no
# real auth logic; the exploit path is SSH, not the web form.
RUN apk add --no-cache openssh busybox-extras \
    && ssh-keygen -A

WORKDIR /app
COPY www /app/www
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=camera-1 \
    DEVICE_CATEGORY=ip-camera \
    CAMERA_LABEL="Perimeter Camera 07" \
    CAMERA_ROOT_PASSWORD=admin123

# SSH (the exploit path) + HTTP (recon flavor page only).
EXPOSE 22 80

ENTRYPOINT ["./entrypoint.sh"]
