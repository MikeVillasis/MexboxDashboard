using System.Windows;
using System.Windows.Controls;
using System.ComponentModel;
using Dashboard.App.Animation;
using Dashboard.App.Input;
using Dashboard.App.ViewModels;

namespace Dashboard.App.Views;

public partial class MediaBladeView : UserControl, IBladeView
{
    private string? _lastTrack;

    public MediaBladeView()
    {
        InitializeComponent();
        DataContextChanged += (_, e) =>
        {
            if (e.OldValue is INotifyPropertyChanged old) old.PropertyChanged -= OnViewModelChanged;
            if (e.NewValue is INotifyPropertyChanged now) now.PropertyChanged += OnViewModelChanged;
        };
    }

    /// <summary>Pops the art and titles in when the track changes (not on play/pause).</summary>
    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (ViewModel is not { HasSession: true } vm) return;
        var track = $"{vm.Title}{vm.Artist}";
        if (track == _lastTrack) return;
        var first = _lastTrack is null;
        _lastTrack = track;
        if (!first) FocusPop.Play(Session, fromScale: 0.96, fromOpacity: 0.4);
    }

    private MediaViewModel? ViewModel => DataContext as MediaViewModel;

    public bool HandleAction(NavAction action)
    {
        var vm = ViewModel;
        if (vm is null || !vm.HasSession) return false;

        switch (action)
        {
            case NavAction.Accept: _ = vm.TogglePlayPauseAsync(); return true;
            case NavAction.ActionX: _ = vm.PreviousAsync(); return true;
            case NavAction.ActionY: _ = vm.NextAsync(); return true;
            default: return false;
        }
    }

    public void OnBladeActivated()
    {
    }

    public void OnBladeDeactivated()
    {
    }

    private void OnPrevious(object sender, RoutedEventArgs e) => _ = ViewModel?.PreviousAsync();

    private void OnPlayPause(object sender, RoutedEventArgs e) => _ = ViewModel?.TogglePlayPauseAsync();

    private void OnNext(object sender, RoutedEventArgs e) => _ = ViewModel?.NextAsync();
}
