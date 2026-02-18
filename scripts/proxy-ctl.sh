#!/usr/bin/env bash
# Manage the YugabyteDB Docker Proxy background process.
# Usage: proxy-ctl.sh {start|stop|status|restart}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="${TMPDIR:-/tmp}/yb-docker-proxy.pid"
SERVER="$SCRIPT_DIR/proxy-server.js"
LOG_FILE="${TMPDIR:-/tmp}/yb-docker-proxy.log"
PORT="${YB_PROXY_PORT:-15080}"

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    # Stale PID file
    rm -f "$PID_FILE"
  fi
  return 1
}

cmd_start() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "Proxy is already running (PID $pid) on http://localhost:$PORT"
    return 0
  fi

  echo "Starting YugabyteDB Docker Proxy on port $PORT..."
  nohup node "$SERVER" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  
  # Wait briefly and check it actually started
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "Proxy started (PID $pid)"
    echo "  Landing page: http://localhost:$PORT/"
    echo "  Log file:     $LOG_FILE"
  else
    echo "Failed to start proxy. Check $LOG_FILE for details."
    return 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "Proxy is not running."
    # Also try to kill anything on the port
    local port_pid
    port_pid=$(lsof -ti:"$PORT" 2>/dev/null)
    if [ -n "$port_pid" ]; then
      echo "Killing stale process on port $PORT (PID $port_pid)..."
      kill "$port_pid" 2>/dev/null
    fi
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping proxy (PID $pid)..."
  kill "$pid" 2>/dev/null
  
  # Wait for it to exit
  for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Proxy stopped."
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 0.5
  done
  
  echo "Force-killing proxy..."
  kill -9 "$pid" 2>/dev/null
  rm -f "$PID_FILE"
  echo "Proxy stopped."
}

cmd_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "Proxy is running (PID $pid) on http://localhost:$PORT"
  else
    echo "Proxy is not running."
    return 1
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  restart) cmd_restart ;;
  *)
    echo "Usage: $0 {start|stop|status|restart}"
    exit 1
    ;;
esac
