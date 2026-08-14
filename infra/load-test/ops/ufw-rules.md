# Firewall target state

The SSH source CIDR must be discovered from the operator's current public egress
IP immediately before enabling UFW. Do not hard-code a stale address.

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow from OPERATOR_PUBLIC_IP to any port 22 proto tcp
ufw --force enable
ufw status verbose
```

PostgreSQL, Redis, MinIO ports, Docker socket, and administrative panels remain
unpublished. HTTP/HTTPS remain closed until a separately approved public edge
with TLS is configured. The first API access is through an SSH tunnel to the
loopback-only proxy.
