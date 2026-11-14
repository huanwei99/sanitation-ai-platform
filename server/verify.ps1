# verify.ps1 — DR-T01/T02 实机验证脚本
# 用途:一条命令跑通服务骨架 + 数据层的启动/测试/探活。
# 用法(在仓库根目录的 server 子目录下执行):
#   powershell -ExecutionPolicy Bypass -File verify.ps1
# 可选参数:
#   -SkipInstall   跳过 npm install(已装依赖时加速)
#   -SkipService   只跑测试,不起服务/探活

param(
  [switch]$SkipInstall,
  [switch]$SkipService
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Write-Step($msg)  { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Bad($msg)   { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

# ---------- 0. 前置检查 ----------
Write-Step "0. 前置检查"

# 0.1 Node 版本(node:sqlite 需 >= 22.5.0)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Bad "未找到 node。请先安装 Node.js(推荐 LTS 22.x): https://nodejs.org"
  exit 1
}
$nodeVer = (& node -v) -replace '^v',''
$nodeParts = $nodeVer.Split('.')
$nodeOk = ([int]$nodeParts[0] -gt 22) -or ([int]$nodeParts[0] -eq 22 -and [int]$nodeParts[1] -ge 5)
Write-Ok "node v$nodeVer"
if ($nodeOk) {
  Write-Ok "Node >= 22.5 → 将使用内置 node:sqlite(零编译)"
} else {
  Write-Host "  [WARN] Node < 22.5 → 无 node:sqlite,将回退 better-sqlite3(需编译)" -ForegroundColor Yellow
}

# 0.2 npm
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Write-Bad "未找到 npm。"; exit 1 }
Write-Ok "npm $(& npm -v)"

# ---------- 1. 安装依赖 ----------
if (-not $SkipInstall) {
  Write-Step "1. npm install(纯 JS;仅 Node<22.5 才会装/编译 better-sqlite3)"
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Bad "npm install 失败。若 better-sqlite3 编译报错,升级到 Node 22.5+ 可彻底规避。"
    exit 1
  }
  Write-Ok "依赖安装完成"
} else {
  Write-Step "1. 跳过 npm install(-SkipInstall)"
}

# ---------- 2. 跑数据层测试(DR-T02) ----------
Write-Step "2. 数据层测试:node --test db.test.js"
& node --test db.test.js
if ($LASTEXITCODE -ne 0) { Write-Bad "数据层测试未通过"; exit 1 }
Write-Ok "数据层测试通过(空库迁移 + 重启保留 + 幂等)"

# ---------- 2b. 跑内存版验收测试(A-T1..A-T13) ----------
Write-Step "2b. 内存版验收测试:foundation/tests engine.test.js"
Push-Location (Join-Path $here "..\foundation\tests")
& node --test engine.test.js
$engineExit = $LASTEXITCODE
Pop-Location
if ($engineExit -ne 0) { Write-Bad "内存版验收测试未通过"; exit 1 }
Write-Ok "内存版 A-T1..A-T13 通过"

# ---------- 3. 起 Fastify 并探活 /healthz ----------
if (-not $SkipService) {
  Write-Step "3. 启动 Fastify(:8791)并探活 /healthz"
  $proc = Start-Process -FilePath "node" -ArgumentList "server.js" `
            -PassThru -NoNewWindow `
            -RedirectStandardOutput "server.out.log" -RedirectStandardError "server.err.log"
  try {
    # 轮询最多 ~10 秒
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8791/healthz" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ok = $true; break }
      } catch { }
    }
    if (-not $ok) {
      Write-Bad "/healthz 未在 10s 内返回 200。查看 server.err.log:"
      if (Test-Path "server.err.log") { Get-Content "server.err.log" | Select-Object -First 30 }
      exit 1
    }
    Write-Ok "/healthz → 200"
    $body = $resp.Content
    Write-Host "  响应体: $body"
    if ($body -match '"db"\s*:\s*"ready"') {
      Write-Ok "数据库已就绪(db: ready)"
    } else {
      Write-Host "  [WARN] db 未 ready,检查上方响应体" -ForegroundColor Yellow
    }
    Write-Ok "DR-T01(/healthz 200) + DR-T02(数据层) 验证通过"
    Write-Host "`n说明:Caddy 同源反代属可选,需另装 Caddy 后执行 'caddy run --config Caddyfile'(监听 :8790)。" -ForegroundColor DarkGray
  } finally {
    if ($proc -and -not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force
      Write-Host "`n已停止 Fastify 进程(PID $($proc.Id))。" -ForegroundColor DarkGray
    }
    foreach ($f in @("server.out.log","server.err.log")) {
      if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    }
  }
} else {
  Write-Step "3. 跳过服务启动(-SkipService)"
}

Write-Host "`n全部完成。" -ForegroundColor Green
