using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dashboard.Core.Infrastructure;

namespace Dashboard.Core.Avatars;

/// <summary>A friend's last-known avatar recipe, so they can roam the plaza as an NPC while offline.</summary>
public sealed record FriendEntry(string Code, AvatarDna Dna, DateTimeOffset LastSeen);

/// <summary>
/// The local player's friend code plus every friend met over P2P (friends.json). Recipes from peers are untrusted:
/// <see cref="Remember"/> runs them through <see cref="AvatarDna.TryParse"/> and pins their id to the friend code.
/// File access is off the UI thread; saves are debounced and atomic.
/// </summary>
public sealed class FriendStore
{
    // No 0/O/1/I so codes survive being read aloud or typed from a screenshot.
    private const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public const int CodeLength = 6;
    private const int MaxFriends = 50;
    private static readonly TimeSpan SaveDelay = TimeSpan.FromMilliseconds(500);

    private readonly string _path;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private Dictionary<string, FriendEntry> _friends = new(StringComparer.Ordinal);
    private CancellationTokenSource? _pendingSave;

    public FriendStore(string path) => _path = path;

    public string FriendCode { get; private set; } = string.Empty;

    public IReadOnlyList<FriendEntry> Friends
    {
        get { lock (_gate) return _friends.Values.OrderByDescending(f => f.LastSeen).ToList(); }
    }

    public static bool IsValidCode(string? code) =>
        code is { Length: CodeLength } && code.All(c => CodeAlphabet.Contains(c));

    public static string FriendAvatarId(string code) => "friend_" + code;

    public async Task LoadAsync()
    {
        var file = await Task.Run(() =>
        {
            try
            {
                return File.Exists(_path)
                    ? JsonSerializer.Deserialize(File.ReadAllText(_path), FriendJsonContext.Default.FriendFile)
                    : null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                Log.Warn($"Could not read {_path}; starting with no friends", ex);
                return null;
            }
        }).ConfigureAwait(false);

        var dirty = false;
        lock (_gate)
        {
            FriendCode = IsValidCode(file?.FriendCode) ? file!.FriendCode! : NewCode();
            dirty = FriendCode != file?.FriendCode;
            _friends = new Dictionary<string, FriendEntry>(StringComparer.Ordinal);
            foreach (var f in file?.Friends ?? [])
            {
                if (!IsValidCode(f.Code) || AvatarDna.TryParse(f.Dna) is not { } dna) continue;
                _friends[f.Code!] = new FriendEntry(f.Code!, dna with { Id = FriendAvatarId(f.Code!) }, f.LastSeen);
            }
        }
        if (dirty) ScheduleSave(); // persist a freshly generated code
    }

    /// <summary>Validates and caches a peer's recipe. Returns the normalised recipe (id = friend_CODE) or null.</summary>
    public AvatarDna? Remember(string code, string dnaJson)
    {
        if (!IsValidCode(code) || code == FriendCode) return null;
        if (AvatarDna.TryParse(dnaJson) is not { } dna) return null;
        dna = dna with { Id = FriendAvatarId(code) };

        lock (_gate)
        {
            _friends[code] = new FriendEntry(code, dna, DateTimeOffset.UtcNow);
            if (_friends.Count > MaxFriends)
            {
                var oldest = _friends.Values.MinBy(f => f.LastSeen)!;
                _friends.Remove(oldest.Code);
            }
        }
        ScheduleSave();
        return dna;
    }

    public bool Forget(string code)
    {
        bool removed;
        lock (_gate) removed = _friends.Remove(code);
        if (removed) ScheduleSave();
        return removed;
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

    private void ScheduleSave()
    {
        CancellationTokenSource debounce;
        lock (_gate)
        {
            _pendingSave?.Cancel();
            _pendingSave = debounce = new CancellationTokenSource();
        }
        _ = SaveAfterDelayAsync(debounce.Token);
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
        FriendFile file;
        lock (_gate)
        {
            file = new FriendFile
            {
                FriendCode = FriendCode,
                Friends = _friends.Values.Select(f => new FriendRecord { Code = f.Code, Dna = f.Dna.ToJson(), LastSeen = f.LastSeen }).ToList(),
            };
        }

        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            var temp = _path + ".tmp";
            await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(file, FriendJsonContext.Default.FriendFile)).ConfigureAwait(false);
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

    private static string NewCode() =>
        string.Create(CodeLength, 0, (span, _) =>
        {
            for (var i = 0; i < span.Length; i++) span[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)];
        });

    internal sealed class FriendFile
    {
        public string? FriendCode { get; set; }
        public List<FriendRecord>? Friends { get; set; }
    }

    internal sealed class FriendRecord
    {
        public string? Code { get; set; }
        public string? Dna { get; set; }
        public DateTimeOffset LastSeen { get; set; }
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(FriendStore.FriendFile))]
internal sealed partial class FriendJsonContext : JsonSerializerContext;
