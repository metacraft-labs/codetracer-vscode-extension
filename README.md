## 📥 Running from an Existing Clone

If you already have the repository cloned, the following commands bring it up to date and start the extension:

1. **Update your branch**

   ```bash
   git pull
   ```

2. **Synchronize submodules**

   ```bash
   git submodule update --init --recursive
   ```

3. **Build the extension**

   ```bash
   just build
   ```

4. **Test in VS Code**

   Open `src/extension.ts` in VS Code and press `F5` to launch the Extension Development Host.

NOTE: You will need to have a trace recording in `~/.local/share/codetracer/` to have them listed on `ToggleCT`
