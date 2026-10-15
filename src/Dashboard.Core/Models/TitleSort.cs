using System.Text;

namespace Dashboard.Core.Models;

/// <summary>Builds library sort keys: drops leading articles and trademark symbols.</summary>
public static class TitleSort
{
    private static readonly string[] Articles = { "the ", "a ", "an " };

    public static string MakeKey(string title)
    {
        if (string.IsNullOrWhiteSpace(title)) return string.Empty;

        var span = title.AsSpan().Trim();
        foreach (var article in Articles)
        {
            if (span.Length > article.Length && span.StartsWith(article, StringComparison.OrdinalIgnoreCase))
            {
                span = span[article.Length..].TrimStart();
                break;
            }
        }

        var sb = new StringBuilder(span.Length);
        foreach (var c in span)
        {
            if (c is '™' or '®' or '©') continue;
            sb.Append(c);
        }
        return sb.ToString();
    }
}
