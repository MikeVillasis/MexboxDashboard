using System.Text.Json;
using System.Text.Json.Serialization;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Microsoft.Data.Sqlite;

namespace Dashboard.Core.Data;

/// <summary>
/// SQLite-backed library cache. The UI renders straight from this on boot, then a background delta scan corrects it.
/// Every public method hops to the thread pool, so callers on the UI thread never wait on disk.
/// </summary>
public sealed class SqliteGameLibraryCache : IGameLibraryCache
{
    private const int SchemaVersion = 1;

    private const string SchemaSql = """
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS games (
            id               TEXT    PRIMARY KEY,
            platform         TEXT    NOT NULL,
            platform_game_id TEXT    NOT NULL,
            title            TEXT    NOT NULL,
            sort_title       TEXT    NOT NULL COLLATE NOCASE,
            install_path     TEXT,
            launch_uri       TEXT,
            executable_path  TEXT,
            launch_args      TEXT,
            cover_path       TEXT,
            custom_cover     INTEGER NOT NULL DEFAULT 0,
            metadata         TEXT,
            first_seen       INTEGER NOT NULL,
            last_seen        INTEGER NOT NULL,
            last_played      INTEGER,
            play_count       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS ix_games_platform ON games(platform);
        CREATE INDEX IF NOT EXISTS ix_games_sort     ON games(sort_title);
        """;

    private const string SelectAllSql = """
        SELECT platform, platform_game_id, title, install_path, launch_uri, executable_path,
               launch_args, cover_path, custom_cover, metadata, last_played, play_count
        FROM games
        ORDER BY sort_title;
        """;

    private const string UpsertSql = """
        INSERT INTO games (id, platform, platform_game_id, title, sort_title, install_path, launch_uri,
                           executable_path, launch_args, cover_path, custom_cover, metadata,
                           first_seen, last_seen, last_played, play_count)
        VALUES ($id, $platform, $pid, $title, $sort, $install, $uri, $exe, $args, $cover, $custom, $meta,
                $now, $now, $played, $count)
        ON CONFLICT(id) DO UPDATE SET
            title           = excluded.title,
            sort_title      = excluded.sort_title,
            install_path    = excluded.install_path,
            launch_uri      = excluded.launch_uri,
            executable_path = excluded.executable_path,
            launch_args     = excluded.launch_args,
            cover_path      = CASE WHEN games.custom_cover = 1 AND excluded.custom_cover = 0
                                   THEN games.cover_path ELSE excluded.cover_path END,
            custom_cover    = MAX(games.custom_cover, excluded.custom_cover),
            metadata        = excluded.metadata,
            last_seen       = excluded.last_seen;
        """;

    private readonly string _connectionString;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly object _initGate = new();
    private volatile bool _initialized;

