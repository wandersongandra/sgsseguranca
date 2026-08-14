@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

title Deploy seguro para o GitHub

echo.
echo ==========================================
echo   Deploy seguro para o GitHub
echo ==========================================
echo.

REM Verificar se o Git está instalado
where git >nul 2>&1
if errorlevel 1 (
    echo ERRO: Git nao foi encontrado no computador.
    echo Instale o Git e tente novamente.
    goto :fail
)

REM Verificar se o diretório é um repositório Git
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo ERRO: Esta pasta nao e um repositorio Git.
    echo Diretorio atual: %CD%
    goto :fail
)

REM Verificar se o remote origin existe
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    echo ERRO: O repositorio nao possui o remote "origin".
    echo.
    echo Configure utilizando:
    echo git remote add origin URL_DO_REPOSITORIO
    goto :fail
)

REM Identificar a branch atual
for /f "delims=" %%B in ('git branch --show-current 2^>nul') do (
    set "BRANCH=%%B"
)

if not defined BRANCH (
    echo ERRO: Nao foi possivel identificar a branch atual.
    echo Verifique se o repositorio esta em detached HEAD.
    goto :fail
)

echo Repositorio:
echo %CD%
echo.
echo Branch atual:
echo %BRANCH%
echo.
echo Repositorio remoto:
git remote get-url origin
echo.

echo Arquivos alterados:
git status --short
echo.

REM Receber a mensagem de commit pelo argumento ou solicitar ao usuário
set "COMMIT_MESSAGE=%~1"

if not defined COMMIT_MESSAGE (
    set /p "COMMIT_MESSAGE=Digite a mensagem do commit: "
)

if not defined COMMIT_MESSAGE (
    echo ERRO: A mensagem do commit nao pode ficar vazia.
    goto :fail
)

echo.
set /p "CONFIRM=Adicionar arquivos, criar commit e enviar a branch %BRANCH%? [S/N]: "

if /I not "%CONFIRM%"=="S" (
    echo.
    echo Operacao cancelada.
    goto :end
)

echo.
echo [1/5] Adicionando alteracoes...
git add -A

if errorlevel 1 (
    echo ERRO: Falha ao adicionar os arquivos.
    goto :fail
)

echo.
echo Verificando arquivos potencialmente sensiveis...

set "SENSITIVE_FOUND="

for /f "delims=" %%F in ('git diff --cached --name-only') do (
    echo %%F | findstr /I /R ^
        /C:"^\.env$" ^
        /C:"^\.env\." ^
        /C:"\.pem$" ^
        /C:"\.key$" ^
        /C:"id_rsa" ^
        /C:"credentials" ^
        /C:"secret" >nul 2>&1

    if not errorlevel 1 (
        set "SENSITIVE_FOUND=1"
    )
)

if defined SENSITIVE_FOUND (
    echo.
    echo ERRO: Foram encontrados arquivos potencialmente sensiveis:
    echo.

    git diff --cached --name-only | findstr /I /R ^
        /C:"^\.env$" ^
        /C:"^\.env\." ^
        /C:"\.pem$" ^
        /C:"\.key$" ^
        /C:"id_rsa" ^
        /C:"credentials" ^
        /C:"secret"

    echo.
    echo Remova esses arquivos antes de continuar.
    echo.
    echo Exemplo:
    echo git restore --staged NOME_DO_ARQUIVO
    echo.
    echo Verifique tambem o arquivo .gitignore.
    goto :fail
)

REM Verificar se existem alterações para commit
git diff --cached --quiet

if not errorlevel 1 (
    echo.
    echo Nenhuma alteracao foi encontrada para commit.
    goto :end
)

echo.
echo Arquivos preparados para o commit:
git diff --cached --stat

echo.
echo [2/5] Criando commit...
git commit -m "%COMMIT_MESSAGE%"

if errorlevel 1 (
    echo.
    echo ERRO: Nao foi possivel criar o commit.
    echo Verifique hooks, lint, testes ou configuracoes do Git.
    goto :fail
)

echo.
echo [3/5] Verificando a branch remota...

git ls-remote --exit-code --heads origin "%BRANCH%" >nul 2>&1

if not errorlevel 1 (
    echo.
    echo [4/5] Sincronizando com origin/%BRANCH%...
    git pull --rebase origin "%BRANCH%"

    if errorlevel 1 (
        echo.
        echo ERRO: O rebase nao foi concluido.
        echo.
        echo Resolva os conflitos e execute:
        echo git add .
        echo git rebase --continue
        echo.
        echo Para cancelar o rebase:
        echo git rebase --abort
        goto :fail
    )
) else (
    echo.
    echo [4/5] A branch ainda nao existe no GitHub.
    echo O primeiro push sera realizado.
)

echo.
echo [5/5] Enviando para o GitHub...
git push -u origin "%BRANCH%"

if errorlevel 1 (
    echo.
    echo ERRO: Falha ao enviar para o GitHub.
    echo.
    echo Verifique:
    echo - autenticacao no GitHub;
    echo - permissoes do repositorio;
    echo - protecao da branch;
    echo - conflitos com o repositorio remoto.
    goto :fail
)

echo.
echo ==========================================
echo   Deploy concluido com sucesso
echo ==========================================
echo.
echo Branch enviada:
echo %BRANCH%
echo.
echo Ultimo commit:
git log -1 --oneline
echo.

goto :end

:fail
echo.
echo ==========================================
echo   Processo interrompido devido a um erro
echo ==========================================
echo.
pause
endlocal
exit /b 1

:end
echo.
pause
endlocal
exit /b 0