@echo off
REM Is the app actually reachable right now?
REM
REM Answers the only question that matters at 6am: can a tester on another
REM network open it. Checks the two local processes AND pulls the real bundle
REM through the public domain, because a tunnel answering /status proves very
REM little on its own.
setlocal
set HOSTNAME=applicant-drainpipe-declared.ngrok-free.dev

echo.
echo   ngrok process:
tasklist /fi "imagename eq ngrok.exe" 2>nul | find /i "ngrok.exe" >nul && (echo     running) || (echo     NOT RUNNING)

echo   metro on 8081:
netstat -ano | find "LISTENING" | find ":8081" >nul && (echo     listening) || (echo     NOT LISTENING)

echo   tunnel reachable:
curl -s -o nul -m 20 -w "     HTTP %%{http_code}\n" "https://%HOSTNAME%/status"

echo   bundle downloadable (the real test):
curl -s -o nul -m 180 -w "     HTTP %%{http_code}  %%{size_download} bytes in %%{time_total}s\n" "https://%HOSTNAME%/index.ts.bundle?platform=ios&dev=true"

echo   production API:
curl -s -o nul -m 20 -w "     HTTP %%{http_code}\n" "https://logs.izyglobalservices.com/health"
echo.
echo   A healthy run is: running / listening / 200 / 200 with ~5MB / 200
echo.
pause
