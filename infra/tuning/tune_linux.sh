#!/bin/bash
# Linux Network Tuning for High Concurrency (1M+ connections)
# Run as root

echo "Applying Linux Kernel Tuning for High Concurrency..."

# 1. Back up sysctl.conf
cp /etc/sysctl.conf /etc/sysctl.conf.bak

# 2. Sysctl Params
cat <<EOF >> /etc/sysctl.conf

# --- Custom Tuning for 10M C10M ---
# File Descriptors
fs.file-max = 2097152

# Netfilter (if using conntrack - usually disable for pure edge, but if needed:)
# net.netfilter.nf_conntrack_max = 1048576
# net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30

# TCP Buffer Sizes (Memory)
# min, default, max
net.ipv4.tcp_mem = 786432 1048576 26777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# UDP Buffer Sizes (Relevant for WebTransport / QUIC)
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 26214400
net.core.wmem_default = 26214400
net.ipv4.udp_mem = 65536 131072 26214400

# Network Queue & Backlog
net.core.netdev_max_backlog = 50000
net.core.somaxconn = 65535

# TCP Port Range
net.ipv4.ip_local_port_range = 1024 65535

# TCP Time Wait
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
# net.ipv4.tcp_tw_recycle = 1 # Deprecated in newer kernels

# BBR Congestion Control (Excellent for WebTransport)
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

EOF

# Apply
sysctl -p

echo "Sysctl applied."

# 3. Limits (ulimit)
# Update /etc/security/limits.conf
cat <<EOF >> /etc/security/limits.conf

# --- Custom Limits ---
* soft nofile 1048576
* hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

echo "Limits updated. Please re-login for ulimit changes to take effect."
echo "Check with: ulimit -n"
