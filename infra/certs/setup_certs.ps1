# Check if mkcert is installed
$mkcertExe = "mkcert"
if (-not (Get-Command "mkcert" -ErrorAction SilentlyContinue)) {
    Write-Host "mkcert not found in PATH. Checking WinGet directory..."
    $found = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "mkcert.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    
    if ($found) {
        Write-Host "Found mkcert at: $found"
        $mkcertExe = $found
    } else {
        Write-Host "mkcert not found. Attempting to install via Winget..."
        winget install FiloSottile.mkcert --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to install mkcert. Please install it manually: 'choco install mkcert' or download from GitHub."
            exit 1
        }
        # Try to find it again after install
        $found = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "mkcert.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
        if ($found) {
            $mkcertExe = $found
        } else {
             Write-Host "Please restart your terminal to use 'mkcert'."
             exit 0
        }
    }
}

# Install CA
Write-Host "Installing Local CA..."
& $mkcertExe -install

# Generate Certs
$certKey = "localhost-key.pem"
$certFile = "localhost.pem"

Write-Host "Generating certificates for localhost..."
& $mkcertExe -key-file $certKey -cert-file $certFile localhost 127.0.0.1 ::1

Write-Host "Certificates generated in $(Get-Location)"
