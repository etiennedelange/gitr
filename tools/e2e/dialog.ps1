# Answers a native dialog of the app under test via Windows UI Automation.
#   -Title    window title to wait for (e.g. "Remove stale lock")
#   -Button   button to press ("Yes", "No", "Open", "Cancel")
#   -FileName for file pickers: typed into the "File name" box before pressing -Button
# Prints "TEXT:<all texts in the dialog>" then "CLICKED", or "NOWINDOW" (exit 2).
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [string]$Button = 'Yes',
  [string]$FileName = '',
  # For task dialogs with custom button labels: the button's id (custom OK = 1, Cancel = 2).
  [int]$ButtonId = 0,
  [int]$TimeoutSec = 15
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$win = $null
while (-not $win -and (Get-Date) -lt $deadline) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $Title)
  $win = $A::RootElement.FindFirst($Scope::Children, $cond)
  if (-not $win) {
    # Dialogs owned by the app window can also be nested under it.
    $win = $A::RootElement.FindFirst($Scope::Descendants, $cond)
  }
  if (-not $win) { Start-Sleep -Milliseconds 200 }
}
if (-not $win) { Write-Output 'NOWINDOW'; exit 2 }

$all = $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$texts = @($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_.Trim() })
Write-Output ('TEXT:' + ($texts -join ' | '))

if ($FileName) {
  # In the Windows file picker "File name:" is a combo box with the editable field inside it.
  # The file picker builds its controls after the window appears: keep looking for a while.
  $box = $null
  $until = (Get-Date).AddSeconds(10)
  while (-not $box -and (Get-Date) -lt $until) {
    $all = $win.FindAll($Scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $box = $all | Where-Object { ($_.Current.ControlType -eq $CT::Edit -or $_.Current.ControlType -eq $CT::ComboBox) -and $_.Current.Name -like 'File name*' } | Select-Object -First 1
    if (-not $box) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $box) {
    # Never fall back to simulated keystrokes: they go to whatever window has focus, which on a
    # desktop in use may be the user's own.
    Write-Output 'NOFILENAME'
    exit 3
  }
  $target = $box
  if ($box.Current.ControlType -eq $CT::ComboBox) {
    $inner = $box.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $CT::Edit)))
    if ($inner) { $target = $inner }
  }
  $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($FileName)
}

# Task dialogs expose their buttons as panes, so accept either.
$btn = $all | Where-Object { ($_.Current.ControlType -eq $CT::Button -or $_.Current.ControlType -eq $CT::Pane -or $_.Current.ControlType -eq $CT::SplitButton) -and ($_.Current.Name -replace '&', '') -eq $Button } | Select-Object -First 1
if (-not $btn) {
  $list = $all | ForEach-Object { $_.Current.ControlType.ProgrammaticName + '=' + $_.Current.Name }
  Write-Output ("NOBUTTON:$Button in " + ($list -join ' ; '))
  exit 4
}
$invoke = $null
if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
  $invoke.Invoke()
} else {
  # Task dialog: press the button with a message to that dialog's own window (TDM_CLICK_BUTTON),
  # never with simulated keystrokes, which would go to whatever window has focus.
  $ids = @{ 'OK' = 1; 'Cancel' = 2; 'Yes' = 6; 'No' = 7 }
  if ($ButtonId -gt 0) { $ids[$Button] = $ButtonId }
  if (-not $ids.ContainsKey($Button)) { Write-Output "NOINVOKE:$Button"; exit 5 }
  Add-Type -Namespace E2E -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);'
  $hwnd = [System.IntPtr]$win.Current.NativeWindowHandle
  [void][E2E.User32]::SendMessage($hwnd, 0x0400 + 102, [System.IntPtr]$ids[$Button], [System.IntPtr]::Zero)
}
Write-Output 'CLICKED'
