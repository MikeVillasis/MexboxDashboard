using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.FileProperties;
using Windows.Storage.Streams;

namespace Dashboard.Core.Imaging;

/// <summary>
/// Turns any image the Windows Imaging Component can decode (JPEG, PNG, BMP, ICO, WebP with the codec, …) into a uniform
/// 400x600 JPEG. Portrait art is scaled and centre-cropped; logos and icons are fitted onto a tinted gradient backdrop.
/// Uses WinRT Windows.Graphics.Imaging, so it stays UI-framework free and runs entirely on the calling worker thread.
/// </summary>
internal static class CoverTranscoder
{
    public const int Width = 400;
    public const int Height = 600;

    // Art within this factor of 2:3 fills the cover; anything squarer or wider is fitted instead.
    private const double FillTolerance = 1.3;
    private const int MinFillWidth = 200;
    private const int FitBox = 320;
    private const float JpegQuality = 0.9f;

    public static async Task TranscodeFileAsync(string sourcePath, string destination, uint? background, CancellationToken ct)
    {
        await using var file = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
        using var stream = file.AsRandomAccessStream();
        await TranscodeAsync(stream, destination, background, forceFit: false, ct).ConfigureAwait(false);
    }

    public static async Task TranscodeBytesAsync(byte[] data, string destination, uint? background, CancellationToken ct)
    {
        using var memory = new MemoryStream(data, writable: false);
        using var stream = memory.AsRandomAccessStream();
        await TranscodeAsync(stream, destination, background, forceFit: false, ct).ConfigureAwait(false);
    }

    /// <summary>Renders the shell's 256 px icon for an executable (the same one Explorer shows).</summary>
    public static async Task TranscodeExecutableIconAsync(string exePath, string destination, uint? background, CancellationToken ct)
    {
        var file = await StorageFile.GetFileFromPathAsync(exePath).AsTask(ct).ConfigureAwait(false);
        using var thumbnail = await file.GetThumbnailAsync(ThumbnailMode.SingleItem, 256, ThumbnailOptions.ResizeThumbnail)
            .AsTask(ct).ConfigureAwait(false);
        if (thumbnail is null || thumbnail.Size == 0) throw new InvalidDataException($"No icon available for {exePath}.");
        await TranscodeAsync(thumbnail, destination, background, forceFit: true, ct).ConfigureAwait(false);
    }

