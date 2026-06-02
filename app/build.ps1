param(
    [switch]$NoInstall,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$PLINK   = 'C:\Program Files\PuTTY\plink.exe'
$PSCP    = 'C:\Program Files\PuTTY\pscp.exe'
$ADB     = 'C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe'
$HOSTKEY = 'SHA256:Pk744LC4EAdU7CDYt2zQVjDFJ++fgKX7ThJqorg+i9Y'
$SERVER  = 'bosman67@10.2.20.38'
# Server SSH password — never hardcode. Provide via $env:SGPS_PW, otherwise you
# are prompted (input hidden). NOTE: the old password was previously committed to
# this repo — rotate it on the server and scrub it from git history.
$PW = $env:SGPS_PW
if (-not $PW) {
    $sec = Read-Host 'Server SSH password' -AsSecureString
    $PW  = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
             [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
$PROJECT = Split-Path $MyInvocation.MyCommand.Path
$TAR     = "$env:TEMP\survey-gps.tar.gz"
$APK     = "$env:TEMP\app-release.apk"

function SSH($cmd) {
    & $PLINK -pw $PW -hostkey $HOSTKEY -batch $SERVER $cmd
    if ($LASTEXITCODE -ne 0) { throw "SSH failed (exit $LASTEXITCODE)" }
}
function Upload($local, $remote) {
    & $PSCP -pw $PW -hostkey $HOSTKEY $local "${SERVER}:${remote}"
    if ($LASTEXITCODE -ne 0) { throw "Upload failed" }
}
function Download($remote, $local) {
    & $PSCP -pw $PW -hostkey $HOSTKEY "${SERVER}:${remote}" $local
    if ($LASTEXITCODE -ne 0) { throw "Download failed" }
}

$t0 = Get-Date
Write-Host ""
Write-Host "  Survey GPS Build Pipeline" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor DarkGray
Write-Host ""

# Step 1: Pack source files using a temp Python script
Write-Host "  [1/4] Packing source..." -ForegroundColor Yellow

$pyFile = "$env:TEMP\sgps_pack.py"
@'
import tarfile, os, sys

project_dir = os.environ["SGPS_PROJECT"]
out         = os.environ["SGPS_TAR"]
EXCLUDE     = {"node_modules", ".git", "android", "build"}

with tarfile.open(out, "w:gz") as tar:
    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in sorted(dirs) if d not in EXCLUDE]
        rel = os.path.relpath(root, project_dir).replace("\\", "/")
        if rel != ".":
            ti = tarfile.TarInfo(name=rel)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            tar.addfile(ti)
        for f in sorted(files):
            fp  = os.path.join(root, f)
            arc = (rel + "/" + f).lstrip("./")
            try:
                st = os.stat(fp)
                ti = tarfile.TarInfo(name=arc)
                ti.mode = 0o644
                ti.size = st.st_size
                with open(fp, "rb") as fh:
                    tar.addfile(ti, fh)
            except Exception as e:
                print("skip " + arc + ": " + str(e))

print("Done")
'@ | Set-Content $pyFile -Encoding UTF8

$env:SGPS_PROJECT = $PROJECT
$env:SGPS_TAR     = $TAR
python $pyFile
Remove-Item $pyFile

$kb = [math]::Round((Get-Item $TAR).Length / 1KB, 0)
Write-Host "         $kb KB packed" -ForegroundColor DarkGray

# Step 2: Upload
Write-Host "  [2/4] Uploading to server..." -ForegroundColor Yellow
Upload $TAR "/tmp/survey-gps.tar.gz"

if ($Clean) {
    Write-Host "         -Clean: wiping server stamps" -ForegroundColor DarkGray
    SSH "rm -f ~/.sgps-stamps/pkg ~/.sgps-stamps/app"
}

# Step 3: Build on server
Write-Host "  [3/4] Building on server..." -ForegroundColor Yellow
& $PLINK -pw $PW -hostkey $HOSTKEY -batch $SERVER "bash ~/build.sh 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  BUILD FAILED" -ForegroundColor Red
    exit 1
}

# Step 4: Download APK
Write-Host "  [4/4] Downloading APK..." -ForegroundColor Yellow
Download "/home/bosman67/sgps/android/app/build/outputs/apk/release/app-release.apk" $APK
$mb = [math]::Round((Get-Item $APK).Length / 1MB, 1)
Write-Host "         $mb MB" -ForegroundColor DarkGray

# Step 5: Install
# MIUI-safe: start the adb server first so its harmless "daemon not running"
# notice (stderr) doesn't trip -ErrorActionPreference Stop; and fall back to
# `adb push` + `pm install -r` because MIUI blocks streamed `adb install`
# (INSTALL_FAILED_USER_RESTRICTED).
if (-not $NoInstall) {
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $ADB start-server 2>$null | Out-Null
    $devices = @(& $ADB devices | Where-Object { $_ -match 'device$' })
    if ($devices.Count -gt 0) {
        Write-Host "  [5/5] Installing on phone..." -ForegroundColor Yellow
        $r = & $ADB install -r $APK
        if ("$r" -notmatch 'Success') {
            Write-Host "         streamed install blocked - using push + pm install" -ForegroundColor DarkGray
            & $ADB push $APK /data/local/tmp/sgps.apk | Out-Null
            $r = & $ADB shell pm install -r /data/local/tmp/sgps.apk
            & $ADB shell rm -f /data/local/tmp/sgps.apk 2>$null | Out-Null
        }
        if ("$r" -match 'Success') { Write-Host "         Installed OK" -ForegroundColor Green }
        else { Write-Host "         Install FAILED: $r" -ForegroundColor Red }
    } else {
        Write-Host "  [5/5] No phone connected -- APK saved at $APK" -ForegroundColor DarkGray
    }
    $ErrorActionPreference = $eap
}

$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 0)
Write-Host ""
Write-Host "  DONE in ${elapsed}s" -ForegroundColor Green
Write-Host ""
