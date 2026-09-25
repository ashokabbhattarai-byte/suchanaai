#!/bin/bash
set -e

# Setup 2GB swap file if it does not already exist
if [ ! -f /swapfile ]; then
  echo "Setting up 2GB swap file..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q swapfile /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
  echo "Swap setup complete."
fi
