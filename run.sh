#!/usr/bin/with-contenv bashio
set -e

mkdir -p /data
cd /app
exec node server.js
