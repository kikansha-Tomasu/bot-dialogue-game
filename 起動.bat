@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   Bot Game Server (Hugging Face AI) - http://127.0.0.1:8765
echo   Close this window to stop.
echo ================================================
echo.

set "PY_CMD="
if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PY_CMD="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
) else (
    py -3.12 --version >nul 2>&1
    if %errorlevel%==0 (
        set "PY_CMD=py -3.12"
    ) else (
        where python >nul 2>&1
        if %errorlevel%==0 (
            set "PY_CMD=python"
            echo [INFO] Python 3.12 が見つからないため既定の python で起動します。
        ) else (
            echo [ERROR] Python が見つかりません。Python 3.12 をインストールしてください。
            pause
            exit /b 1
        )
    )
)

%PY_CMD% -c "import flask, flask_cors, requests" >nul 2>&1
if not %errorlevel%==0 (
    echo [INFO] 依存パッケージをインストールしています...
    %PY_CMD% -m pip install -r requirements.txt
)

start /b powershell -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:8765'"
%PY_CMD% server.py
pause
