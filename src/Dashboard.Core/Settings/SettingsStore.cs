using System.Text.Json;
using Dashboard.Core.Infrastructure;

namespace Dashboard.Core.Settings;

/// <summary>
/// Loads and saves <see cref="DashboardSettings"/>. Every file access runs on the thread pool; callers only swap an
/// in-memory record. Saves are debounced (a burst of changes is one write) and atomic (temp file + rename), so a crash
/// mid-write never leaves a corrupt settings file.
/// </summary>
public sealed class SettingsStore
{
    private static readonly TimeSpan SaveDelay = TimeSpan.FromMilliseconds(400);

    private readonly string _path;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private DashboardSettings _current = DashboardSettings.Default;
    private CancellationTokenSource? _pendingSave;

    public SettingsStore(string path) => _path = path;

    public DashboardSettings Current
    {
        get { lock (_gate) return _current; }
    }

    /// <summary>Reads the file off the UI thread. A missing or unreadable file yields defaults.</summary>
    public async Task<DashboardSettings> LoadAsync()
    {
        var loaded = await Task.Run(ReadFile).ConfigureAwait(false);
        lock (_gate) _current = loaded;
        return loaded;
    }

    /// <summary>Applies <paramref name="change"/> and schedules a save. Safe from any thread.</summary>
    public void Update(Func<DashboardSettings, DashboardSettings> change)
    {
        CancellationTokenSource debounce;
        lock (_gate)
        {
            var next = change(_current);
            if (next == _current) return;
            _current = next;

            _pendingSave?.Cancel();
            _pendingSave = debounce = new CancellationTokenSource();
        }
        _ = SaveAfterDelayAsync(debounce.Token);
    }

    /// <summary>Writes any pending change now; call on shutdown. Waits at most <paramref name="timeout"/>.</summary>
    public void Flush(TimeSpan timeout)
    {
        CancellationTokenSource? pending;
        lock (_gate)
        {
            pending = _pendingSave;
            _pendingSave = null;
        }
        if (pending is null) return;

        pending.Cancel();
        Task.Run(WriteCurrentAsync).Wait(timeout);
    }

    private async Task SaveAfterDelayAsync(CancellationToken ct)
    {
        try
        {
            await Task.Delay(SaveDelay, ct).ConfigureAwait(false);
            lock (_gate)
            {
                if (ct.IsCancellationRequested) return;
                _pendingSave = null;
            }
            await WriteCurrentAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Superseded by a newer change or flushed on shutdown.
        }
    }

    private async Task WriteCurrentAsync()
    {
        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var json = JsonSerializer.SerializeToUtf8Bytes(Current, SettingsJsonContext.Default.DashboardSettings);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var temp = _path + ".tmp";
            await File.WriteAllBytesAsync(temp, json).ConfigureAwait(false);
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"Could not save settings to {_path}", ex);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private DashboardSettings ReadFile()
    {
        try
        {
            if (!File.Exists(_path)) return DashboardSettings.Default;
            return JsonSerializer.Deserialize(File.ReadAllBytes(_path), SettingsJsonContext.Default.DashboardSettings)
                   ?? DashboardSettings.Default;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Log.Warn($"Could not read settings from {_path}; using defaults", ex);
            return DashboardSettings.Default;
        }
    }
}
