@echo off

set BACKEND=%~dp0backend
set ENV_FILE=%~dp0.env

if not exist "%ENV_FILE%" (
    echo [ERROR] .env file not found!
    echo Copy .env.example to .env and add your GEMINI_API_KEY
    pause
    exit /b 1
)

pip show fastapi >nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Installing dependencies...
    pip install -r "%BACKEND%\requirements.txt"
)

echo [*] Starting server at http://localhost:8000
echo [*] Dashboard: http://localhost:8000
echo.

cd /d "%BACKEND%"
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload

pause
