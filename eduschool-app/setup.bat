@echo off
echo === Shamdan Setup ===

cd /d "%~dp0"

REM --- .env ---
if not exist "server\.env" (
    echo [1/5] Создаём server\.env из примера...
    copy "server\.env.example" "server\.env" >nul
    echo       Готово.
) else (
    echo [1/5] server\.env уже существует, пропускаем.
)

REM --- Docker DB ---
echo [2/5] Запускаем PostgreSQL в Docker...
docker-compose up -d
if errorlevel 1 (
    echo ОШИБКА: Docker не запущен или не установлен.
    echo Установи Docker Desktop: https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
)
echo       Ждём 3 секунды пока БД поднимется...
timeout /t 3 /nobreak >nul

REM --- npm install ---
echo [3/5] Устанавливаем зависимости сервера...
cd server && npm install --silent
echo       Устанавливаем зависимости клиента...
cd ..\client && npm install --silent
cd ..

REM --- Prisma ---
echo [4/5] Накатываем миграции базы данных...
cd server
npx prisma migrate reset --force
npx prisma generate
cd ..

echo [5/5] Всё готово!
echo.
echo Теперь запусти: npm run dev
echo.
pause
