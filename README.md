# Xbox 360 Dashboard: Games Launcher

A native Windows games launcher and media controller styled after the 2005 Xbox 360 "Blades" dashboard.
C# / .NET 8 / WPF, no Electron or CEF.

## Status: complete (phases 1–5)

| Phase | Scope | State |
|---|---|---|
| 1 | Solution layout, core models, `IGameScanner`, SQLite cache, library service, Blades UI shell, input, sound hooks | **done** |
| 2 | (folded into 1) data model and schema | **done** |
| 3 | Xbox / Epic / Battle.net / Riot scanners, cover pipeline (400x600 transcode, platform caches, SteamGridDB, icon fallback) | **done** |
| 4 | WinRT SMTC media service (`GlobalSystemMediaTransportControlsSessionManager`) | **done** |
| 5 | Visual polish pass: blade audio, focus animations, settings persistence | **done** |

Supported storefronts:

| Platform | Discovery | Launch |
|---|---|---|
| Steam | `libraryfolders.vdf` → `appmanifest_*.acf` | `steam://rungameid/{appId}` |
| Xbox / MS Store | WinRT `PackageManager` (Store-signed, `MicrosoftGame.config` or under a `.GamingRoot` folder) | `shell:AppsFolder\{PFN}!{AppId}` |
| Epic | `{AppDataPath}\Manifests\*.item` (`games` category only, no DLC or engines) | `com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true` |
| Battle.net | Agent `product.db` (protobuf) + `aggregate.json` + Blizzard uninstall keys | `battlenet://…`, falling back to `Battle.net.exe --exec="launch {code}"` |
| Riot | `Metadata\{product}.{patchline}\*.product_settings.yaml` + `RiotClientInstalls.json` | `RiotClientServices.exe --launch-product=… --launch-patchline=…` |

## Build & run

Requirements: Windows 10 2004+ / 11, .NET 8 SDK, Visual Studio 2022 17.8+ (or just the CLI).

```powershell
cd C:\Dev\WinForms\Xbox360Dashboard
dotnet build -c Debug
dotnet run --project src\Dashboard.App

# Release build tuned for startup (ReadyToRun precompiled):
dotnet publish src\Dashboard.App -c Release -r win-x64 --self-contained false -o publish
```

