@echo off
REM Serves this folder over http://localhost:8000 and opens the encrypter.
REM A local server is required because ES module imports are blocked by
REM CORS on the file:// protocol.

cd /d "%~dp0"

set PORT=8000
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Starting Python server on http://localhost:%PORT%/
  start "" "http://localhost:%PORT%/index.html"
  python -m http.server %PORT%
  goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Starting Python server on http://localhost:%PORT%/
  start "" "http://localhost:%PORT%/index.html"
  py -m http.server %PORT%
  goto :eof
)

where node >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Starting Node server on http://localhost:%PORT%/
  start "" "http://localhost:%PORT%/index.html"
  node server.js
  goto :eof
)

echo Could not find python or node to run a local web server.
echo Install Python or Node.js, then run start.bat again.
pause