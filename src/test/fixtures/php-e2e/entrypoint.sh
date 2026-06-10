#!/bin/bash
set -e

cat > /usr/local/etc/php/conf.d/xdebug.ini <<EOF
zend_extension=xdebug.so
xdebug.mode=${XDEBUG_MODE:-debug}
xdebug.start_with_request=${XDEBUG_START_WITH_REQUEST:-yes}
xdebug.client_host=${XDEBUG_CLIENT_HOST:-127.0.0.1}
xdebug.client_port=${XDEBUG_CLIENT_PORT:-9003}
xdebug.idekey=${XDEBUG_IDEKEY:-VSCODE}
xdebug.log=/tmp/xdebug.log
xdebug.log_level=10
EOF

echo "Xdebug configured: client_host=${XDEBUG_CLIENT_HOST:-127.0.0.1}:${XDEBUG_CLIENT_PORT:-9003}"

# Start trigger watcher in background — auto-runs PHP when VS Code listens.
/usr/local/bin/trigger.sh &

exec "$@"
