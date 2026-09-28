@echo off
title Izy Metro
REM Metro, told to advertise the tunnel hostname rather than a LAN address.
REM
REM EXPO_PACKAGER_PROXY_URL is what makes the manifest hand the phone a
REM reachable bundle URL. Without it Metro advertises this machine's LAN IP,
REM which means nothing to a tester on another network and produces an app
REM that opens to a blank screen and no useful error.
REM
REM CI is cleared deliberately: set, it disables watch mode, and a reload that
REM silently does nothing is a bad hour.
REM
REM Looped for the same reason as the tunnel: Metro dies with the console that
REM started it, and a bundler that is down is an app that cannot load.
cd /d "%~dp0"
set CI=
set EXPO_PACKAGER_PROXY_URL=https://applicant-drainpipe-declared.ngrok-free.dev
set REACT_NATIVE_PACKAGER_HOSTNAME=applicant-drainpipe-declared.ngrok-free.dev
:loop
echo [%date% %time%] starting metro
call npx expo start --port 8081
echo [%date% %time%] metro exited, restarting in 10s
timeout /t 10 /nobreak >nul
goto loop
