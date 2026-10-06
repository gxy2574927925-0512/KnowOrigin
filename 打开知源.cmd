@echo off
setlocal EnableExtensions EnableDelayedExpansion

chcp 936 >nul

:: 本文件以 GBK(cp936) 保存。先把控制台码页切到 936，否则从 UTF-8 终端（如 IDE 内置
:: 终端）启动时，中文会整片乱码，多字节错位还会把注释行拆开当命令执行，报一堆
:: "不是内部或外部命令"。注意：改本文件时必须保持 GBK 编码，用 UTF-8 保存会重现此问题。

:: ============================================================================
::  知源 KnowOrigin · Windows 一键启动器
::
::  自动完成：Python 检测（缺失时 winget 自动安装）→ 虚拟环境 → 依赖安装 → 端口探测 → 启动服务 → 打开浏览器
::  所有依赖仅安装在项目内 .venv311，不污染系统 Python 环境
:: ============================================================================

title 知源 KnowOrigin · 启动中

cd /d "%~dp0"
set "PROJECT_ROOT=%cd%"
if not "%PROJECT_ROOT:~-1%"=="\" set "PROJECT_ROOT=%PROJECT_ROOT%\"

set "VENV_DIR=%PROJECT_ROOT%.venv311"
set "LOG_DIR=%PROJECT_ROOT%logs"
set "STDOUT_LOG=%LOG_DIR%\knoworigin-server.out.log"
set "STDERR_LOG=%LOG_DIR%\knoworigin-server.err.log"
set "URL_FILE=%LOG_DIR%\knoworigin-mobile-url.txt"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: --------------------------------------------------------------------------
::  路径长度自检
::
::  Windows 的 260 字符上限卡的不是项目本身，而是 .venv311 里的深层路径：
::  根目录 + \Lib\site-packages\ + 包内最深的那个文件（onnxruntime、
::  rapidocr 这类多子包的依赖很轻松就吃掉 100+ 字符）。根目录一旦逼近 150
::  字符，python -m venv 内部的 ensurepip 就会抛 WinError 206「文件名或扩展名
::  太长」，而报错表面看只写着「虚拟环境创建失败」，完全指不到路径上。
::  典型踩坑方式：把 zip 解压进同名目录，Windows 自动生成 "(1)"、"(4)"，
::  反复几次就叠成七八层。这里提前量一下并给出可执行的处理办法。
:: --------------------------------------------------------------------------
set "PATH_TAIL=%PROJECT_ROOT%"
set /a ROOT_LEN=0
:root_len_loop
if not defined PATH_TAIL goto :root_len_done
set "PATH_TAIL=!PATH_TAIL:~1!"
set /a ROOT_LEN+=1
goto :root_len_loop
:root_len_done
set "PATH_TAIL="
:: [!] 这一块刻意**不用括号块**：块内对路径做「立即展开」的 echo 时，
::   只要路径里含 ) ——例如 Windows 解压同名目录自动生成的 "(4)" ——
::   cmd 会把 (4) 的 ) 当成块的结束符，剩下的路径尾巴变成一条新命令，
::   整个脚本以「此时不应有 \agent2026-Knoworigin-main」当场中止，
::   双击的表现就是窗口一闪而过（闪退）。
::   实测三种写法的安全边界：块内 echo !VAR!（延迟展开）安全、
::   带引号的 set "X=%VAR%" 安全、顶层 echo %VAR% 安全，
::   只有「块内 + 立即展开 + 无引号」这一种会炸。改成 goto 就彻底没有这类问题。
if !ROOT_LEN! LEQ 150 goto :path_ok
echo.
echo   [警告] 项目路径过长：!ROOT_LEN! 字符（Windows 上限 260）。
echo          虚拟环境和依赖包的内部路径还要再深一百多字符，
echo          继续下去很可能报「WinError 206 文件名或扩展名太长」，
echo          或依赖装到一半静默失败。
echo.
echo          当前路径：%PROJECT_ROOT%
echo          处理办法：把整个项目文件夹移动到短路径后重新双击本文件，
echo                    例如  E://KnowOrigin  ，移动后路径约 15 字符。
echo.
echo          按任意键仍要继续尝试，或直接关掉本窗口中止。
pause >nul
:path_ok

echo.
echo   ____________________________________________________
echo.
echo        知源 KnowOrigin  ·  本地优先的 AI 课程学习工作台
echo   ____________________________________________________
echo.

