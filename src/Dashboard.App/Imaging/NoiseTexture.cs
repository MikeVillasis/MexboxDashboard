using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Dashboard.App.Imaging;

/// <summary>Generates the subtle film-grain tile laid over the backdrop (one 128x128 bitmap, tiled by the GPU).</summary>
internal static class NoiseTexture
{
    public static Brush CreateBrush(int size = 128, int seed = 360)
    {
        var pixels = new byte[size * size * 4];
        var random = new Random(seed);
        for (var i = 0; i < size * size; i++)
        {
            var value = (byte)random.Next(256);
            var o = i * 4;
            pixels[o] = value;
            pixels[o + 1] = value;
            pixels[o + 2] = value;
            pixels[o + 3] = (byte)random.Next(0, 48);
        }

        var bitmap = BitmapSource.Create(size, size, 96, 96, PixelFormats.Bgra32, null, pixels, size * 4);
        bitmap.Freeze();

        var brush = new ImageBrush(bitmap)
        {
            TileMode = TileMode.Tile,
            Viewport = new Rect(0, 0, size, size),
            ViewportUnits = BrushMappingMode.Absolute,
            Stretch = Stretch.None,
        };
        brush.Freeze();
        return brush;
    }
}
