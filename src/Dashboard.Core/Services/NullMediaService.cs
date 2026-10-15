using Dashboard.Core.Abstractions;
using Dashboard.Core.Models;

namespace Dashboard.Core.Services;

/// <summary>Placeholder until Phase 4 wires the WinRT SMTC service. Reports "nothing playing".</summary>
public sealed class NullMediaService : IMediaService
{
    public MediaSessionInfo? Current => null;

    public event EventHandler<MediaSessionInfo?>? SessionUpdated
    {
        add { }
        remove { }
    }

    public Task StartAsync(CancellationToken ct) => Task.CompletedTask;

    public Task<bool> TogglePlayPauseAsync() => Task.FromResult(false);

    public Task<bool> NextAsync() => Task.FromResult(false);

    public Task<bool> PreviousAsync() => Task.FromResult(false);

    public void Dispose()
    {
    }
}