Data lives in `%AppData%\Xbox360Launcher\` (`library.db`, `settings.json`, `Covers\`, `dashboard.log`).

**Settings** persist automatically: sound on/off and fullscreen/windowed (System blade or F11), the last windowed
size and position (ignored if that monitor is gone), and the focused game. Delete `settings.json` to reset.

**Optional SteamGridDB covers.** Games with no art from their own launcher can pull a portrait grid from
[SteamGridDB](https://www.steamgriddb.com/profile/preferences/api). Put your API key in the `STEAMGRIDDB_API_KEY`
environment variable or in `%AppData%\Xbox360Launcher\steamgriddb.key`. Without a key the dashboard never contacts SteamGridDB.

## Controls

| Action | Keyboard | Gamepad | Mouse |
|---|---|---|---|
| Switch blade | ← / → · Q / E · Tab / Shift+Tab | LB / RB · D-pad / stick ← → | click a blade tab or header name |
| Move in list | ↑ / ↓ · PgUp / PgDn | D-pad / stick ↑ ↓ · LT / RT (page) | click / wheel |
| Launch / select | Enter · Space | A · Start | double-click · **play** button |
| Back to Games | Esc · Backspace | B | |
| Custom cover art | Y · F2 | Y | right-click a game or the cover · drag & drop an image onto the cover |
| Media prev / next | X / Y (Media blade) | X / Y | transport buttons |
| Fullscreen ↔ window | F11 | | System blade → toggle fullscreen |

## Project structure

```
Xbox360Dashboard.sln
Directory.Build.props                 net8.0-windows10.0.19041.0, nullable, implicit usings
src/
├─ Dashboard.Core/                    UI-free engine (no WPF references)
│  ├─ Abstractions/                   IGameScanner, IGameLibraryCache, ICoverArtService, IMediaService
│  ├─ Models/                         GameEntry (immutable record), GameMetadataKeys, LibraryChangedEventArgs, MediaSessionInfo, TitleSort
│  ├─ Data/SqliteGameLibraryCache     WAL-mode SQLite, single-transaction delta upserts, source-generated JSON metadata
│  ├─ Services/GameLibraryService     cache-first boot → parallel scans → diff → persist → publish delta → cover pass
│  ├─ Services/CoverArtPipeline       source priority, 400x600 cache, custom imports, pruning
│  ├─ Services/SmtcMediaService       system "now playing" over WinRT GSMTC, event driven, artwork reused per track
│  ├─ Imaging/                        CoverTranscoder (WinRT Windows.Graphics.Imaging), SteamGridDbClient
│  ├─ Scanners/Steam/                 SteamScanner + forgiving VDF/ACF parser
│  ├─ Scanners/Xbox/                  XboxScanner (PackageManager, .GamingRoot, Appx / MicrosoftGame.config logos)
│  ├─ Scanners/Epic/                  EpicScanner (.item JSON manifests)
│  ├─ Scanners/BattleNet/             BattleNetScanner + minimal protobuf reader for product.db
│  ├─ Scanners/Riot/                  RiotScanner (product_settings.yaml, RiotClientInstalls.json)
│  └─ Infrastructure/                 AppPaths, async file Log, ShellLauncher (URI / bootstrapper launch)
└─ Dashboard.App/                     WPF shell
   ├─ Controls/
   │  ├─ BladeStackPanel              lays blades out, slides them with a spring ease via TranslateTransform only
   │  ├─ Blade                        themed ContentControl, bitmap-cached, fades its content in/out
   │  ├─ BladeChrome                  one OnRender pass: concave lip, gradient plastic, bloom, gloss, rim, vertical label
   │  └─ CoverArt                     jewel-case cover, async decode, placeholder with title / initials
   ├─ Animation/                      SpringEase, CubicBezierEase
   ├─ Imaging/                        CoverImageCache (off-thread decode, 24 MB LRU), NoiseTexture
   ├─ Input/                          NavAction + IBladeView, XInputService (background poll, edge + repeat)
   ├─ Audio/SoundService              preloaded WAV cues (Assets/Sounds, generated by tools/generate_sounds.py)
   ├─ ViewModels/                     Games, Media, System blades
   ├─ Views/                          GamesBladeView, MediaBladeView, SystemBladeView
   └─ Themes/                         Palette (colours, gloss, glyphs), Controls (pills, list, cover), Blade
