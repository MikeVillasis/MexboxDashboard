using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Dashboard.App.Input;
using Dashboard.App.ViewModels;

namespace Dashboard.App.Views;

public partial class SystemBladeView : UserControl, IBladeView
{
    // Stats refresh only while this blade is in front, so it costs nothing the rest of the time.
    private readonly DispatcherTimer _statsTimer;

    public SystemBladeView()
    {
        InitializeComponent();
        _statsTimer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(2) };
        _statsTimer.Tick += (_, _) => ViewModel?.RefreshStats();
    }

    private SystemBladeViewModel? ViewModel => DataContext as SystemBladeViewModel;

    public bool HandleAction(NavAction action)
    {
        var vm = ViewModel;
        if (vm is null) return false;

        switch (action)
        {
            case NavAction.Up: vm.MoveSelection(-1); return true;
            case NavAction.Down: vm.MoveSelection(1); return true;
            case NavAction.Accept: vm.ActivateSelected(); return true;
            default: return false;
        }
    }

    public void OnBladeActivated()
    {
        ViewModel?.RefreshStats();
        _statsTimer.Start();
    }

    public void OnBladeDeactivated() => _statsTimer.Stop();

    private void OnItemClicked(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is System.Windows.DependencyObject source &&
            ItemsControl.ContainerFromElement(MenuList, source) is ListBoxItem)
        {
            ViewModel?.ActivateSelected();
        }
    }
}
