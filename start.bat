@echo off
setlocal enabledelayedexpansion

set ROOT=%~dp0
set BACKEND=%ROOT%backend

REM Если есть python\ (дистрибутив) — используем его, иначе системный Python
if exist "%ROOT%python\python.exe" (
    set PYTHON=%ROOT%python\python.exe
) else (
    set PYTHON=python
)

echo [*] Starting server at http://localhost:8000

REM Установить зависимости если не установлены
"%PYTHON%" -c "import fastapi" >nul 2>&1
if errorlevel 1 (
    echo [*] Installing dependencies...
    "%PYTHON%" -m pip install -r "%BACKEND%\requirements.txt" -q
)

REM Запустить сервер в фоне и открыть браузер
start "" /b "%PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir "%BACKEND%"

echo [*] Waiting for server...
:WAIT_LOOP
timeout /t 1 /nobreak >nul
"%PYTHON%" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" >nul 2>&1
if errorlevel 1 goto WAIT_LOOP

start "" "http://localhost:8000"

echo [*] Server running at http://localhost:8000
echo [*] Close this window to stop.
echo.

"%PYTHON%" -m uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir "%BACKEND%"
pause
