using System.Diagnostics;

namespace Dashboard.Core.Infrastructure;

/// <summary>Launch helpers shared by every scanner. Always use these from a worker thread.</summary>
public static class ShellLauncher
{
    /// <summary>Opens a protocol URI (steam://, battlenet://, shell:AppsFolder\…) through the Windows shell.</summary>
    public static void OpenUri(string uri)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(uri);
        Log.Info($"Launching URI {uri}");
        using var _ = Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
    }

    /// <summary>Starts a bootstrapper executable (e.g. RiotClientServices.exe --launch-product=…).</summary>
    public static void StartExecutable(string path, string? arguments = null, string? workingDirectory = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        if (!File.Exists(path)) throw new FileNotFoundException("Launcher executable not found.", path);

        Log.Info($"Launching {path} {arguments}");
        using var _ = Process.Start(new ProcessStartInfo(path)
        {
            Arguments = arguments ?? string.Empty,
            WorkingDirectory = workingDirectory ?? Path.GetDirectoryName(path) ?? string.Empty,
            UseShellExecute = true,
        });
    }
}
