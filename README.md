# Image WebP Converter

A browser-based image processor using JavaScript and canvas-native WebP encoding.

## Prerequisites

- Python 3.x (for serving the static files)

## Build

Serve the project directory directly:

```bash
python -m http.server 8080
```

## Run

Serve the static files with Python:

```bash
python -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## How It Works

- **app.js**: Loads images, manages selections, crops the common frame with a hidden canvas, and encodes a WebP natively.
- **index.html**: Hosts the UI and loads the JavaScript application.
