namespace Dashboard.App.Input;

/// <summary>Device-neutral navigation intents. Keyboard, mouse and XInput all funnel into these.</summary>
public enum NavAction
{
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    Accept,      // A / Enter
    Back,        // B / Esc
    ActionX,     // X
    ActionY,     // Y / F2 — edit cover art on the Games blade
    BladePrevious, // LB / Q / Shift+Tab
    BladeNext,     // RB / E / Tab
}

/// <summary>Implemented by every blade's root view so the shell can route input to whichever blade is in front.</summary>
public interface IBladeView
{
    /// <summary>Returns true when the view consumed the action. Unhandled Left/Right fall through to blade switching.</summary>
    bool HandleAction(NavAction action);

    void OnBladeActivated();

    void OnBladeDeactivated();
}