:: ==========================================================================
:: [1/5] 定位 Python 运行时
:: ==========================================================================
echo   [1/5] 检测 Python 运行时（缺失时尝试自动安装）...

set "PY_EXE="

:: 优先复用项目内已有的 .venv311（若因文件夹被移动而损坏则重建）
if exist "%VENV_DIR%\Scripts\python.exe" (
    "%VENV_DIR%\Scripts\python.exe" -c "import sys; exit(0 if sys.version_info>=(3,11) else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "PY_EXE=%VENV_DIR%\Scripts\python.exe"
        echo        已就绪：项目虚拟环境 .venv311
        goto :python_ok
    )
    if exist "%VENV_DIR%\pyvenv.cfg" (
        echo        .venv311 已损坏（目录被移动过），正在重建 ...
        rmdir /s /q "%VENV_DIR%"
    )
)

:: 兼容旧版 .venv
if exist "%PROJECT_ROOT%.venv\Scripts\python.exe" (
    "%PROJECT_ROOT%.venv\Scripts\python.exe" -c "import sys; exit(0 if sys.version_info>=(3,11) else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "PY_EXE=%PROJECT_ROOT%.venv\Scripts\python.exe"
        echo        已就绪：项目虚拟环境 .venv
        goto :python_ok
    )
)

:: 寻找系统 Python 3.11+ 作为创建 venv 的引导解释器
set "BOOTSTRAP="
for /f "delims=" %%P in ('where python 2^>nul') do (
    "%%P" -c "import sys; exit(0 if sys.version_info>=(3,11) else 1)" >nul 2>nul
    if not errorlevel 1 (
        set "BOOTSTRAP=%%P"
        goto :bootstrap_ok
    )
)
for %%L in (
    "%LocalAppData%\Programs\Python\Python313\python.exe"
    "%LocalAppData%\Programs\Python\Python312\python.exe"
    "%LocalAppData%\Programs\Python\Python311\python.exe"
    "C:\Program Files\Python313\python.exe"
    "C:\Program Files\Python312\python.exe"
    "C:\Program Files\Python311\python.exe"
) do (
    if exist "%%~L" (
        "%%~L" -c "import sys; exit(0 if sys.version_info>=(3,11) else 1)" >nul 2>nul
        if not errorlevel 1 (
            set "BOOTSTRAP=%%~L"
            goto :bootstrap_ok
        )
    )
)

:: --------------------------------------------------------------------------
:: 仍未找到系统 Python：尝试用 winget 自动装一个（Win10 1809+ / Win11 自带）。
:: 这是唯一无法「纯脚本」解决的依赖——创建 venv 必须已有解释器，
:: 所以交给系统包管理器补上；winget 不可用或安装失败则退回下面的手动提示。
:: --------------------------------------------------------------------------
where winget >nul 2>nul
if errorlevel 1 (
    echo        本机未检测到 winget，跳过自动安装。
    goto :python_missing
)

echo.
echo        未找到 Python 3.11 或更高版本，正在通过 winget 自动安装 Python 3.12 ...
echo        首次安装约需 1-3 分钟，请保持本窗口打开。
echo.
winget install -e --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements

:: winget 装完不会刷新当前窗口的 PATH，直接按已知安装位置再探一次
if exist "%LocalAppData%\Programs\Python\Python312\python.exe" (
    set "BOOTSTRAP=%LocalAppData%\Programs\Python\Python312\python.exe"
    goto :bootstrap_ok
)
if exist "C:\Program Files\Python312\python.exe" (
    set "BOOTSTRAP=C:\Program Files\Python312\python.exe"
    goto :bootstrap_ok
)

echo.
echo        winget 已执行，但未在常见位置找到 python.exe。
echo        请关闭本窗口后重新双击本文件（新开的窗口才会刷新 PATH）。
echo.

:python_missing
echo.
echo   [错误] 未找到 Python 3.11 或更高版本。
echo         请前往 https://www.python.org/downloads/ 下载安装，
echo         安装时务必勾选 "Add Python to PATH"。
echo.
pause
exit /b 1

