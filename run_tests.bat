@echo off
set /p API_KEY="Gemini API key: "

echo.
echo [1/2] test_gemini...
python test_gemini.py %API_KEY%
if errorlevel 1 (
    echo FAILED
    pause
    exit /b 1
)

echo.
echo [2/2] test_screening...
python test_screening.py %API_KEY%

echo.
pause
