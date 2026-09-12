#!/bin/bash

# Build script for Go WebAssembly project
# This script builds the Go code to WebAssembly and prepares the dist directory

set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
echo "Script directory: $SCRIPT_DIR"
DIST_DIR="$SCRIPT_DIR/dist"
echo "Distribution directory: $DIST_DIR"

# Create dist directory if it doesn't exist
if [ ! -d "$DIST_DIR" ]; then
    mkdir -p "$DIST_DIR"
    echo "Created $DIST_DIR directory"
fi

# Find wasm_exec.js from GOROOT
GO_ROOT=$(go env GOROOT)
# this moved from misc/wasm to lib/wasm in Go 1.20
WASM_EXEC_JS="$GO_ROOT/lib/wasm/wasm_exec.js"
# WASM_EXEC_JS="$GO_ROOT/misc/wasm/wasm_exec.js"

if [ ! -f "$WASM_EXEC_JS" ]; then
    echo "ERROR: Could not find wasm_exec.js at $WASM_EXEC_JS"
    exit 1
fi

# Copy wasm_exec.js
echo "Copying wasm_exec.js to $DIST_DIR..."
cp "$WASM_EXEC_JS" "$DIST_DIR/wasm_exec.js"

# Copy index.html
echo "Copying index.html to $DIST_DIR..."
cp "$SCRIPT_DIR/index.html" "$DIST_DIR/index.html"

# Build the WebAssembly binary
echo "Building WebAssembly binary..."
export GOOS=js
export GOARCH=wasm
MAIN_GO="$SCRIPT_DIR/main.go"
OUTPUT_WASM="$DIST_DIR/main.wasm"

go build -o "$OUTPUT_WASM" "$MAIN_GO"

echo "Build successful! Output: $OUTPUT_WASM"
echo ""
echo "To serve the app, run:"
echo "  python -m http.server 8080 --directory $DIST_DIR"
echo ""
echo "Then open http://localhost:8080 in your browser"
