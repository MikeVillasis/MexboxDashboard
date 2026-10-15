using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Dashboard.Core.Infrastructure;

namespace Dashboard.App.Imaging;

/// <summary>
/// Decodes cover images on the thread pool at the size they are displayed (DecodePixelWidth),
/// freezes them, and keeps a byte-budgeted LRU so scrolling never decodes on the UI thread.
/// </summary>
internal static class CoverImageCache
{
    private const long BudgetBytes = 24L * 1024 * 1024;

    private static readonly object Gate = new();
    private static readonly Dictionary<string, LinkedListNode<Entry>> Map = new(StringComparer.OrdinalIgnoreCase);
    private static readonly LinkedList<Entry> Lru = new();
    private static readonly Dictionary<string, Task<ImageSource?>> InFlight = new(StringComparer.OrdinalIgnoreCase);
    private static long _bytes;

    public static bool TryGet(string path, int decodeWidth, out ImageSource? image)
    {
        var key = MakeKey(path, decodeWidth);
        lock (Gate)
        {
            if (Map.TryGetValue(key, out var node))
            {
                Lru.Remove(node);
                Lru.AddFirst(node);
                image = node.Value.Image;
                return true;
            }
        }
        image = null;
        return false;
    }

    public static Task<ImageSource?> LoadAsync(string path, int decodeWidth)
    {
        var key = MakeKey(path, decodeWidth);
        lock (Gate)
        {
            if (Map.TryGetValue(key, out var node)) return Task.FromResult<ImageSource?>(node.Value.Image);
            if (InFlight.TryGetValue(key, out var pending)) return pending;

            var task = Task.Run(() => Decode(path, decodeWidth));
            InFlight[key] = task;
            _ = task.ContinueWith(t => Complete(key, t.Status == TaskStatus.RanToCompletion ? t.Result : null),
                CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return task;
        }
    }

    private static void Complete(string key, ImageSource? image)
    {
        lock (Gate)
        {
            InFlight.Remove(key);
            if (image is not BitmapSource bitmap || Map.ContainsKey(key)) return;

            var size = (long)bitmap.PixelWidth * bitmap.PixelHeight * 4;
            Map[key] = Lru.AddFirst(new Entry(key, image, size));
            _bytes += size;

            while (_bytes > BudgetBytes && Lru.Last is { } oldest && oldest != Lru.First)
            {
                Lru.RemoveLast();
                Map.Remove(oldest.Value.Key);
                _bytes -= oldest.Value.Bytes;
            }
        }
    }

    private static ImageSource? Decode(string path, int decodeWidth)
    {
        try
        {
            if (!File.Exists(path)) return null;

            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan);
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad; // read fully now so the stream can close
            bitmap.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
            if (decodeWidth > 0) bitmap.DecodePixelWidth = decodeWidth;
            bitmap.StreamSource = stream;
            bitmap.EndInit();
            bitmap.Freeze(); // required to hand it to the UI thread
            return bitmap;
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not decode cover {path}", ex);
            return null;
        }
    }

    private static string MakeKey(string path, int width) => string.Concat(width.ToString(), "|", path);

    private sealed record Entry(string Key, ImageSource Image, long Bytes);
}
