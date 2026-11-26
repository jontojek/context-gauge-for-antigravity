# AGENTS.md — Context Gauge for Antigravity

Instructions for AI coding agents (and humans) working on this repository.

## Goal
Build and maintain an **Antigravity 2.0 UI plugin** that shows a live context window monitor in the right-hand Auxiliary Side Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`, toggled from the top-right panel button).

## Repository layout
The repository root **is** the plugin root, so `agy plugin install https://github.com/<owner>/<repo>` works directly.

- `plugin.json` — Plugin manifest (name, displayName, version, logo, author, license).
- `README.md` — User-facing guide.
- `assets/` — Logo and other static assets.
- `sidecars/context_monitor/` — The sidecar: `main.mjs` (Node server), `parser.mjs` (transcript parser), `index.html`, `app.js`, `styles.css`, `sidecar.json`.
- `docs/screenshots/` — Images used by the README.
- `dev/` — Optional helper scripts for local development (not needed by users).

## Local development
- **Install target (global plugins folder):**
  - Windows: `%USERPROFILE%\.gemini\config\plugins\<plugin-name>\`
  - macOS / Linux: `~/.gemini/config/plugins/<plugin-name>/`
- Edit files in your clone of this repository, then copy them to the install target (or run `agy plugin install <path-to-your-clone>`).
- If your clone lives on a cloud-synced drive (Google Drive, OneDrive, Dropbox), always run from the local install target, not from the synced folder.
- After every change, run `agy plugin validate --strict .` and confirm the plugin still appears in Antigravity.

## Architecture and data source
- **Plugin format:** Standard Antigravity 2.0 plugin (`plugin.json`) with a local web UI sidecar (`sidecars/context_monitor/sidecar.json` with `has_web_ui: true` and `entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE"`). The sidecar runs with `node`.
- **Live conversation tracking:** The UI loads Antigravity's `/preload.js` and reads `window.sidecar.conversationId` to follow the active conversation automatically (with an optional fallback session selector).
- **Exact token telemetry (read-only):** The sidecar reads `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`. `<appData>` is found under the user's home `.gemini` folder, or from the `ANTIGRAVITY_APP_DATA_DIR` environment variable. Each `PLANNER_RESPONSE` entry records:
  - `model`
  - `input_tokens`
  - `cache_read_tokens` (exact prompt context = `input_tokens + cache_read_tokens`)
  - `output_tokens`
  - Step metadata (`step_index`, `type`, `source`, `tool_calls`, `content`, `thinking`, `created_at`) for category breakdown, turn-by-turn history, cache hit rate and auto-compaction detection.
- **Theme integration:** Use host CSS variables injected by `/preload.js` (for example `--background`) so light and dark themes match Antigravity automatically.

## Engineering and safety rules
1. **Strictly read-only on Antigravity data.** Never write to, lock or modify anything inside the Antigravity `brain/` folder (`%USERPROFILE%\.gemini\antigravity\brain\` on Windows, `~/.gemini/antigravity/brain/` on macOS / Linux).
2. **Never hand-edit `config.json`.** Do not edit `~/.gemini/config/config.json` or call restricted mutation RPCs. To let the user enable or open the plugin, give them links: `[Context Gauge](customization://context-gauge)` and `[Context Gauge](sidecar://context-gauge/context_monitor/)`.
3. **No personal data in the repository.** No usernames, drive letters, absolute home paths, transcripts, conversation IDs or screenshots with private chat content. Use placeholders such as `%USERPROFILE%`, `~` or `<appData>`.
4. **Zero external bloat.** Standard-library Node only. Self-contained vanilla HTML/CSS/JS. No build step, no npm dependencies, no network calls.
5. **Confirm destructive or external actions.** Ask before deleting files, publishing a release or pushing to a remote.
6. **Plain language.** Keep UI text and explanations short and plain-English (ASD-STE100 style). The audience includes people who are not developers.
