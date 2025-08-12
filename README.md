# CodeTracer VS Code Extension

[![Discord](https://img.shields.io/discord/1326949714679038014?label=Discord&logo=discord&style=flat)](https://discord.gg/aH5WTMnKHT)

> **Bring the power of CodeTracer’s time-travel debugging into your Visual Studio Code workflow.**  
> This extension integrates the CodeTracer debugger directly into VS Code using the DAP integrated communication, so you can record, replay, and trace your code without leaving your IDE.

---

## 🚀 Introduction

The CodeTracer VS Code Extension allows you to:

- Start and stop **CodeTracer debug sessions** directly from VS Code.
- View call traces, event logs, and variable histories inside VS Code panels.
- Jump backward and forward through program execution without restarting.
- Decorate source lines with trace information inline in your editor.
- Interact with recorded traces just like you would in the standalone GUI.

> **Note:**  
> Currently, only **Ruby** supports the "Record and Run Current File" feature directly inside VS Code.  
> However, you can **load and explore recent traces** created with the standalone CodeTracer app, as well as **stylus transactions recorded with CodeTracer.**

---

## 💡 Use Cases

Here are some ways you can use this extension:

1. **Debug hard-to-reproduce bugs without restarting**  
   Record a session once, then replay it as many times as needed to track down the root cause.

2. **Find the origin of any value**  
   Right-click a line and jump to where a variable’s value was last modified.

3. **Decorate your code with runtime information**  (Work in progress)
   The extension can highlight lines with tracepoints, errors, or important runtime events directly in the Monaco editor inside VS Code.

4. **Step through execution history**  
   Move forward and backward through recorded execution, inspecting variable changes at every step.

5. **Integrate with existing CodeTracer traces**  
   Open and analyze `.trace` files produced by the standalone CodeTracer app or CodeTracer Stylus transaction recordings.

---

## 📦 Installation

1. Install the **CodeTracer VS Code Extension** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/).
2. Make sure you have the **CodeTracer executable** installed on your system.  
   Download it here:
   - [Linux AppImage](https://downloads.codetracer.com/CodeTracer-25.07.1-amd64.AppImage)  
   - [macOS dmg](https://downloads.codetracer.com/CodeTracer-25.07.1-arm64.dmg)  
   - [PGP Key](https://downloads.codetracer.com/CodeTracer.pub.asc)
3. Configure the path to the `codetracer` executable in the extension settings.

---

## 🛠 Usage

1. **Record and Run Current File** *(Ruby only)*  
   - Open a Ruby file and run the **Record and Run Current File** command from the Command Palette.

2. **Navigate the Trace**
   - Use the sidebar panels (Call Trace, Event Log, Terminal Output) to explore the recorded execution.
   - Click on any event to jump to the corresponding line in your code.

3. **Context Menu Commands**
   - Right-click inside the editor to use extension commands like “Forward Source Line Jump” or “Smart Jump” to quickly navigate execution.

---

## 📸 Key Features in VS Code

- **Call Trace Panel** – Navigate the entire function call tree.
- **Event Log Panel** – Chronological list of all significant runtime events.
- **Variable History** – Inspect every value a variable held during execution.
- **Terminal Output Replay** – See exactly when and where output was generated.
- **Scratchpad** – Pin and compare values from any point in time.

---

## 📅 Roadmap

- More granular inline decorations for variable changes.
- Integrate omniscience and tracepoint features.

---

## 📜 License

CodeTracer is distributed under the GNU Affero General Public License (AGPLv3).
