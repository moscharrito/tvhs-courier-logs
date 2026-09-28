@echo off
title Izy tunnel (ngrok)
REM The public door to Metro, on the static ngrok domain.
REM
REM THE LOOP IS THE POINT. ngrok exits on a dropped connection, a laptop
REM sleeping, or a stop request from whatever console started it; without the
REM loop the testers' app simply stops working and nobody knows until somebody
REM complains. Ten seconds is long enough not to hammer ngrok's API and short
REM enough that a blip is invisible.
REM
REM The domain belongs to the ngrok account, so the URL never changes and the
REM QR handed out to testers stays valid forever.
set NGROK=%LOCALAPPDATA%\Microsoft\WinGet\Links\ngrok.exe
:loop
echo [%date% %time%] starting ngrok
"%NGROK%" http --domain=applicant-drainpipe-declared.ngrok-free.dev 8081 --log=stdout
echo [%date% %time%] ngrok exited, restarting in 10s
timeout /t 10 /nobreak >nul
goto loop
