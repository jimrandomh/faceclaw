#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $OutputDirectory,
    [string] $NdkRoot = $env:ANDROID_NDK_HOME
)

$ErrorActionPreference = 'Stop'
if (!$NdkRoot) {
    throw 'Set ANDROID_NDK_HOME or pass -NdkRoot to point to an Android NDK installation.'
}

$hostTag = if ($IsWindows) { 'windows-x86_64' } elseif ($IsMacOS) { 'darwin-x86_64' } else { 'linux-x86_64' }
$suffix = if ($IsWindows) { '.exe' } else { '' }
$toolsDirectory = Join-Path $NdkRoot "toolchains/llvm/prebuilt/$hostTag/bin"
$clang = (Resolve-Path -LiteralPath (Join-Path $toolsDirectory "clang$suffix")).Path
$readelf = (Resolve-Path -LiteralPath (Join-Path $toolsDirectory "llvm-readelf$suffix")).Path
$target = 'aarch64-linux-android'
$targetDirectory = Join-Path $PSScriptRoot 'target'
$library = Join-Path $targetDirectory "$target/release/liblumen_band.so"
$jniDirectory = Join-Path $OutputDirectory 'arm64-v8a'

$flags = @(
    '-C', 'link-arg=--target=aarch64-linux-android29'
    '-C', 'link-arg=-Wl,-z,max-page-size=16384'
    '-C', 'link-arg=-Wl,-z,common-page-size=16384'
)
$oldLinker = $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
$oldFlags = $env:CARGO_ENCODED_RUSTFLAGS
try {
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $clang
    $env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
    & cargo build --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --target-dir $targetDirectory --locked --release --target $target -p bridge
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $oldLinker
    $env:CARGO_ENCODED_RUSTFLAGS = $oldFlags
}

$headers = & $readelf --file-header --program-headers --wide $library
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (!($headers -match 'Class:\s+ELF64') -or !($headers -match 'Machine:\s+AArch64')) {
    throw 'Expected an ELF64 AArch64 native library.'
}
$loadableSegments = @($headers | Where-Object { $_ -match '^\s+LOAD\s' })
if (!$loadableSegments -or ($loadableSegments | Where-Object {
    $alignment = ($_ -split '\s+')[-1]
    [Convert]::ToInt64($alignment, 16) -lt 16384
})) {
    throw 'The native library must have 16 KiB-aligned loadable segments.'
}

$jniMethods = @(
    'open', 'request', 'feed', 'tick', 'actions', 'log', 'status', 'setPaused', 'setMotion', 'setMapping', 'close',
    'setPointer', 'pointer', 'setHandwriting', 'recoverHandwriting', 'resetHandwritingText', 'handwritingEvents'
)
$symbols = & $readelf --dyn-syms --wide $library
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
foreach ($method in $jniMethods) {
    if (!($symbols -match "\bJava_dev_lumen_band_Bridge_$method\s*$")) {
        throw "The native library is missing JNI method $method."
    }
}

New-Item -ItemType Directory -Path $jniDirectory -Force | Out-Null
Copy-Item -LiteralPath $library -Destination (Join-Path $jniDirectory 'liblumen_band.so') -Force
Get-Item -LiteralPath (Join-Path $jniDirectory 'liblumen_band.so')
