using System.ComponentModel;
using System.Windows;
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
        DataContextChanged += (_, e) =>
        {
            if (e.OldValue is INotifyPropertyChanged old) old.PropertyChanged -= OnViewModelChanged;
            if (e.NewValue is INotifyPropertyChanged now) now.PropertyChanged += OnViewModelChanged;
        };
    }

    /// <summary>Opening the link panel puts the caret in the code box (MainWindow leaves typing alone while it has focus).</summary>
    private void OnViewModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(SystemBladeViewModel.IsLinkPanelOpen)) return;
        if (ViewModel?.IsLinkPanelOpen == true)
        {
            LinkCodeBox.Clear();
            Dispatcher.BeginInvoke(() => LinkCodeBox.Focus(), System.Windows.Threading.DispatcherPriority.Input);
        }
        else
        {
            MenuList.Focus();
        }
    }

    private void OnLinkCodeKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { _ = ViewModel?.SubmitLinkCodeAsync(LinkCodeBox.Text); e.Handled = true; }
        else if (e.Key == Key.Escape) { ViewModel?.CancelLink(); e.Handled = true; }
    }

    private void OnLinkSubmit(object sender, RoutedEventArgs e) => _ = ViewModel?.SubmitLinkCodeAsync(LinkCodeBox.Text);

    private void OnLinkCancel(object sender, RoutedEventArgs e) => ViewModel?.CancelLink();

    private SystemBladeViewModel? ViewModel => DataContext as SystemBladeViewModel;

    public bool HandleAction(NavAction action)
    {
        var vm = ViewModel;
        if (vm is null) return false;

        // While the code panel is open, B / Esc closes it instead of leaving the blade.
        if (vm.IsLinkPanelOpen)
        {
            if (action == NavAction.Back) { vm.CancelLink(); return true; }
            return false;
        }

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
