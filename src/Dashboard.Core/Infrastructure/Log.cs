using System.Diagnostics;
using System.Threading.Channels;

namespace Dashboard.Core.Infrastructure;

/// <summary>
/// Tiny fire-and-forget file logger. Callers (including the UI thread) only enqueue;
/// a single background task does the disk writes.
/// </summary>
public static class Log
{
    private const long MaxBytes = 1_000_000;
    private static readonly Channel<string> Queue = Channel.CreateUnbounded<string>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });

    private static Task? _writer;

    public static void Initialize(string path)
    {
        if (_writer is not null) return;
        _writer = Task.Run(() => WriteLoopAsync(path));
    }

    public static void Info(string message) => Enqueue("INFO", message);

    public static void Warn(string message, Exception? ex = null) => Enqueue("WARN", ex is null ? message : $"{message}: {ex}");

    public static void Error(string message, Exception? ex = null) => Enqueue("ERROR", ex is null ? message : $"{message}: {ex}");

    /// <summary>Flushes pending lines; call once on shutdown.</summary>
    public static void Shutdown(TimeSpan timeout)
    {
        Queue.Writer.TryComplete();
        _writer?.Wait(timeout);
    }

    private static void Enqueue(string level, string message)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {message}";
        Debug.WriteLine(line);
        Queue.Writer.TryWrite(line);
    }

    private static async Task WriteLoopAsync(string path)
    {
        try
        {
            if (File.Exists(path) && new FileInfo(path).Length > MaxBytes)
                File.Delete(path);

            await using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            await using var writer = new StreamWriter(stream) { AutoFlush = false };

            while (await Queue.Reader.WaitToReadAsync().ConfigureAwait(false))
            {
                while (Queue.Reader.TryRead(out var line))
                    await writer.WriteLineAsync(line).ConfigureAwait(false);
                await writer.FlushAsync().ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"Logger stopped: {ex}");
        }
    }
}
