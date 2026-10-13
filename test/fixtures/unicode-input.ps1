param([string]$Marker)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object Windows.Forms.Form
$form.Text = 'Anas Unicode input verification'
$form.Width = 750
$form.Height = 440
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.KeyPreview = $true
$box = New-Object Windows.Forms.TextBox
$box.Multiline = $true
$box.AcceptsReturn = $true
$box.AcceptsTab = $true
$box.MaxLength = 65536
$box.Dock = 'Fill'
$form.Controls.Add($box)
$script:sequence = 0
$form.Add_Shown({
    $form.Activate()
    $box.Focus() | Out-Null
    [Windows.Forms.Clipboard]::SetText($Marker + ':ready')
})
$form.Add_KeyDown({
    if ($_.Control -and $_.KeyCode -eq 'F12') {
        $_.SuppressKeyPress = $true
        if ($_.Shift) { $form.Close(); return }
        $script:sequence++
        $hash = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes($box.Text)
            $digest = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
            [Windows.Forms.Clipboard]::SetText($Marker + ':' + $script:sequence + ':' + $box.Text.Length + ':' + $digest)
        } finally { $hash.Dispose() }
    }
})
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 180000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
try { [void]$form.ShowDialog() } finally { $timer.Dispose(); $form.Dispose() }
