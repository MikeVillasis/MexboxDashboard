namespace Dashboard.Core.Scanners.BattleNet;

/// <summary>
/// Minimal protobuf wire-format reader: enough to walk product.db without a schema or a protobuf package.
/// Yields (field number, wire type, payload) for each field; length-delimited payloads are sub-spans.
/// </summary>
internal ref struct ProtobufReader
{
    public const int WireVarint = 0;
    public const int Wire64 = 1;
    public const int WireLengthDelimited = 2;
    public const int Wire32 = 5;

    private readonly ReadOnlySpan<byte> _data;
    private int _pos;

    public ProtobufReader(ReadOnlySpan<byte> data)
    {
        _data = data;
        _pos = 0;
    }

    public int Field { get; private set; }

    public int WireType { get; private set; }

    /// <summary>Payload of the current length-delimited field.</summary>
    public ReadOnlySpan<byte> Bytes { get; private set; }

    public ulong Varint { get; private set; }

    /// <summary>Advances to the next field. Returns false at the end of the buffer; throws on malformed data.</summary>
    public bool Next()
    {
        if (_pos >= _data.Length) return false;

        var tag = ReadVarint();
        Field = (int)(tag >> 3);
        WireType = (int)(tag & 7);
        Bytes = default;
        Varint = 0;

        switch (WireType)
        {
            case WireVarint:
                Varint = ReadVarint();
                break;
            case Wire64:
                Skip(8);
                break;
            case WireLengthDelimited:
                var length = ReadVarint();
                if (length > (ulong)(_data.Length - _pos)) throw new InvalidDataException("Protobuf length runs past the buffer.");
                Bytes = _data.Slice(_pos, (int)length);
                _pos += (int)length;
                break;
            case Wire32:
                Skip(4);
                break;
            default:
                throw new InvalidDataException($"Unsupported protobuf wire type {WireType}.");
        }
        return true;
    }

    public readonly string String => System.Text.Encoding.UTF8.GetString(Bytes);

    private ulong ReadVarint()
    {
        ulong result = 0;
        for (var shift = 0; shift < 64; shift += 7)
        {
            if (_pos >= _data.Length) throw new InvalidDataException("Truncated protobuf varint.");
            var b = _data[_pos++];
            result |= (ulong)(b & 0x7F) << shift;
            if ((b & 0x80) == 0) return result;
        }
        throw new InvalidDataException("Protobuf varint is too long.");
    }

    private void Skip(int count)
    {
        if (_pos + count > _data.Length) throw new InvalidDataException("Truncated protobuf field.");
        _pos += count;
    }
}