:bootstrap_ok
echo        正在创建项目虚拟环境 .venv311（首次运行约需 1 分钟）...
"!BOOTSTRAP!" -m venv "%VENV_DIR%"
if errorlevel 1 (
    echo.
    echo   [错误] 虚拟环境创建失败。
    echo.
    echo         按可能性排序的常见原因：
    echo           1. 项目路径过长（当前 !ROOT_LEN! 字符）。
    echo              venv 内部路径更深，撞上 Windows 260 字符上限时会报
    echo              「WinError 206 文件名或扩展名太长」。
    echo              把项目移到短路径（如 E://KnowOrigin）后重试。
    echo           2. 杀毒软件拦截了 venv 内的 ensurepip。
    echo              把项目目录加入白名单后重试。
    echo           3. Python 来自 Microsoft Store，沙箱限制了 venv。
    echo              改用 python.org 的安装包安装后重试。
    echo.
    echo         本次使用的引导解释器：!BOOTSTRAP!
    echo.
    pause
    exit /b 1
)
set "PY_EXE=%VENV_DIR%\Scripts\python.exe"
"!PY_EXE!" -m pip install --upgrade pip -q
echo        虚拟环境已创建，所有依赖将仅安装于项目内。

:python_ok

:: 确保 venv 内 pip 可用（修复 "No module named pip"）
"!PY_EXE!" -m pip --version >nul 2>nul
if errorlevel 1 (
    echo        pip 缺失，正在通过 ensurepip 修复 ...
    "!PY_EXE!" -m ensurepip --upgrade
    if errorlevel 1 (
        echo.
        echo   [错误] pip 安装失败，请手动执行：
        echo         "!PY_EXE!" -m ensurepip --upgrade
        echo.
        pause
        exit /b 1
    )
)

:: ==========================================================================
:: [2/5] 依赖深度检查（逐个 import 验证，而非仅看目录存在）
:: ==========================================================================
echo   [2/5] 检查依赖 ...

"!PY_EXE!" -c "import importlib.util as u,sys; mods=['fastapi','uvicorn','pydantic','fitz','pdfplumber','docx','pptx','PIL','httpx','dotenv','multipart','numpy','onnxruntime','bs4','trafilatura','lxml']; missing=[m for m in mods if not u.find_spec(m)]+([] if (u.find_spec('rapidocr') or u.find_spec('rapidocr_onnxruntime')) else ['rapidocr']); sys.exit(1 if missing else 0)"
if errorlevel 1 (
    echo        首次安装依赖，可能需要 3-5 分钟，请耐心等待 ...
    "!PY_EXE!" -m pip install -r "%PROJECT_ROOT%requirements.txt"
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败。可尝试国内镜像重试：
        echo         "!PY_EXE!" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
        echo.
        pause
        exit /b 1
    )
    echo        依赖安装完成。
) else (
    echo        依赖已就绪。
)

:: ==========================================================================
:: [3/5] 环境配置
:: ==========================================================================
echo   [3/5] 检查配置 ...

if not exist "%PROJECT_ROOT%.env" (
    if exist "%PROJECT_ROOT%.env.example" (
        copy /y "%PROJECT_ROOT%.env.example" "%PROJECT_ROOT%.env" >nul
    )
)

:: ==========================================================================
:: [4/5] 清理残留进程并探测端口
:: ==========================================================================
echo   [4/5] 准备端口 ...

:: 残留的旧进程会用旧代码继续服务，曾导致批量导入时公式检测整批丢失，启动前先清场。
::
:: 清场必须连 --reload 的工作进程一起收掉：Windows 上 uvicorn 的 reload 工作进程是
:: 用 multiprocessing spawn 另起的，命令行是 "from multiprocessing.spawn import spawn_main"
:: （不含 api_server 字样），只按 uvicorn 关键字杀会漏掉它。而它继承了上一轮的
:: 监听套接字和日志文件句柄——于是端口 17321 显示被一个已消失的 PID 占着，
:: 下一轮启动重定向日志时直接报「另一个程序正在使用此文件，进程无法访问」而中断。
:: 这里补上「父进程已消失的 multiprocessing 子进程」，并用 taskkill /T 连带整棵进程树。
powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter \"Name like '%%python%%'\"; $ids=@($p.ProcessId); $t=@($p | Where-Object { $_.CommandLine -match 'uvicorn api_server:app' -or ($_.CommandLine -match 'multiprocessing-fork' -and $ids -notcontains $_.ParentProcessId) }); foreach($x in $t){ taskkill /F /T /PID $x.ProcessId 2>$null | Out-Null }; Start-Sleep -Milliseconds 300" >nul 2>nul

