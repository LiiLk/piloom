@ECHO off
SETLOCAL
SET "PILOOM_ROOT=%~dp0"
SET "PRIME_AGENT_LAUNCHER_PATH=%~f0"

IF NOT EXIST "%PILOOM_ROOT%node_modules\tsx\dist\cli.mjs" (
	ECHO tsx was not found. Run npm.cmd ci from %PILOOM_ROOT% first. 1>&2
	EXIT /B 1
)

node "%PILOOM_ROOT%node_modules\tsx\dist\cli.mjs" --tsconfig "%PILOOM_ROOT%tsconfig.json" "%PILOOM_ROOT%packages\coding-agent\src\cli.ts" %*
EXIT /B %ERRORLEVEL%
