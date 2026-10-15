using System.Text;

namespace Dashboard.Core.Scanners.Steam;

/// <summary>Node in Valve's text KeyValues format (libraryfolders.vdf, appmanifest_*.acf).</summary>
internal sealed class VdfNode
{
    public Dictionary<string, VdfNode> Children { get; } = new(StringComparer.OrdinalIgnoreCase);

    public Dictionary<string, string> Values { get; } = new(StringComparer.OrdinalIgnoreCase);

    public VdfNode? Child(string key) => Children.TryGetValue(key, out var node) ? node : null;

    public string? Value(string key) => Values.TryGetValue(key, out var value) ? value : null;
}

/// <summary>Allocation-light, forgiving parser for text VDF/ACF. Unknown or malformed input never throws.</summary>
internal static class VdfParser
{
    private enum TokenKind
    {
        End,
        String,
        Open,
        Close,
    }

    public static VdfNode Parse(string text)
    {
        var root = new VdfNode();
        var stack = new Stack<VdfNode>();
        stack.Push(root);
        string? pendingKey = null;
        var position = 0;
        var buffer = new StringBuilder(64);

        while (true)
        {
            var kind = NextToken(text, ref position, buffer, out var token);
            if (kind == TokenKind.End) break;

            switch (kind)
            {
                case TokenKind.String:
                    if (pendingKey is null)
                    {
                        pendingKey = token;
                    }
                    else
                    {
                        stack.Peek().Values[pendingKey] = token;
                        pendingKey = null;
                    }
                    break;

                case TokenKind.Open:
                    var child = new VdfNode();
                    if (pendingKey is not null) stack.Peek().Children[pendingKey] = child;
                    stack.Push(child);
                    pendingKey = null;
                    break;

                case TokenKind.Close:
                    if (stack.Count > 1) stack.Pop();
                    pendingKey = null;
                    break;
            }
        }

        return root;
    }

    private static TokenKind NextToken(string s, ref int i, StringBuilder sb, out string token)
    {
        token = string.Empty;

        // Skip whitespace, // comments and [$PLATFORM] conditionals.
        while (i < s.Length)
        {
            var c = s[i];
            if (char.IsWhiteSpace(c))
            {
                i++;
            }
            else if (c == '/' && i + 1 < s.Length && s[i + 1] == '/')
            {
                while (i < s.Length && s[i] != '\n') i++;
            }
            else if (c == '[')
            {
                while (i < s.Length && s[i] != ']') i++;
                i++;
            }
            else
            {
                break;
            }
        }

        if (i >= s.Length) return TokenKind.End;

        var first = s[i];
        if (first == '{') { i++; return TokenKind.Open; }
        if (first == '}') { i++; return TokenKind.Close; }

        sb.Clear();
        if (first == '"')
        {
            i++;
            while (i < s.Length && s[i] != '"')
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    var escaped = s[i + 1];
                    switch (escaped)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case '\\': sb.Append('\\'); break;
                        case '"': sb.Append('"'); break;
                        default: sb.Append('\\').Append(escaped); break;
                    }
                    i += 2;
                    continue;
                }
                sb.Append(s[i]);
                i++;
            }
            i++; // closing quote
        }
        else
        {
            while (i < s.Length && !char.IsWhiteSpace(s[i]) && s[i] is not ('{' or '}' or '"'))
            {
                sb.Append(s[i]);
                i++;
            }
        }

        token = sb.ToString();
        return TokenKind.String;
    }
}
