# containers/web-company/Dockerfile
#
# Meridian Process Controls — simulated company website container.
#
# Serves a realistic industrial automation company website over HTTP on port 80.
# Used in the ICS Simulator Internet DMZ zone as the OSINT starting point for the
# introductory attack tutorial. Students discover this server, enumerate its HTTP
# headers and page content, then use the information to map the internal network.
#
# Educational teaching points:
#   - HTTP banner grabbing: curl -I http://<ip>  → reveals nginx/1.27 + OS hint
#   - HTML source review: remote.html contains a developer comment with the OT
#     subnet, admin credentials, and internal protocol port assignments
#   - robots.txt absence: nmap http-enum will report /remote.html as accessible
#
# Image: nginx:1.27-alpine (~40 MB) — minimal, no shell needed at runtime
FROM nginx:1.27-alpine

# Copy the static site into the default nginx document root
COPY html /usr/share/nginx/html

# Replace the default nginx server block with our custom config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Standard HTTP port — published to host by compose-generator
EXPOSE 80
