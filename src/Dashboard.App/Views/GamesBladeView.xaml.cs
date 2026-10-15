using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Dashboard.App.Animation;
using Dashboard.App.Input;
using Dashboard.App.ViewModels;
using Microsoft.Win32;

namespace Dashboard.App.Views;

public partial class GamesBladeView : UserControl, IBladeView
{
    private const int PageSize = 8;

    public GamesBladeView()
    {
        InitializeComponent();
    }

    private GamesBladeViewModel? ViewModel => DataContext as GamesBladeViewModel;

    public bool HandleAction(NavAction action)
    {
        var vm = ViewModel;
        if (vm is null) return false;

        switch (action)
        {
            case NavAction.Up: Move(-1); return true;
            case NavAction.Down: Move(1); return true;
            case NavAction.PageUp: Move(-PageSize); return true;
            case NavAction.PageDown: Move(PageSize); return true;
            case NavAction.Accept:
                if (vm.SelectedGame is null) return false;
                _ = vm.LaunchSelectedAsync();
                return true;
            case NavAction.ActionY:
                if (vm.SelectedGame is null) return false;
                PickCustomCover();
                return true;
            default:
                return false;
        }
    }

    public void OnBladeActivated()
    {
    }

    public void OnBladeDeactivated()
    {
    }

    private void Move(int delta)
    {
        ViewModel?.MoveSelection(delta);
    }

    private Point? _lastPointer;

    /// <summary>
    /// Focus follows the mouse: the game under the pointer becomes the previewed game. Only real pointer movement counts;
    /// WPF also raises MouseMove when wheel-scrolling slides items under a still pointer, and those are ignored.
    /// </summary>
    private void OnListMouseMove(object sender, MouseEventArgs e)
    {
        var position = e.GetPosition(this);
        if (_lastPointer is { } last && Math.Abs(last.X - position.X) < 1 && Math.Abs(last.Y - position.Y) < 1) return;
        _lastPointer = position;

        if (e.OriginalSource is not DependencyObject source) return;
        if (ItemsControl.ContainerFromElement(GameList, source) is ListBoxItem { DataContext: GameItemViewModel game })
            ViewModel?.FocusGame(game);
    }

    private void OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (GameList.SelectedItem is not { } item) return;
        GameList.ScrollIntoView(item);
        if (e.RemovedItems.Count > 0) FocusPop.Play(Preview); // not on first load
    }

    private void OnListDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left && ViewModel?.SelectedGame is not null)
            _ = ViewModel.LaunchSelectedAsync();
    }

    private void OnLaunchClick(object sender, RoutedEventArgs e) => _ = ViewModel?.LaunchSelectedAsync();

    private void OnSetCoverClick(object sender, RoutedEventArgs e) => PickCustomCover();

    private void OnCoverRightClick(object sender, MouseButtonEventArgs e)
    {
        PickCustomCover();
        e.Handled = true;
    }

    private void PickCustomCover()
    {
        var vm = ViewModel;
        var game = vm?.SelectedGame;
        if (vm is null || game is null) return;

        var dialog = new OpenFileDialog
        {
            Title = $"Cover art for {game.Title}",
            Filter = "Images (*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.bmp",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(Window.GetWindow(this)) == true)
            _ = vm.SetCustomCoverAsync(game, dialog.FileName);
    }

    private void OnCoverDragOver(object sender, DragEventArgs e)
    {
        e.Effects = TryGetDroppedImage(e) is not null ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    private void OnCoverDrop(object sender, DragEventArgs e)
    {
        var vm = ViewModel;
        if (vm?.SelectedGame is { } game && TryGetDroppedImage(e) is { } path)
            _ = vm.SetCustomCoverAsync(game, path);
        e.Handled = true;
    }

    private string? TryGetDroppedImage(DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is not string[] { Length: > 0 } files) return null;
        var path = files[0];
        return ViewModel?.IsSupportedCover(path) == true && File.Exists(path) ? path : null;
    }

    private void OnNowPlayingToggle(object sender, RoutedEventArgs e) => _ = ViewModel?.Media.TogglePlayPauseAsync();
}
