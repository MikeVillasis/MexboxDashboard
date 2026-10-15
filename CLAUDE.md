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
- **Phase 4 next:** `SmtcMediaService : IMediaService` over WinRT `GlobalSystemMediaTransportControlsSessionManager`
  (events only, no polling; thumbnail via `TryGetMediaPropertiesAsync().Thumbnail.OpenReadAsync()`), replacing `NullMediaService`.
- **Phase 5:** polish: settings persistence (sound, windowed mode, SteamGridDB key UI), focus animations, sound assets.

## Cover conventions
- Scanners never set `CoverArtPath`. They put art hints in `Metadata` using `GameMetadataKeys`
  (`coverSource`, `coverUrl`, `iconSource`, `coverBackground`, `steamAppId`), and the pipeline owns `CoverArtPath`.
- Cover file names: `{id}~g{hash}.jpg` generated, `{id}~c{ticks}.jpg` custom, `{id}~sgdb.miss` SteamGridDB negative cache.

## Conventions
- Core (`src/Dashboard.Core`) must never reference WPF. UI-thread work only in `src/Dashboard.App`.
- WPF project has no implicit `System.IO` using — add `using System.IO;` explicitly (avoid `System.Windows.Shapes` clash on `Path`).
- Scanner contract: return normally = complete installed set; throw = failed scan (cache kept).
- Lowercase UI copy, Segoe UI Semibold, blade palette in `Themes/Palette.xaml`.
