# containers/grafana/Dockerfile — Multi-platform mirror of grafana/grafana.
#
# Pinned to 11.4.0: Grafana 12+ introduced a background plugin installer that
# makes 5 sequential HTTPS calls to grafana.com at every cold start (22 s
# timeout each) and saturates SQLite with concurrent writes during init —
# both combine to push cold-start time past 5 minutes. 11.4.0 is the last
# LTS-track release without the installer; startup on a fresh volume is ~15 s.
FROM grafana/grafana:11.4.0
