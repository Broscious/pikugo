# Go WebAssembly Hello World

A minimal example of a Go program compiled to WebAssembly and hosted on a static webpage.

## Prerequisites

- Go 1.20 or later
- Python 3.x (for serving the static files)

## Build

Run the build script:

```bash
./build.sh
```

This will:
1. Copy `wasm_exec.js` from your Go installation
2. Copy `index.html` to the dist directory
3. Compile `main.go` to `main.wasm`

All output files will be in the `dist/` directory.

## Run

Serve the static files with Python:

```bash
python -m http.server 8080 --directory ./dist
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## How It Works

- **main.go**: Go code that uses `syscall/js` to interact with the DOM
- **index.html**: HTML page that loads `wasm_exec.js` and instantiates the WebAssembly module
- **wasm_exec.js**: Go-provided JavaScript bindings for WebAssembly
- **build.sh**: Bash script to build and prepare the dist directory

When you visit the page, the Go runtime executes and adds a heading and paragraph to the page body.
