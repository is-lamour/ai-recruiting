@echo off
setlocal enabledelayedexpansion

set ROOT=%~dp0
set DIST_DIR=%ROOT%dist_build
set PYTHON_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip
set PYTHON_ZIP=%ROOT%python-embed.zip
set PYTHON_DIR=%DIST_DIR%\python
set GET_PIP_URL=https://bootstrap.pypa.io/get-pip.py
set GET_PIP=%ROOT%get-pip.py
set OUT_ZIP=%ROOT%ai-recruiting-dist.zip

echo [build] AI Recruiting - building distribution package
echo.

REM Clean previous build
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
if exist "%OUT_ZIP%"  del /q "%OUT_ZIP%"
mkdir "%DIST_DIR%"
mkdir "%PYTHON_DIR%"

REM -- 1. Download Python Embedded --
echo [1/5] Downloading Python 3.11 Embedded...
if not exist "%PYTHON_ZIP%" (
    powershell -Command "Invoke-WebRequest -Uri '%PYTHON_URL%' -OutFile '%PYTHON_ZIP%'"
)
if not exist "%PYTHON_ZIP%" (
    echo [ERROR] Failed to download Python
    pause & exit /b 1
)

REM -- 2. Extract Python Embedded --
echo [2/5] Extracting Python Embedded...
powershell -Command "Expand-Archive -Path '%PYTHON_ZIP%' -DestinationPath '%PYTHON_DIR%' -Force"
if not exist "%PYTHON_DIR%\python.exe" (
    echo [ERROR] Failed to extract Python
    pause & exit /b 1
)

REM Enable site-packages (uncomment import site in .pth file)
set PTH_FILE=%PYTHON_DIR%\python311._pth
if exist "%PTH_FILE%" (
    powershell -Command "(Get-Content '%PTH_FILE%') -replace '#import site', 'import site' | Set-Content '%PTH_FILE%'"
)

REM -- 3. Install pip --
echo [3/5] Installing pip...
if not exist "%GET_PIP%" (
    powershell -Command "Invoke-WebRequest -Uri '%GET_PIP_URL%' -OutFile '%GET_PIP%'"
)
"%PYTHON_DIR%\python.exe" "%GET_PIP%" --no-warn-script-location >nul 2>&1
"%PYTHON_DIR%\python.exe" -m pip --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to install pip
    pause & exit /b 1
)

REM -- 4. Install dependencies --
echo [4/5] Installing dependencies...
"%PYTHON_DIR%\python.exe" -m pip install -r "%ROOT%backend\requirements.txt" --no-warn-script-location -q
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies
    pause & exit /b 1
)

REM -- 5. Copy project files --
echo [5/5] Copying project files...

mkdir "%DIST_DIR%\backend\static"
copy /y "%ROOT%backend\main.py"              "%DIST_DIR%\backend\" >nul
copy /y "%ROOT%backend\ai.py"                "%DIST_DIR%\backend\" >nul
copy /y "%ROOT%backend\database.py"          "%DIST_DIR%\backend\" >nul
copy /y "%ROOT%backend\requirements.txt"     "%DIST_DIR%\backend\" >nul
copy /y "%ROOT%backend\static\index.html"    "%DIST_DIR%\backend\static\" >nul
copy /y "%ROOT%backend\static\app.js"        "%DIST_DIR%\backend\static\" >nul
copy /y "%ROOT%backend\static\style.css"     "%DIST_DIR%\backend\static\" >nul

mkdir "%DIST_DIR%\extension"
copy /y "%ROOT%extension\manifest.json"       "%DIST_DIR%\extension\" >nul
copy /y "%ROOT%extension\popup.html"          "%DIST_DIR%\extension\" >nul
copy /y "%ROOT%extension\popup.js"            "%DIST_DIR%\extension\" >nul
copy /y "%ROOT%extension\popup.css"           "%DIST_DIR%\extension\" >nul
copy /y "%ROOT%extension\content.js"          "%DIST_DIR%\extension\" >nul
copy /y "%ROOT%extension\background.js"       "%DIST_DIR%\extension\" >nul
copy /y "%ROOT%extension\dashboard_bridge.js" "%DIST_DIR%\extension\" >nul

copy /y "%ROOT%start.bat"       "%DIST_DIR%\" >nul
copy /y "%ROOT%INSTRUKCIYA.txt" "%DIST_DIR%\" >nul 2>&1

REM -- Pack into zip --
echo.
echo Packing into zip...
powershell -Command "Compress-Archive -Path '%DIST_DIR%\*' -DestinationPath '%OUT_ZIP%' -Force"
if not exist "%OUT_ZIP%" (
    echo [ERROR] Failed to create zip
    pause & exit /b 1
)

REM Wait for zip to finish then cleanup
:WAIT_ZIP
if not exist "%OUT_ZIP%" goto WAIT_ZIP
timeout /t 2 /nobreak >nul
rmdir /s /q "%DIST_DIR%" 2>nul
del /q "%PYTHON_ZIP%" 2>nul
del /q "%GET_PIP%" 2>nul

echo.
echo Done! File: ai-recruiting-dist.zip
for %%A in ("%OUT_ZIP%") do echo Size: %%~zA bytes
echo.
pause