    /// <summary>Parses "#RRGGBB" / "#AARRGGBB" into 0xRRGGBB; "transparent" or junk gives null.</summary>
    public static uint? ParseColor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value[0] != '#') return null;
        var hex = value[1..];
        if (hex.Length is not (6 or 8) || !uint.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var argb)) return null;
        if (hex.Length == 8 && argb >> 24 == 0) return null; // fully transparent: let the art pick the tint
        return argb & 0xFFFFFF;
    }

    private static async Task TranscodeAsync(IRandomAccessStream source, string destination, uint? background, bool forceFit, CancellationToken ct)
    {
        var decoder = await BitmapDecoder.CreateAsync(source).AsTask(ct).ConfigureAwait(false);
        var frame = await PickLargestFrameAsync(decoder, ct).ConfigureAwait(false);

        var srcW = frame.PixelWidth;
        var srcH = frame.PixelHeight;
        if (srcW == 0 || srcH == 0) throw new InvalidDataException("Image has no pixels.");

        var aspect = srcW / (double)srcH / (Width / (double)Height);
        var fill = !forceFit && srcW >= MinFillWidth && aspect is >= 1 / FillTolerance and <= FillTolerance;

        var canvas = new byte[Width * Height * 4];
        if (fill)
        {
            var scale = Math.Max(Width / (double)srcW, Height / (double)srcH);
            var scaledW = Math.Max(Width, (uint)Math.Round(srcW * scale));
            var scaledH = Math.Max(Height, (uint)Math.Round(srcH * scale));
            var transform = new BitmapTransform
            {
                ScaledWidth = scaledW,
                ScaledHeight = scaledH,
                InterpolationMode = BitmapInterpolationMode.Fant,
                Bounds = new BitmapBounds { X = (scaledW - Width) / 2, Y = (scaledH - Height) / 2, Width = Width, Height = Height },
            };
            var pixels = await GetPixelsAsync(frame, transform, ct).ConfigureAwait(false);
            FillGradient(canvas, background ?? 0x000000, background ?? 0x000000);
            Composite(canvas, pixels, Width, Height, 0, 0);
        }
        else
        {
            var scale = Math.Min(FitBox / (double)srcW, FitBox / (double)srcH);
            var w = (uint)Math.Clamp(Math.Round(srcW * scale), 1, Width);
            var h = (uint)Math.Clamp(Math.Round(srcH * scale), 1, Height);
            var transform = new BitmapTransform { ScaledWidth = w, ScaledHeight = h, InterpolationMode = BitmapInterpolationMode.Fant };
            var pixels = await GetPixelsAsync(frame, transform, ct).ConfigureAwait(false);

            var tint = background ?? AverageColor(pixels);
            FillGradient(canvas, Shade(tint, background is null ? 0.75 : 1.0), Shade(tint, 0.25));
            Composite(canvas, pixels, (int)w, (int)h, (Width - (int)w) / 2, (int)(Height * 0.42) - (int)h / 2);
        }

        ct.ThrowIfCancellationRequested();
        await EncodeJpegAsync(canvas, destination, ct).ConfigureAwait(false);
    }

    private static async Task<BitmapFrame> PickLargestFrameAsync(BitmapDecoder decoder, CancellationToken ct)
    {
        // Icons carry several sizes and the first is often the smallest.
        var best = await decoder.GetFrameAsync(0).AsTask(ct).ConfigureAwait(false);
        for (uint i = 1; i < decoder.FrameCount; i++)
        {
            var frame = await decoder.GetFrameAsync(i).AsTask(ct).ConfigureAwait(false);
            if ((ulong)frame.PixelWidth * frame.PixelHeight > (ulong)best.PixelWidth * best.PixelHeight) best = frame;
        }
        return best;
    }

    private static async Task<byte[]> GetPixelsAsync(BitmapFrame frame, BitmapTransform transform, CancellationToken ct)
    {
        var data = await frame.GetPixelDataAsync(
                BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform,
                ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.ColorManageToSRgb)
            .AsTask(ct).ConfigureAwait(false);
        return data.DetachPixelData();
    }

    private static async Task EncodeJpegAsync(byte[] canvas, string destination, CancellationToken ct)
    {
        var temp = destination + ".tmp";
        try
        {
            await using (var file = new FileStream(temp, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
            using (var stream = file.AsRandomAccessStream())
            {
                var options = new BitmapPropertySet { ["ImageQuality"] = new BitmapTypedValue(JpegQuality, PropertyType.Single) };
                var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, stream, options).AsTask(ct).ConfigureAwait(false);
                encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, Width, Height, 96, 96, canvas);
                await encoder.FlushAsync().AsTask(ct).ConfigureAwait(false);
            }
            File.Move(temp, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    /// <summary>Premultiplied source-over onto an opaque canvas.</summary>
    private static void Composite(byte[] canvas, byte[] src, int w, int h, int left, int top)
    {
        for (var y = 0; y < h; y++)
        {
            var cy = top + y;
            if ((uint)cy >= Height) continue;
            for (var x = 0; x < w; x++)
            {
                var cx = left + x;
                if ((uint)cx >= Width) continue;

                var s = (y * w + x) * 4;
                var d = (cy * Width + cx) * 4;
                var inv = 255 - src[s + 3];
                canvas[d] = (byte)(src[s] + canvas[d] * inv / 255);
                canvas[d + 1] = (byte)(src[s + 1] + canvas[d + 1] * inv / 255);
                canvas[d + 2] = (byte)(src[s + 2] + canvas[d + 2] * inv / 255);
                canvas[d + 3] = 255;
            }
        }
    }

    /// <summary>Vertical gradient between two 0xRRGGBB colours.</summary>
    private static void FillGradient(byte[] canvas, uint top, uint bottom)
    {
        for (var y = 0; y < Height; y++)
        {
            var t = y / (double)(Height - 1);
            var b = (byte)Lerp(top & 0xFF, bottom & 0xFF, t);
            var g = (byte)Lerp((top >> 8) & 0xFF, (bottom >> 8) & 0xFF, t);
            var r = (byte)Lerp((top >> 16) & 0xFF, (bottom >> 16) & 0xFF, t);
            var row = y * Width * 4;
            for (var x = 0; x < Width; x++)
            {
                var i = row + x * 4;
                canvas[i] = b;
                canvas[i + 1] = g;
                canvas[i + 2] = r;
                canvas[i + 3] = 255;
            }
        }

        static double Lerp(uint a, uint b, double t) => a + (b - (double)a) * t;
    }

    /// <summary>Alpha-weighted mean colour of the art, used to tint the backdrop behind logos and icons.</summary>
    private static uint AverageColor(byte[] premultiplied)
    {
        double r = 0, g = 0, b = 0, a = 0;
        for (var i = 0; i < premultiplied.Length; i += 4)
        {
            b += premultiplied[i];
            g += premultiplied[i + 1];
            r += premultiplied[i + 2];
            a += premultiplied[i + 3];
        }
        if (a < 1) return 0x303030;

        // Premultiplied sums / alpha sum = average straight colour of the visible pixels.
        var scale = 255 / a;
        return ((uint)Math.Min(255, r * scale) << 16) | ((uint)Math.Min(255, g * scale) << 8) | (uint)Math.Min(255, b * scale);
    }

    /// <summary>Scales a colour towards black so bright logos still sit on a dark, dashboard-like backdrop.</summary>
    private static uint Shade(uint rgb, double factor)
    {
        var r = (rgb >> 16) & 0xFF;
        var g = (rgb >> 8) & 0xFF;
        var b = rgb & 0xFF;
        var max = Math.Max(r, Math.Max(g, b));
        var cap = max > 0 ? Math.Min(1.0, 150.0 / max) : 1.0; // keep the backdrop at most mid-bright
        var k = factor * cap;
        return ((uint)(r * k) << 16) | ((uint)(g * k) << 8) | (uint)(b * k);
    }
}
