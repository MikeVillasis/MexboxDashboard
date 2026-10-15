using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Threading;
using Dashboard.Core.Infrastructure;

namespace Dashboard.App.Input;

/// <summary>
/// Polls XInput on a dedicated background thread (XInput has no events) and posts edge-triggered
/// <see cref="NavAction"/>s to the UI dispatcher. Directions auto-repeat when held.
/// Polling drops to 10 Hz while suspended (window inactive, e.g. while a game is running).
/// </summary>
internal sealed class XInputService : IDisposable
{
    private const int ErrorSuccess = 0;
    private const short StickDeadzone = 16000;
    private const byte TriggerThreshold = 120;

    private const ushort DpadUp = 0x0001, DpadDown = 0x0002, DpadLeft = 0x0004, DpadRight = 0x0008;
    private const ushort Start = 0x0010, LeftShoulder = 0x0100, RightShoulder = 0x0200;
    private const ushort ButtonA = 0x1000, ButtonB = 0x2000, ButtonX = 0x4000, ButtonY = 0x8000;

    private static readonly (ushort Mask, NavAction Action)[] ButtonMap =
    {
        (ButtonA, NavAction.Accept),
        (Start, NavAction.Accept),
        (ButtonB, NavAction.Back),
        (ButtonX, NavAction.ActionX),
        (ButtonY, NavAction.ActionY),
        (LeftShoulder, NavAction.BladePrevious),
        (RightShoulder, NavAction.BladeNext),
    };

    private readonly Dispatcher _dispatcher;
    private readonly Thread _thread;
    private volatile bool _running = true;
    private volatile bool _suspended;

    public XInputService(Dispatcher dispatcher)
    {
        _dispatcher = dispatcher;
        _thread = new Thread(PollLoop)
        {
            IsBackground = true,
            Name = "XInput poll",
            Priority = ThreadPriority.AboveNormal, // input latency matters more than the 0.1% CPU
        };
        _thread.Start();
    }

    public event Action<NavAction>? ActionTriggered;

    public bool IsSuspended
    {
        get => _suspended;
        set => _suspended = value;
    }

    public void Dispose() => _running = false;

    private void PollLoop()
    {
        var clock = Stopwatch.StartNew();
        var slot = -1;
        long nextScan = 0;
        ushort previousButtons = 0xFFFF; // treat everything as "already held" on first read: no phantom presses
        bool previousLt = true, previousRt = true;
        var repeat = new DirectionRepeater();

        try
        {
            while (_running)
            {
                if (_suspended)
                {
                    previousButtons = 0xFFFF;
                    previousLt = previousRt = true;
                    repeat.Reset();
                    Thread.Sleep(100);
                    continue;
                }

                var now = clock.ElapsedMilliseconds;
                if (slot < 0)
                {
                    // Querying empty slots is slow, so only rescan for a pad once per second.
                    if (now >= nextScan)
                    {
                        slot = FindController();
                        nextScan = now + 1000;
                    }
                    if (slot < 0)
                    {
                        Thread.Sleep(100);
                        continue;
                    }
                }

                if (XInputGetState(slot, out var state) != ErrorSuccess)
                {
                    slot = -1;
                    previousButtons = 0xFFFF;
                    repeat.Reset();
                    continue;
                }

                var pad = state.Gamepad;
                var pressed = (ushort)(pad.Buttons & ~previousButtons);
                previousButtons = pad.Buttons;

                foreach (var (mask, action) in ButtonMap)
                {
                    if ((pressed & mask) != 0) Post(action);
                }

                var lt = pad.LeftTrigger > TriggerThreshold;
                var rt = pad.RightTrigger > TriggerThreshold;
                if (lt && !previousLt) Post(NavAction.PageUp);
                if (rt && !previousRt) Post(NavAction.PageDown);
                previousLt = lt;
                previousRt = rt;

                if (repeat.Update(ReadDirection(pad), now) is { } direction) Post(direction);

                Thread.Sleep(8);
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Warn("XInput unavailable; gamepad support disabled", ex);
        }
    }

    private void Post(NavAction action) =>
        _dispatcher.InvokeAsync(() => ActionTriggered?.Invoke(action), DispatcherPriority.Input);

    private static int FindController()
    {
        for (var i = 0; i < 4; i++)
        {
            if (XInputGetState(i, out _) == ErrorSuccess) return i;
        }
        return -1;
    }

    private static NavAction? ReadDirection(in XInputGamepad pad)
    {
        var b = pad.Buttons;
        if ((b & DpadUp) != 0) return NavAction.Up;
        if ((b & DpadDown) != 0) return NavAction.Down;
        if ((b & DpadLeft) != 0) return NavAction.Left;
        if ((b & DpadRight) != 0) return NavAction.Right;

        int x = pad.ThumbLX, y = pad.ThumbLY;
        if (Math.Abs(x) < StickDeadzone && Math.Abs(y) < StickDeadzone) return null;
        return Math.Abs(y) >= Math.Abs(x)
            ? (y > 0 ? NavAction.Up : NavAction.Down)
            : (x > 0 ? NavAction.Right : NavAction.Left);
    }

    /// <summary>Fires once on press, then repeats after a delay. Blade switching repeats slower than list scrolling.</summary>
    private sealed class DirectionRepeater
    {
        private NavAction? _current;
        private long _nextFire;

        public void Reset() => _current = null;

        public NavAction? Update(NavAction? direction, long now)
        {
            if (direction != _current)
            {
                _current = direction;
                _nextFire = now + 380;
                return direction;
            }

            if (direction is null || now < _nextFire) return null;

            var horizontal = direction is NavAction.Left or NavAction.Right;
            _nextFire = now + (horizontal ? 260 : 85);
            return direction;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct XInputGamepad
    {
        public ushort Buttons;
        public byte LeftTrigger;
        public byte RightTrigger;
        public short ThumbLX;
        public short ThumbLY;
        public short ThumbRX;
        public short ThumbRY;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct XInputState
    {
        public uint PacketNumber;
        public XInputGamepad Gamepad;
    }

    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    private static extern int XInputGetState(int userIndex, out XInputState state);
}
