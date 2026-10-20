<#
    Build the Android app without EAS, on this machine.

    ─────────────────────────────────────────────────────────────────────────
    WHY A SCRIPT AND NOT A LIST OF COMMANDS.

    Every command handed over for this task failed, and not one of them failed
    on anything to do with Android. They were written in bash and typed into
    Windows PowerShell 5.1, which:

      has no `&&`            `cd app && npx expo prebuild` is a parser error,
                             so the directory change and the command cannot be
                             written on one line
      has no inline env      `FOO=bar cmd` is not a thing; it is `$env:FOO`,
                             set as its own statement, and it persists
      aliases curl           `curl -s url` reaches Invoke-WebRequest, which
                             has no -s and prompts for a Uri
      runs gradlew.bat       `./gradlew` is the shell script, for Linux

    A build that depends on remembering four shell differences is a build that
    fails on a Friday. So: one command, and it refuses with a sentence naming
    what to install rather than failing deep inside Gradle.

    ─────────────────────────────────────────────────────────────────────────
    WHAT IT DOES NOT DO.

    It does not install anything. A JDK and the Android SDK are multi-gigabyte
    downloads that want a UAC prompt somebody has to click -- the Temurin
    install already failed once with exit 1602, which IS that prompt being
    dismissed -- and a script that half-installs a toolchain is worse than one
    that says what is missing.

    It does not sign. Signing needs the keystore, and the keystore does not
    belong in a repository. See -Release below.

        .pp\scriptsuild-android.ps1              # debug APK, sideloadable
        .pp\scriptsuild-android.ps1 -Release     # AAB for the Play Console
        .pp\scriptsuild-android.ps1 -Apk         # APK instead of an AAB
        ... -ApiUrl https://staging.example.com         # something other than production
#>

