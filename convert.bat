@echo off
REM ----------------------------------------------------
REM  md2pdf - Drag .md files onto this icon to convert
REM ----------------------------------------------------

REM Path to the converter. By default it lives next to this .bat file.
REM If you move this .bat elsewhere - Desktop, taskbar, Send To menu -
REM point this at convert.js in your md2pdf folder instead, e.g.:
REM   set "CONVERTER=C:\path\to\md2pdf\convert.js"
set "CONVERTER=%~dp0convert.js"

REM Friendly hint if the .bat was moved but the path above was not updated
if not exist "%CONVERTER%" (
    echo.
    echo   md2pdf - cannot find the converter script at:
    echo     %CONVERTER%
    echo.
    echo   This convert.bat is no longer next to convert.js. Open the .bat
    echo   in a text editor and set the CONVERTER line near the top to the
    echo   full path of convert.js in your md2pdf folder, for example:
    echo     set "CONVERTER=C:\path\to\md2pdf\convert.js"
    echo.
    pause
    exit /b 1
)

REM Check if any files were passed
if "%~1"=="" (
    echo.
    echo   md2pdf - Markdown to PDF Converter
    echo   ----------------------------------
    echo.
    echo   Drag one or more .md files onto this icon,
    echo   or run:  convert.bat myfile.md
    echo.
    pause
    exit /b
)

REM Run the Node.js converter with all arguments
node "%CONVERTER%" %*

echo.
pause
