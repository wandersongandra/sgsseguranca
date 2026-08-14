@echo off
chcp 65001 >nul
cls

echo ════════════════════════════════════════════════════════════════
echo   INICIAR FRONTEND
echo ════════════════════════════════════════════════════════════════
echo.

echo [1/2] Verificando build...
if not exist ".next" (
    echo ⚠️  Build não encontrado. Executando build...
    npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo ❌ Erro no build
        pause
        exit /b 1
    )
)

echo ✅ Build encontrado
echo.

echo [2/2] Iniciando servidor...
echo.
echo 🚀 Frontend rodando em http://localhost:3000
echo.

npm start

pause
