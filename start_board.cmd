@echo off
setlocal
cd /d "%~dp0"
set COMPANY_RESEARCH_TIDEOS=true
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
node --env-file-if-exists=.env.tideos scripts\start-board.mjs
exit /b %errorlevel%
