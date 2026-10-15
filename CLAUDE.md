# Xbox 360 Dashboard: project context for Claude

Native Windows games launcher + system media controller styled after the 2005 Xbox 360 "Blades" dashboard.
C# / .NET 8 / WPF (`net8.0-windows10.0.19041.0`). Full architecture, controls and structure: see `README.md`.

## Hard requirements (from the original brief)
- Locked 60+ FPS blade transitions and library scrolling; cold start < 500 ms; idle RAM < 80 MB.
- All disk I/O, registry, SQLite, image decode and network run off the UI thread.
- Launch games ONLY via the platform's URI protocol / bootstrapper so the parent client handles sign-in, DRM, anti-cheat.
- Input parity: mouse/keyboard and XInput (LB/RB or Left/Right switch blades, A launch, Y edit cover art).
- No stubbed pseudo-code; every phase ships working code.

## Status
- **Phase 1 done** (builds clean). Core models, `IGameScanner`, SQLite cache, `GameLibraryService`, Steam scanner,
  Blades UI shell, XInput, sound hooks, Games/Media/System views.
- **Phase 3 done.** Scanners in `Scanners/{Steam,Xbox,Epic,BattleNet,Riot}`, all registered in `App.xaml.cs`.
  Cover pipeline: `Services/CoverArtPipeline` + `Imaging/CoverTranscoder` (WinRT imaging, 400x600 JPEG) +
  `Imaging/SteamGridDbClient` (opt-in via `STEAMGRIDDB_API_KEY` or `%AppData%\Xbox360Launcher\steamgriddb.key`).
  `GameLibraryService` runs a background cover pass after each scan.
- **Phase 4 done.** `Services/SmtcMediaService` over WinRT `GlobalSystemMediaTransportControlsSessionManager`
  (events only, no polling), registered in `App.xaml.cs`; `NullMediaService` removed. Keep the thumbnail `byte[]` reference
  stable for an unchanged track: `MediaViewModel` re-decodes only when the reference changes.
- **Phase 5 done.** Hover-to-focus game list, 600x850 centred preview with VisualBrush reflection, bigger play pill,
  Media blade centred at 1.5x, synthesised UI sounds (`tools/generate_sounds.py` → `Assets/Sounds`),
  `Settings/SettingsStore` (settings.json: sound, fullscreen, window bounds, last game; debounced atomic writes off the UI thread),
  focus animations (`Animation/FocusPop`, animated `BladeListItem`). Blades are `BitmapCache`d only while sliding
  (`Blade.SetCached`); keep animations inside the front blade to opacity/render transforms.
- **WebView2 hybrid shell, phase 1 of 5 done** (run with `--web`; native WPF shell stays the default until the web UI
  reaches parity). `Web/WebShellWindow` hosts WebView2 (WPF control; the app is WPF, not WinForms) serving
  `WebAssets/` as `https://xbox.local/`. `Web/XboxHostBridge` = `hostObjects.xboxBackend` (thin forwards to existing
  services, JSON strings out). `Web/WebMessageDispatcher` = `{type,payload}` envelopes both ways. Keyboard: the page
  forwards `KEY`, C# maps to `NAV` (same as XInput). Events posted before page load are lost; put state in `HOST_READY`.
  The `--web` shell relaxes the RAM/startup targets: about 150 MB host plus 340 MB in WebView2 processes, page ready about 2.7 s.
  Next phases: 2D blades UI over a Three.js canvas, avatar DNA, plaza AI, P2P (zero-cost).
- SteamGridDB: intentionally left as-is (opt-in by API key, no UI). The owner does not plan to use it.

## Cover conventions
- Scanners never set `CoverArtPath`. They put art hints in `Metadata` using `GameMetadataKeys`
  (`coverSource`, `coverUrl`, `iconSource`, `coverBackground`, `steamAppId`), and the pipeline owns `CoverArtPath`.
- Cover file names: `{id}~g{hash}.jpg` generated, `{id}~c{ticks}.jpg` custom, `{id}~sgdb.miss` SteamGridDB negative cache.

## Conventions
- Core (`src/Dashboard.Core`) must never reference WPF. UI-thread work only in `src/Dashboard.App`.
- WPF project has no implicit `System.IO` using — add `using System.IO;` explicitly (avoid `System.Windows.Shapes` clash on `Path`).
- Scanner contract: return normally = complete installed set; throw = failed scan (cache kept).
- Lowercase UI copy, Segoe UI Semibold, blade palette in `Themes/Palette.xaml`.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/` (no git remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
