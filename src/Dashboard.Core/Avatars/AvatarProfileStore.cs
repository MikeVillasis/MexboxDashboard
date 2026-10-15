using Dashboard.Core.Infrastructure;

namespace Dashboard.Core.Avatars;

/// <summary>
/// The local player's avatar recipe in %AppData%\Xbox360Launcher\localProfile.json. Reads and writes run on the thread
/// pool; writes are debounced (live customising produces bursts) and atomic (temp file + rename).
/// </summary>
public sealed class AvatarProfileStore
{
    private static readonly TimeSpan SaveDelay = TimeSpan.FromMilliseconds(500);

    private readonly string _path;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private AvatarDna _current;
    private CancellationTokenSource? _pendingSave;

    public AvatarProfileStore(string path, string defaultName)
    {
        _path = path;
        _current = AvatarDna.CreateDefault(defaultName);
    }

    public AvatarDna Current
    {
        get { lock (_gate) return _current; }
    }

    public async Task<AvatarDna> LoadAsync()
    {
        var loaded = await Task.Run(() =>
        {
            try
            {
                return File.Exists(_path) ? AvatarDna.TryParse(File.ReadAllText(_path)) : null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn($"Could not read {_path}; using the default avatar", ex);
                return null;
            }
        }).ConfigureAwait(false);

        lock (_gate)
        {
            if (loaded is not null) _current = loaded with { Id = "local" };
            return _current;
        }
    }

    /// <summary>Validates and stores a recipe from the page. Returns the normalised recipe, or null if it was rejected.</summary>
    public AvatarDna? Update(string json)
    {
        var parsed = AvatarDna.TryParse(json);
        if (parsed is null) return null;
        parsed = parsed with { Id = "local" };

        CancellationTokenSource debounce;
        lock (_gate)
        {
            if (parsed == _current) return parsed;
            _current = parsed;
            _pendingSave?.Cancel();
            _pendingSave = debounce = new CancellationTokenSource();
        }
        _ = SaveAfterDelayAsync(debounce.Token);
        return parsed;
    }

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
        Task.Run(WriteAsync).Wait(timeout);
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
            await WriteAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task WriteAsync()
    {
        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var temp = _path + ".tmp";
            await File.WriteAllTextAsync(temp, Current.ToJson()).ConfigureAwait(false);
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"Could not save {_path}", ex);
        }
        finally
        {
            _writeLock.Release();
        }
    }
}