[CmdletBinding()]
param(
    # An AAB for the Play Console. Needs the signing config; see the refusal.
    [switch]$Release,
    # An APK rather than an AAB. For sideloading onto the drivers' phones.
    [switch]$Apk,
    # Baked into the JS bundle at build time, which is why it is here and not
    # in a file: the bundle is produced by the Gradle task below.
    [string]$ApiUrl = 'https://logs.izyglobalservices.com',
    # Regenerate android/ from app.json and app.config.ts first.
    [switch]$Prebuild
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $appDir 'android'

function Fail($message, $fix) {
    Write-Host ''
    Write-Host "  $message" -ForegroundColor Red
    Write-Host ''
    foreach ($line in $fix) { Write-Host "    $line" }
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host "  APP       $appDir"
Write-Host "  API URL   $ApiUrl"
Write-Host "  OUTPUT    $(if ($Release) { if ($Apk) { 'signed APK' } else { 'signed AAB (Play Console)' } } else { 'debug APK' })"
Write-Host ''

# ─────────────────────────────────────────────────────── the toolchain

# A JDK THAT IS INSTALLED BUT NOT ON PATH IS THE COMMON CASE, NOT THE RARE
# ONE. Temurin's installer leaves "Set JAVA_HOME" and "Add to PATH" switched
# OFF by default, and Android Studio hides a perfectly good JDK inside itself.
# Refusing on `java` alone would send somebody to reinstall a thing they
# already have.
function Find-Jdk {
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        return $env:JAVA_HOME
    }
    if (Get-Command java -ErrorAction SilentlyContinue) { return $null }  # already on PATH

    $roots = @(
        "$env:ProgramFiles\Eclipse Adoptium"
        "$env:LOCALAPPDATA\Programs\Eclipse Adoptium"
        "$env:ProgramFiles\Java"
        "$env:ProgramFiles\Microsoft\jdk"
        "$env:ProgramFiles\Android\Android Studio\jbr"
        "$env:LOCALAPPDATA\Programs\Android Studio\jbr"
        "$env:LOCALAPPDATA\Programs\AdoptiumJDK"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        if (Test-Path (Join-Path $root 'bin\java.exe')) { return $root }
        $hit = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
            Sort-Object Name -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$found = Find-Jdk
if ($found) {
    $env:JAVA_HOME = $found
    $env:PATH = (Join-Path $found 'bin') + ';' + $env:PATH
    Write-Host "  JDK       $found  (found, not on PATH)"
}

if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    Fail 'No JDK on this machine, and none in the usual places. Gradle cannot run.' @(
        'THE INSTALLER NEEDS ELEVATION AND HAS REFUSED THREE TIMES. winget'
        'exit 1602 is ERROR_INSTALL_USEREXIT -- the UAC consent dialog was'
        'dismissed. Raised from a terminal embedded in an app it often cannot'
        'present itself properly, so retrying it there will keep failing.'
        ''
        'THE PATH THAT NEEDS NO ADMINISTRATOR AT ALL. A JDK is a folder; the'
        'installer only adds Start menu entries and registry keys that nothing'
        'here uses. Download the zip and point at it:'
        ''
        '  $jdk = "$env:LOCALAPPDATA\Programs\jdk17"'
        '  $zip = "$env:TEMP\temurin17.zip"'
        '  Invoke-WebRequest -Uri "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk" -OutFile $zip'
        '  Expand-Archive $zip -DestinationPath $jdk -Force'
        '  [Environment]::SetEnvironmentVariable("JAVA_HOME", (Get-ChildItem $jdk -Directory)[0].FullName, "User")'
        ''
        'Then OPEN A NEW TERMINAL and run this script again. It reads'
        'JAVA_HOME, so PATH does not have to be touched.'
        ''
        'OR, if you would rather have the installer: open PowerShell from the'
        'Start menu with "Run as administrator" -- OUTSIDE this app, so the'
        'elevation prompt has somewhere to appear -- and run the winget line'
        'from the README. Then open a new terminal.'
    )
}

if (-not $env:ANDROID_HOME -and -not $env:ANDROID_SDK_ROOT) {
    $likely = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    $found = Test-Path $likely
    Fail 'ANDROID_HOME is not set, so Gradle cannot find the Android SDK.' @(
        $(if ($found) {
            "The SDK looks like it is already at $likely. Point at it:"
        } else {
            'Install the SDK first: Android Studio, or the command-line tools.'
            'Then point at it (the default location is):'
        })
        ''
        "  `$env:ANDROID_HOME = `"$likely`""
        ''
        'That lasts for this terminal only. To keep it:'
        ''
        "  [Environment]::SetEnvironmentVariable('ANDROID_HOME', `"$likely`", 'User')"
    )
}

# ─────────────────────────────────────────────────────── the native project

if ($Prebuild -or -not (Test-Path $androidDir)) {
    Write-Host '  Generating android/ from app.json and app.config.ts...'
    Push-Location $appDir
    try {
        # Set here, not prefixed: app.config.ts reads it, and resolveApiUrl
        # refuses a release build that points at localhost or plain http.
        $env:EXPO_PUBLIC_API_URL = $ApiUrl
        npx expo prebuild --platform android --no-install
        if ($LASTEXITCODE -ne 0) { Fail 'expo prebuild failed.' @('The output above says why.') }
    } finally { Pop-Location }
    Write-Host ''
}

if (-not (Test-Path (Join-Path $androidDir 'gradlew.bat'))) {
    Fail 'android/ exists but has no gradlew.bat.' @(
        'Regenerate it:'
        ''
        '  .pp\scriptsuild-android.ps1 -Prebuild'
    )
}

# ─────────────────────────────────────────────────────── signing

if ($Release) {
    $props = Join-Path $androidDir 'gradle.properties'
    $hasSigning = (Test-Path $props) -and
        # A LIVE PROPERTY, NOT A MENTION OF ONE. Matching the raw file meant
        # the commented block documenting these four lines satisfied the
        # check, so the script went on to build a release AAB signed with the
        # DEBUG key, silently: Gradle's hasProperty is false for a commented
        # line while a -match on the whole file is true. Only an anchored,
        # uncommented assignment counts.
        ((Get-Content $props) -match '^\s*IZY_UPLOAD_STORE_FILE\s*=\s*\S')
    if (-not $hasSigning) {
        Fail 'A release build needs a signing key, and there is none configured.' @(
            'THIS KEY IS THE APP. Lose it and the Play listing can never be'
            'updated again -- a new key is a new app, with a new install base.'
            'Back it up somewhere that is not this laptop and not this repo.'
            ''
            'Create one (keytool ships with the JDK):'
            ''
            '  keytool -genkeypair -v -keystore izy-upload.jks -alias izy-upload -keyalg RSA -keysize 2048 -validity 10000'
            ''
            'One line, deliberately. PowerShell continues a line with a'
            'backtick, not a backslash, so a command split the bash way runs'
            'as two broken halves instead of one.'
            ''
            "Put it outside the repository, then add to $props :"
            ''
            '  IZY_UPLOAD_STORE_FILE=C:/keys/izy-upload.jks'
            '  IZY_UPLOAD_KEY_ALIAS=izy-upload'
            '  IZY_UPLOAD_STORE_PASSWORD=...'
            '  IZY_UPLOAD_KEY_PASSWORD=...'
            ''
            'gradle.properties is gitignored by the Expo template. Confirm that'
            'with `git check-ignore -v android/gradle.properties` before you put'
            'a password in it.'
        )
    }
}

# ─────────────────────────────────────────────────────── build

$task = if (-not $Release) { 'assembleDebug' }
        elseif ($Apk) { 'assembleRelease' }
        else { 'bundleRelease' }

Write-Host "  gradlew $task"
Write-Host ''

Push-Location $androidDir
try {
    # Its own statement. PowerShell has no `FOO=bar cmd` form, and this is the
    # variable the JS bundle is built with -- unset, a release build takes the
    # development path and bakes in this machine's LAN address.
    $env:EXPO_PUBLIC_API_URL = $ApiUrl
    & .\gradlew.bat $task
    $code = $LASTEXITCODE
} finally { Pop-Location }

if ($code -ne 0) {
    Fail "gradlew $task failed (exit $code)." @(
        'Common first-build causes, in the order they happen:'
        '  - JDK 21 instead of 17: AGP 8 refuses it. java -version'
        '  - SDK platform not installed: the error names the API level'
        '  - licences not accepted: sdkmanager --licenses'
    )
}

$out = Get-ChildItem -Path $androidDir -Recurse -Include *.apk, *.aab `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'build\\outputs' } |
    Sort-Object LastWriteTime -Descending

Write-Host ''
if ($out) {
    Write-Host '  Built:' -ForegroundColor Green
    foreach ($f in $out | Select-Object -First 3) {
        Write-Host ("    {0}  ({1:N1} MB)" -f $f.FullName, ($f.Length / 1MB))
    }
} else {
    Write-Host '  Gradle reported success but no .apk or .aab was found under build\outputs.' -ForegroundColor Yellow
}
Write-Host ''
if ($Release -and -not $Apk) {
    Write-Host '  That .aab is what the Play Console takes. An .aab does not install'
    Write-Host '  on a phone -- use -Apk for something to sideload.'
    Write-Host ''
}