set "PORT="
for /l %%P in (17321,1,17341) do (
    "!PY_EXE!" -c "import socket,sys; s=socket.socket(); s.bind(('0.0.0.0', %%P)); s.close(); sys.exit(0)" >nul 2>nul
    if not errorlevel 1 (
        set "PORT=%%P"
        goto :port_ok
    )
)

:: 首选窗口 17321-17341 全被占满时的兜底：交给系统分配一个空闲端口，保证仍能启动。
:: 写法与上面的探测一致（只调 python，不用 for /f 套反引号），失败就退回下面的错误提示。
if defined PORT goto :port_ok
"!PY_EXE!" -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()" > "%TEMP%\knoworigin_free_port.tmp" 2>nul
set /p PORT=<"%TEMP%\knoworigin_free_port.tmp"
del /q "%TEMP%\knoworigin_free_port.tmp" >nul 2>nul
if defined PORT goto :port_ok

echo.
echo   [错误] 17321-17341 端口均被占用，请关闭其他知源实例后重试。
echo.
pause
exit /b 1

:port_ok
echo        使用端口 !PORT!

:: 写入本机与局域网访问地址，便于手机同 Wi-Fi 访问
(
    echo 知源 KnowOrigin 访问地址
    echo.
    echo 本机：      http://127.0.0.1:!PORT!/
    echo.
    echo 同 Wi-Fi（手机 / 平板）：
) > "%URL_FILE%"
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } ^| Sort-Object InterfaceMetric ^| ForEach-Object { $_.IPAddress }" 2^>nul`) do (
    echo http://%%I:!PORT!/ >> "%URL_FILE%"
)

:: ==========================================================================
:: 日志文件占用自检
:: ==========================================================================
:: 上一轮残留的进程会把日志文件句柄一起继承走（见上面的清场说明），一旦句柄没释放，
:: 下面第 [5/5] 步的 1> / 2> 重定向就会失败，而且 cmd 会直接终止脚本——服务根本没启动，
:: 用户只看到一句「另一个程序正在使用此文件」。所以先删一次探路：删得掉说明没人占用，
:: 删不掉就改用带端口号的日志名，宁可换个文件名，也不让整条启动流程卡在这里。
del /q "%STDOUT_LOG%" "%STDERR_LOG%" >nul 2>nul
if not exist "%STDOUT_LOG%" if not exist "%STDERR_LOG%" goto :log_ok
set "STDOUT_LOG=%LOG_DIR%\knoworigin-server-!PORT!.out.log"
set "STDERR_LOG=%LOG_DIR%\knoworigin-server-!PORT!.err.log"
echo         原日志文件仍被其他程序占用，本次日志写入 knoworigin-server-!PORT!.out.log
:log_ok

:: ==========================================================================
:: [5/5] 启动服务
:: ==========================================================================
echo   [5/5] 启动服务 ...
echo.
echo     ┌──────────────────────────────────────────────┐
echo     │  本机访问：  http://127.0.0.1:!PORT!/
echo     │  停止服务：  在本窗口按 Ctrl+C
echo     └──────────────────────────────────────────────┘
echo.

:: 轮询等服务器真正就绪再打开浏览器。原先固定 sleep 3 秒：首次启动要 import 一堆重依赖
:: （fitz / onnxruntime / trafilatura 等），3 秒内端口往往还没监听，浏览器直接拿到
:: "无法访问此网站"，用户得手动刷新一次才看得到登录页。这里改成探测 /api/health，
:: 最多等 90 秒；即便超时也照样打开，至少让用户看到地址而不是干等。
start /b "" powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=(Get-Date).AddSeconds(90); while((Get-Date) -lt $d){ try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:!PORT!/api/health').StatusCode -eq 200){ break } } catch { Start-Sleep -Milliseconds 400 } }; $u='http://127.0.0.1:!PORT!/?boot='+[DateTimeOffset]::Now.ToUnixTimeMilliseconds(); Start-Process $u"

:: 前台运行，Ctrl+C 可直接停止
:: --reload：改完 api_server.py / core 下的代码自动重载，不必手动停服务再启动
"!PY_EXE!" -m uvicorn api_server:app --app-dir "%PROJECT_ROOT%src" --reload-dir "%PROJECT_ROOT%src" --host 0.0.0.0 --port !PORT! --reload 1>"%STDOUT_LOG%" 2>"%STDERR_LOG%"

echo.
echo   服务已停止。若启动异常，请查看日志：
echo     %STDERR_LOG%
echo.
pause
exit /b 0
