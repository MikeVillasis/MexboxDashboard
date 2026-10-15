using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Dashboard.App.Imaging;

namespace Dashboard.App.Controls;

/// <summary>
/// Xbox 360 jewel-case cover. Loads <see cref="ImagePath"/> asynchronously through <see cref="CoverImageCache"/>
/// and falls back to a styled placeholder showing the title (or initials when <see cref="Compact"/>).
/// Safe inside recycled virtualizing containers: stale loads are discarded by a version stamp.
/// </summary>
public sealed class CoverArt : Control
{
    public static readonly DependencyProperty ImagePathProperty = DependencyProperty.Register(
        nameof(ImagePath), typeof(string), typeof(CoverArt), new PropertyMetadata(null, OnSourceChanged));

    public static readonly DependencyProperty DecodeWidthProperty = DependencyProperty.Register(
        nameof(DecodeWidth), typeof(int), typeof(CoverArt), new PropertyMetadata(400, OnSourceChanged));

    public static readonly DependencyProperty TitleProperty = DependencyProperty.Register(
        nameof(Title), typeof(string), typeof(CoverArt), new PropertyMetadata(string.Empty, OnTitleChanged));

    public static readonly DependencyProperty PlatformProperty = DependencyProperty.Register(
        nameof(Platform), typeof(string), typeof(CoverArt), new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty CompactProperty = DependencyProperty.Register(
        nameof(Compact), typeof(bool), typeof(CoverArt), new PropertyMetadata(false));

    private static readonly DependencyPropertyKey ImagePropertyKey = DependencyProperty.RegisterReadOnly(
        nameof(Image), typeof(ImageSource), typeof(CoverArt), new PropertyMetadata(null));

    public static readonly DependencyProperty ImageProperty = ImagePropertyKey.DependencyProperty;

    private static readonly DependencyPropertyKey HasImagePropertyKey = DependencyProperty.RegisterReadOnly(
        nameof(HasImage), typeof(bool), typeof(CoverArt), new PropertyMetadata(false));

    public static readonly DependencyProperty HasImageProperty = HasImagePropertyKey.DependencyProperty;

    private static readonly DependencyPropertyKey InitialsPropertyKey = DependencyProperty.RegisterReadOnly(
        nameof(Initials), typeof(string), typeof(CoverArt), new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty InitialsProperty = InitialsPropertyKey.DependencyProperty;

    private int _loadVersion;

    public string? ImagePath
    {
        get => (string?)GetValue(ImagePathProperty);
        set => SetValue(ImagePathProperty, value);
    }

    public int DecodeWidth
    {
        get => (int)GetValue(DecodeWidthProperty);
        set => SetValue(DecodeWidthProperty, value);
    }

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string Platform
    {
        get => (string)GetValue(PlatformProperty);
        set => SetValue(PlatformProperty, value);
    }

    public bool Compact
    {
        get => (bool)GetValue(CompactProperty);
        set => SetValue(CompactProperty, value);
    }

    public ImageSource? Image => (ImageSource?)GetValue(ImageProperty);

    public bool HasImage => (bool)GetValue(HasImageProperty);

    public string Initials => (string)GetValue(InitialsProperty);

    private static void OnSourceChanged(DependencyObject d, DependencyPropertyChangedEventArgs e) => ((CoverArt)d).BeginLoad();

    private static void OnTitleChanged(DependencyObject d, DependencyPropertyChangedEventArgs e) =>
        d.SetValue(InitialsPropertyKey, MakeInitials(e.NewValue as string));

    private async void BeginLoad()
    {
        var version = ++_loadVersion;
        var path = ImagePath;
        var width = DecodeWidth;

        if (string.IsNullOrWhiteSpace(path))
        {
            SetImage(null);
            return;
        }

        if (CoverImageCache.TryGet(path, width, out var cached))
        {
            SetImage(cached);
            return;
        }

        SetImage(null);
        var image = await CoverImageCache.LoadAsync(path, width);
        if (version == _loadVersion) SetImage(image);
    }

    private void SetImage(ImageSource? image)
    {
        SetValue(ImagePropertyKey, image);
        SetValue(HasImagePropertyKey, image is not null);
    }

    private static string MakeInitials(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return string.Empty;
        var words = title.Split(new[] { ' ', ':', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);
        var initials = words.Where(w => char.IsLetterOrDigit(w[0])).Take(2).Select(w => char.ToUpperInvariant(w[0]));
        return string.Concat(initials);
    }
}
