# Windows Network Tuning for High Concurrency (100k+ connections)
# Run as Administrator

Write-Host "Tuning Windows Network Settings for High Throughput..."

# 1. Ephemeral Ports (MaxUserPort)
# Default is usually ~16384 or start at 49152. We need MAX.
# Range: 1025 - 65534
netsh int ipv4 set dynamicport tcp start=1025 num=64510
netsh int ipv4 set dynamicport udp start=1025 num=64510
netsh int ipv6 set dynamicport tcp start=1025 num=64510
netsh int ipv6 set dynamicport udp start=1025 num=64510
Write-Host "Dynamic ports range extended."

# 2. Registry Tweaks
$tcpParams = "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters"

# TcpTimedWaitDelay: Reduce time spent in TIME_WAIT (Default 240s -> 30s)
# 30 seconds is the minimum valid value.
Set-ItemProperty -Path $tcpParams -Name "TcpTimedWaitDelay" -Value 30 -Type DWord -Force

# MaxUserPort: (Legacy, but good to set). Max is 65534.
Set-ItemProperty -Path $tcpParams -Name "MaxUserPort" -Value 65534 -Type DWord -Force

# TcpWindowSize: Increase window size (optional, OS auto-tuning is usually good, but can hint)
# Set-ItemProperty -Path $tcpParams -Name "TcpWindowSize" -Value 64240 -Type DWord -Force

Write-Host "Registry keys updated (TcpTimedWaitDelay, MaxUserPort)."

# 3. Global UDP Buffer size hints (AFD)
# Windows doesn't have a simple sysctl like Linux, it uses AFD (Ancillary Function Driver).
# FastSendDatagramThreshold can be tweaked.
$afdParams = "HKLM:\SYSTEM\CurrentControlSet\Services\AFD\Parameters"
if (!(Test-Path $afdParams)) { New-Item -Path $afdParams -Force }

# DynamicBacklogGrowthDelta: Helps with connection acceptance bursts (mostly TCP but affects listener resource)
Set-ItemProperty -Path $afdParams -Name "DynamicBacklogGrowthDelta" -Value 10 -Type DWord -Force
Set-ItemProperty -Path $afdParams -Name "EnableDynamicBacklog" -Value 1 -Type DWord -Force
Set-ItemProperty -Path $afdParams -Name "MinimumDynamicBacklog" -Value 20 -Type DWord -Force
Set-ItemProperty -Path $afdParams -Name "MaximumDynamicBacklog" -Value 20000 -Type DWord -Force

Write-Host "AFD parameters updated."

Write-Host "------------------------------------------------------------------"
Write-Host "Tuning Complete. A RESTART is required for Registry changes to take effect."
Write-Host "------------------------------------------------------------------"
