@echo off
setlocal

set "FORMAT=%~1"
if "%FORMAT%"=="" (
    set FORMAT=nsis
) else if "%FORMAT%"=="exe" (
    set FORMAT=nsis
) else if "%FORMAT%"=="msi" (
    set FORMAT=msi
) else if "%FORMAT%"=="all" (
    set FORMAT=nsis,msi
) else (
    echo [ERROR] Unknown format: %FORMAT%. Supported: exe, msi, all.
    pause
    exit /b 1
)

echo =======================================================
echo TriConnect - Windows Dependency Installer ^& Builder
echo =======================================================
echo.

:: 1. Check Node.js
echo Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)
node --version

:: 2. Check Rust/Cargo
echo Checking Rust/Cargo...
where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Rust/Cargo is not installed. Please install Rust from https://rustup.rs/
    echo Make sure to install the MSVC build tools if prompted.
    pause
    exit /b 1
)
cargo --version

:: 3. Install Frontend and Tauri CLI dependencies
echo.
echo Installing Frontend and Tauri CLI dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install frontend dependencies.
    pause
    exit /b 1
)

:: 4. Install Signaling Server dependencies
echo.
echo Installing Signaling Server dependencies...
cd signaling-server
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install signaling server dependencies.
    cd ..
    pause
    exit /b 1
)
cd ..

:: 5. Build Tauri App
echo.
echo Building TriConnect (Format: %FORMAT%)...
echo Note: The first build will take some time as Rust downloads and compiles crates.
call npx tauri build --bundles %FORMAT%
if %errorlevel% neq 0 (
    echo [ERROR] Failed to build the Tauri bundle(s).
    pause
    exit /b 1
)

echo.
echo =======================================================
echo Build complete! Your packaged application is located inside:
echo src-tauri\target\release\bundle\
echo =======================================================
pause