    public SqliteGameLibraryCache(string databasePath)
    {
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            Pooling = true,
        }.ToString();
    }

    public Task InitializeAsync(CancellationToken ct) => Task.Run(EnsureInitialized, ct);

    public Task<IReadOnlyList<GameEntry>> LoadAllAsync(CancellationToken ct) => Task.Run<IReadOnlyList<GameEntry>>(() =>
    {
        EnsureInitialized();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = SelectAllSql;

        var results = new List<GameEntry>(256);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            ct.ThrowIfCancellationRequested();
            results.Add(new GameEntry
            {
                Platform = reader.GetString(0),
                PlatformGameId = reader.GetString(1),
                Title = reader.GetString(2),
                InstallPath = GetNullableString(reader, 3),
                LaunchUri = GetNullableString(reader, 4),
                ExecutablePath = GetNullableString(reader, 5),
                LaunchArguments = GetNullableString(reader, 6),
                CoverArtPath = GetNullableString(reader, 7),
                HasCustomCover = reader.GetInt64(8) != 0,
                Metadata = DeserializeMetadata(GetNullableString(reader, 9)),
                LastPlayed = reader.IsDBNull(10) ? null : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(10)),
                PlayCount = reader.GetInt32(11),
            });
        }
        return results;
    }, ct);

    public async Task ApplyChangesAsync(IReadOnlyCollection<GameEntry> upserts, IReadOnlyCollection<string> removedIds, CancellationToken ct)
    {
        if (upserts.Count == 0 && removedIds.Count == 0) return;

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await Task.Run(() => ApplyChangesCore(upserts, removedIds, ct), ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public Task SetCoverAsync(string gameId, string? coverPath, bool isCustom, CancellationToken ct) =>
        ExecuteWriteAsync(
            "UPDATE games SET cover_path = $cover, custom_cover = $custom WHERE id = $id;",
            command =>
            {
                command.Parameters.AddWithValue("$cover", (object?)coverPath ?? DBNull.Value);
                command.Parameters.AddWithValue("$custom", isCustom ? 1 : 0);
                command.Parameters.AddWithValue("$id", gameId);
            },
            ct);

    public Task RecordLaunchAsync(string gameId, DateTimeOffset launchedAt, CancellationToken ct) =>
        ExecuteWriteAsync(
            "UPDATE games SET last_played = $played, play_count = play_count + 1 WHERE id = $id;",
            command =>
            {
                command.Parameters.AddWithValue("$played", launchedAt.ToUnixTimeMilliseconds());
                command.Parameters.AddWithValue("$id", gameId);
            },
            ct);

    private void ApplyChangesCore(IReadOnlyCollection<GameEntry> upserts, IReadOnlyCollection<string> removedIds, CancellationToken ct)
    {
        EnsureInitialized();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        using var connection = Open();
        using var transaction = connection.BeginTransaction();

        if (upserts.Count > 0)
        {
            using var upsert = connection.CreateCommand();
            upsert.Transaction = transaction;
            upsert.CommandText = UpsertSql;
            var pId = upsert.Parameters.Add("$id", SqliteType.Text);
            var pPlatform = upsert.Parameters.Add("$platform", SqliteType.Text);
            var pPid = upsert.Parameters.Add("$pid", SqliteType.Text);
            var pTitle = upsert.Parameters.Add("$title", SqliteType.Text);
            var pSort = upsert.Parameters.Add("$sort", SqliteType.Text);
            var pInstall = upsert.Parameters.Add("$install", SqliteType.Text);
            var pUri = upsert.Parameters.Add("$uri", SqliteType.Text);
            var pExe = upsert.Parameters.Add("$exe", SqliteType.Text);
            var pArgs = upsert.Parameters.Add("$args", SqliteType.Text);
            var pCover = upsert.Parameters.Add("$cover", SqliteType.Text);
            var pCustom = upsert.Parameters.Add("$custom", SqliteType.Integer);
            var pMeta = upsert.Parameters.Add("$meta", SqliteType.Text);
            var pNow = upsert.Parameters.Add("$now", SqliteType.Integer);
            var pPlayed = upsert.Parameters.Add("$played", SqliteType.Integer);
            var pCount = upsert.Parameters.Add("$count", SqliteType.Integer);
            upsert.Prepare();

            foreach (var game in upserts)
            {
                ct.ThrowIfCancellationRequested();
                pId.Value = game.Id;
                pPlatform.Value = game.Platform;
                pPid.Value = game.PlatformGameId;
                pTitle.Value = game.Title;
                pSort.Value = game.SortTitle;
                pInstall.Value = DbValue(game.InstallPath);
                pUri.Value = DbValue(game.LaunchUri);
                pExe.Value = DbValue(game.ExecutablePath);
                pArgs.Value = DbValue(game.LaunchArguments);
                pCover.Value = DbValue(game.CoverArtPath);
                pCustom.Value = game.HasCustomCover ? 1 : 0;
                pMeta.Value = SerializeMetadata(game.Metadata);
                pNow.Value = now;
                pPlayed.Value = game.LastPlayed is { } played ? played.ToUnixTimeMilliseconds() : DBNull.Value;
                pCount.Value = game.PlayCount;
                upsert.ExecuteNonQuery();
            }
        }

        if (removedIds.Count > 0)
        {
            using var delete = connection.CreateCommand();
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM games WHERE id = $id;";
            var pId = delete.Parameters.Add("$id", SqliteType.Text);
            delete.Prepare();
            foreach (var id in removedIds)
            {
                ct.ThrowIfCancellationRequested();
                pId.Value = id;
                delete.ExecuteNonQuery();
            }
        }

        transaction.Commit();
    }

    private async Task ExecuteWriteAsync(string sql, Action<SqliteCommand> bind, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await Task.Run(() =>
            {
                EnsureInitialized();
                using var connection = Open();
                using var command = connection.CreateCommand();
                command.CommandText = sql;
                bind(command);
                command.ExecuteNonQuery();
            }, ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private void EnsureInitialized()
    {
        if (_initialized) return;
        lock (_initGate)
        {
            if (_initialized) return;

            using var connection = Open();
            using (var schema = connection.CreateCommand())
            {
                schema.CommandText = SchemaSql;
                schema.ExecuteNonQuery();
            }

            using (var version = connection.CreateCommand())
            {
                version.CommandText = "PRAGMA user_version;";
                var current = Convert.ToInt32(version.ExecuteScalar());
                if (current < SchemaVersion)
                {
                    // Future migrations go here, keyed on `current`.
                    version.CommandText = $"PRAGMA user_version = {SchemaVersion};";
                    version.ExecuteNonQuery();
                    Log.Info($"Library cache schema set to v{SchemaVersion}");
                }
            }

            _initialized = true;
        }
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;";
        pragma.ExecuteNonQuery();
        return connection;
    }

    private static object DbValue(string? value) => value is null ? DBNull.Value : value;

    private static string? GetNullableString(SqliteDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static object SerializeMetadata(IReadOnlyDictionary<string, string> metadata)
    {
        if (metadata.Count == 0) return DBNull.Value;
        var dictionary = metadata as Dictionary<string, string> ?? new Dictionary<string, string>(metadata);
        return JsonSerializer.Serialize(dictionary, CoreJsonContext.Default.DictionaryStringString);
    }

    private static IReadOnlyDictionary<string, string> DeserializeMetadata(string? json)
    {
        if (string.IsNullOrEmpty(json)) return new Dictionary<string, string>();
        try
        {
            return JsonSerializer.Deserialize(json, CoreJsonContext.Default.DictionaryStringString)
                   ?? new Dictionary<string, string>();
        }
        catch (JsonException)
        {
            return new Dictionary<string, string>();
        }
    }
}

/// <summary>Source-generated JSON metadata: no reflection cost at startup.</summary>
[JsonSerializable(typeof(Dictionary<string, string>))]
internal sealed partial class CoreJsonContext : JsonSerializerContext
{
}
