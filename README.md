
# CodeTracer VS Code Extension

This is the development environment for the **CodeTracer** extension for Visual Studio Code.

## 🚀 Getting Started

Follow these steps to run the extension in development mode:

### 1. Allow Direnv

```bash
direnv allow
```

### 2. Install Dependencies

Install all Node.js dependencies:

```bash
npm install
```

### 3. Compile the Extension

Build the TypeScript files:

```bash
just build
```

### 4. Open the Extension in VS Code

Open the project in VS Code:

```bash
code .
```

Or open the main extension file manually:

code src/extension.ts

### 5. Launch the Extension Host

In VS Code:

    Press F5 to launch the Extension Development Host.

    This opens a new VS Code window with the extension running.

6. Activate the Extension

In the new Extension Development Host window:

    Press Ctrl+P

    Search for and run:

    "Toggle CodeTracer"

    Or use the sidebar panel to "Toggle CT"
