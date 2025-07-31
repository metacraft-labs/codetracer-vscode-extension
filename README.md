
## 📥 Running After Download

If you cloned the repository and need to run a specific branch, use these commands to set up the extension:

```bash
git pull <branch-name>
git submodule update --init --recursive
just build
```

Open `src/extension.ts` in VS Code and press <kbd>F5</kbd> to launch the Extension Development Host for testing.
