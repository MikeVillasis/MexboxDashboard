using System.Collections.Concurrent;
using System.IO;
using System.Media;
using Dashboard.Core.Infrastructure;

namespace Dashboard.App.Audio;

public enum SoundCue
{
    BladeSwoosh,   // blade slide
    ChannelChange, // game launch
    Navigate,      // list move
    Select,        // accept
    Back,
}

/// <summary>
/// UI sound hooks. WAVs are preloaded off the UI thread; missing files are skipped.
/// Note: SoundPlayer plays one sound at a time per process (a new cue cuts the previous one), which suits UI blips.
/// Swap for an XAudio2 / NAudio mixer later if overlapping cues are wanted.
/// </summary>
public sealed class SoundService
{
    private static readonly IReadOnlyDictionary<SoundCue, string> FileNames = new Dictionary<SoundCue, string>
    {
        [SoundCue.BladeSwoosh] = "blade_swoosh.wav",
        [SoundCue.ChannelChange] = "channel_change.wav",
        [SoundCue.Navigate] = "navigate.wav",
        [SoundCue.Select] = "select.wav",
        [SoundCue.Back] = "back.wav",
    };

    private readonly string _directory;
    private readonly ConcurrentDictionary<SoundCue, SoundPlayer> _players = new();

    public SoundService(string directory) => _directory = directory;

    public bool Enabled { get; set; } = true;

    public void PreloadInBackground() => Task.Run(() =>
    {
        if (!Directory.Exists(_directory)) return;
        foreach (var (cue, fileName) in FileNames)
        {
            var path = Path.Combine(_directory, fileName);
            if (!File.Exists(path)) continue;
            try
            {
                var player = new SoundPlayer(path);
                player.Load();
                _players[cue] = player;
            }
            catch (Exception ex)
            {
                Log.Warn($"Could not load sound {path}", ex);
            }
        }
    });

    public void Play(SoundCue cue)
    {
        if (!Enabled || !_players.TryGetValue(cue, out var player)) return;
        try
        {
            player.Play(); // async playback, returns immediately
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not play {cue}", ex);
        }
    }
}
