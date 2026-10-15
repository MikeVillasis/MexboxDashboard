using System.Windows;
using System.Windows.Controls;
using Dashboard.App.Input;
using Dashboard.App.ViewModels;

namespace Dashboard.App.Views;

public partial class MediaBladeView : UserControl, IBladeView
{
    public MediaBladeView()
    {
        InitializeComponent();
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
