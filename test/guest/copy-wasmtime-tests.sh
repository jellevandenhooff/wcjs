#!/bin/bash
# Copy wasmtime P3 test component binaries into test/guest/out/wasmtime-p3/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WASMTIME_DIR="${WASMTIME_DIR:-$REPO_ROOT/../wasmtime}"
SRC=$(find "$WASMTIME_DIR/target" -path "*/test-programs-artifacts-*/out/wasm32-wasip1/debug" -type d | head -1)
DEST="$SCRIPT_DIR/out/wasmtime-p3"
mkdir -p "$DEST"

for f in p3_cli p3_cli_hello_stdout p3_cli_much_stdout p3_clocks_sleep \
         p3_filesystem_file_read_write p3_file_write p3_readdir p3_random_imports \
         p3_sockets_tcp_bind p3_sockets_tcp_connect p3_sockets_tcp_sample_application \
         p3_sockets_tcp_sockopts p3_sockets_tcp_states p3_sockets_tcp_streams \
         p3_sockets_udp_bind p3_sockets_udp_connect p3_sockets_udp_sample_application \
         p3_sockets_udp_sockopts p3_sockets_udp_states p3_sockets_ip_name_lookup \
         p3_http_outbound_request_get p3_http_outbound_request_post \
         p3_http_outbound_request_put p3_http_outbound_request_large_post \
         p3_http_outbound_request_invalid_dnsname \
         p3_http_outbound_request_response_build \
         p3_http_outbound_request_content_length \
         p3_http_outbound_request_invalid_port \
         p3_http_outbound_request_unknown_method \
         p3_http_outbound_request_unsupported_scheme \
         p3_http_outbound_request_invalid_header \
         p3_http_outbound_request_invalid_version \
         p3_http_outbound_request_timeout \
         p3_http_outbound_request_missing_path_and_query \
         p3_http_echo p3_http_proxy; do
  src_file="$SRC/${f}.component.wasm"
  if [ -f "$src_file" ]; then
    cp "$src_file" "$DEST/"
    echo "  copied $f"
  else
    echo "  MISSING $f"
  fi
done
echo "Done. $(ls "$DEST"/*.wasm 2>/dev/null | wc -l) test components copied."
