@echo off
REM Launches the copied Moon Sweepers in .\game and attaches the trainer panel.
cd /d "%~dp0"
"%~dp0tools\venv\Scripts\python.exe" -I -u "%~dp0moon_trainer.py" %*
if errorlevel 1 pause
