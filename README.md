# Sajilo Server & Explorer

A high-performance C++ HTTP compiler server and interactive web-based IDE/IR viewer for the **Sajilo** programming language.

---

## 📂 Project Structure

```text
sajilo-server/
├── CMakeLists.txt          # Root CMake build configuration
├── .gitignore              # Repository git ignore configuration
├── README.md               # Main documentation
├── backend/
│   ├── CMakeLists.txt      # Backend executable configuration
│   └── main.cpp            # C++ HTTP API server (cpp-httplib + nlohmann_json)
└── frontend/
    ├── index.html          # Clean IDE interface layout & Monaco mounts
    ├── app.js              # Monaco editor configuration, syntax, tabs & state
    └── style.css           # Modern themeable design (Catppuccin, Tokyo Night, etc.)
```

---

## 🚀 Quick Start

### 1. Prerequisites (macOS / Linux)

- **CMake 3.16+**
- **C++17 compliant compiler** (Clang or GCC)
- **Sajilo compiler binary** (typically installed at `/usr/local/bin/sajilo`)
- **C++ Libraries** (via Homebrew on macOS):
  ```bash
  brew install cpp-httplib nlohmann-json
  ```

### 2. Build the Server

Build from the project root:
```bash
cmake -B build
cmake --build build
```

The resulting binary will be created at `build/backend/sajilo_server`.

### 3. Run the Server

```bash
./build/backend/sajilo_server
```

By default:
- **Server Port**: `8080` (customizable via `./build/backend/sajilo_server [port]` or `PORT=9000`)
- **Web UI**: [http://localhost:8080/](http://localhost:8080/) (automatically serves the `frontend/` directory)
- **Compilation Endpoint**: `POST http://localhost:8080/compile` (supports JSON or raw text with full CORS)
- **Health Check Endpoint**: `GET http://localhost:8080/health`

---

## 🛠️ Compiler Integration (`sajilo`)

When a compilation request arrives, the server executes:
```bash
sajilo <input.sj> -o json <output.json>
```

The server automatically discovers your compiler in:
1. `SAJILO_PATH` environment variable:
   ```bash
   SAJILO_PATH=/path/to/sajilo ./build/backend/sajilo_server
   ```
2. Standard system locations: `/usr/local/bin/sajilo`, `/opt/homebrew/bin/sajilo`
3. Current or relative build paths: `./sajilo`, `../sajilo`, `../build/sajilo`
4. System `$PATH`

### Simulation Mode

To test the frontend without an installed compiler binary:
```bash
SAJILO_MOCK=1 ./build/backend/sajilo_server
```

---

## 🎨 Features & Highlights

- **Multi-File Tabbed Editor**: Create, switch, close, and inline-rename `.sj` files.
- **Selective Compilation**: Compiles the currently active open file on demand.
- **Vim & Developer Themes**: Selectable themes including Catppuccin Mocha, Tokyo Night, Gruvbox Dark, Nord, and VS Code Dark.
- **Precise Error Diagnostics**: Parses compiler errors with file:line indicators and renders Monaco red squiggly underlines.
- **Smooth Resizable Layout**: Split panes and resizable terminal diagnostics drawer.
- **Clean Typography**: Optimized for `VictorMono Nerd Font` with ligature support.

---

## 🎨 Features & Highlights

- **Multi-File Tabbed Editor**: Create, switch, close, and inline-rename `.sj` files.
- **Selective Compilation**: Compiles the currently active open file on demand.
- **Vim & Developer Themes**: Selectable themes including Catppuccin Mocha, Tokyo Night, Gruvbox Dark, Nord, and VS Code Dark.
- **Precise Error Diagnostics**: Parses compiler errors with file:line indicators and renders Monaco red squiggly underlines.
- **Smooth Resizable Layout**: Split panes and resizable terminal diagnostics drawer.
- **Clean Typography**: Optimized for `VictorMono Nerd Font` with ligature support.