```

## Architecture notes

**Adding a platform** is one class plus one line in `App.xaml.cs`:

```csharp
public sealed class EpicScanner : IGameScanner
{
    public string PlatformName => "Epic";
    public Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct) { /* parse .item manifests */ }
    public Task LaunchGameAsync(GameEntry game) { ShellLauncher.OpenUri(game.LaunchUri!); return Task.CompletedTask; }
}
```

Scanner contract: return normally = complete installed set (missing games get removed); throw = scan failed (cache for that platform is kept). User data (custom cover, play count, last played) is merged back over fresh scan results.

**Cover pipeline.** Scanners never set `CoverArtPath`; they describe where art lives through `GameEntry.Metadata`
(`coverSource` local file, `coverUrl` platform URL, `iconSource` executable, `coverBackground` tint). After every scan,
`GameLibraryService` runs a background pass (two games at a time) that asks `CoverArtPipeline` for each game's cover:

1. platform cache file (Steam `library_600x900` / `library_capsule` / header, Xbox `Square480x480Logo` etc., Riot `.ico`)
2. platform-published URL (Battle.net box art from `aggregate.json`)
3. SteamGridDB, if an API key is configured (exact match by Steam AppId, else title search)
4. the executable's shell icon

The winning source is transcoded with WinRT `Windows.Graphics.Imaging` into a 400x600 JPEG. Portrait art is scaled and centre-cropped;
logos and icons are centred on a gradient tinted by the manifest's background colour or the art's average colour. Output files are named
`{game}~g{hash of source}.jpg`, so an unchanged source costs one `File.Exists` and a changed one regenerates automatically.
Custom covers go through the same transcoder (`{game}~c{ticks}.jpg`) and the pass never replaces them. Cover writes are
serialised so a generated cover cannot overwrite a custom one picked mid-pass. Generated covers of uninstalled games are pruned.

**Media.** `SmtcMediaService` follows the same session as the Windows volume flyout (Spotify, browsers, VLC…) through WinRT
`GlobalSystemMediaTransportControlsSessionManager`. It never polls: `CurrentSessionChanged` / `SessionsChanged` choose the
session (falling back to any playing session when Windows reports none), `MediaPropertiesChanged` re-reads metadata and
artwork, and `PlaybackInfoChanged` re-reads state and enabled controls. Artwork bytes are reused while the track is unchanged,
so play/pause never re-decodes the image. Packaged players get their display name from `AppInfo`; Win32 ones from their exe name.

**Threading.** The UI thread only renders and handles input. SQLite, registry, manifest parsing, image decoding, logging and ShellExecute all run on the thread pool; results come back through `Dispatcher.InvokeAsync`. XInput polls on its own thread and drops to 10 Hz while the window is inactive.

**60 FPS blades.** Each blade is arranged once at a fixed size and cached as a GPU texture (`BitmapCache`, at the monitor's DPI) while it slides; the front blade drops its cache once settled, so focus animations (list highlight pop, preview and album-art settle) redraw only what moves. Switching blades animates only `TranslateTransform.X`, so frames are pure compositing with no layout or re-tessellation. The blade body is a single retained `OnRender` drawing, and the drop shadow is faked with offset geometry instead of a pixel shader. The breathing aura is the only perpetual animation, and it pauses when the window loses focus or minimises so WPF's render loop can idle while a game runs.

**Startup.** No DI container, no reflection-based JSON, ReadyToRun on publish, cache read off-thread, and the window shows before the library is loaded. `dashboard.log` records "Library on screen N ms after window creation" for measuring against the 500 ms target.

**Memory.** Covers decode at display size (80 px thumbnails, 400 px preview), the cache is capped at 24 MB, list containers are virtualised and recycled, and `GCConserveMemory` is enabled. A bare WPF window already uses roughly 45–60 MB of working set, so the 80 MB idle target is achievable but tight. Check the System blade's memory readout.

## Known gaps

- WebP decoding (Battle.net box art, `.webp` custom covers) relies on the Windows WebP codec, which ships with Windows 11 and most Windows 10 installs. Without it those games fall back to their executable icon.
- Xbox titles with no `MicrosoftGame.config` that also sit outside every `.GamingRoot` folder (older UWP games) are not detected.
- Generated covers carry no title text. The list row and preview already show the title.
- UI sounds are synthesised by `tools/generate_sounds.py` (original, no third-party rights). `SoundPlayer` plays one cue at a time, so a new cue cuts the previous one.
- The "Convection" typeface is not bundled. The UI uses Segoe UI Semibold; change `DashFont` in `Themes/Palette.xaml`.

## Credits
- Plaza avatar body (Discord Activity): this work is based on
  ["sculpting a human body"](https://sketchfab.com/3d-models/sculpting-a-human-body-a24baf3514834527972bffdad882258e)
  by [Animation-class-k](https://sketchfab.com/Animation-class-k), licensed under
  [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). Source in `assets/characters/sculpting_a_human_body/`
  (with its `license.txt`); `activity/tools/build-mannequin.mjs` scales, relabels and simplifies it into
  `activity/models/mannequin.glb`.
