"""缓存层体检（Service Worker 已退役，校验的是「退役得干净 + ?v= 没过期」）。

2026-10-04 前后，Service Worker 从「预缓存壳 + CACHE_NAME 手动升版」改成了
**彻底退役**：
  - `static/service-worker.js` 变成 shim —— activate 时删掉所有 `knoworigin-*` 缓存、
    `unregister()` 自己、然后让所有客户端 `navigate` 一次（强制走网络）；
  - `index.html` 里不再 `register()`，而是 load 时把历史注册全部 `unregister()` +
    清空 CacheStorage，若曾被 SW 控制过就 reload 一次。

所以现在唯一的缓存层是浏览器 HTTP 缓存，`?v=` 才是唯一的失效手段。
本脚本守三件事：
  1. 退役干净：没有再注册、shim 会清缓存并注销自己、不再有预缓存清单；
  2. index.html 引用的 static 文件都真实存在（预缓存时代靠 SHELL_ASSETS 兜底，
     现在没有兜底了，引用错就是直接 404）；
  3. 动过的关键静态文件，其 `?v=` 不旧于文件 mtime —— 这是现在唯一的缓存失效闸门。
"""
import io
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = io.open(ROOT / "static" / "index.html", encoding="utf-8").read()
sw = io.open(ROOT / "static" / "service-worker.js", encoding="utf-8").read()

FAILS = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


# ---- 1) 退役干净，别又注册回来 ----
check("index.html 不再注册 Service Worker", "serviceWorker.register" not in html)
check("index.html 会注销历史注册", "getRegistrations" in html and "unregister()" in html)
check("index.html 会清空 CacheStorage", "caches.delete" in html)
check("shim 会跳过等待接管", "skipWaiting" in sw)
check("shim 会注销自己", "unregister()" in sw)
check("shim 会清 knoworigin-* 缓存", "knoworigin-shell-" in sw and "caches.delete" in sw)
check("shim 会让客户端重新导航", ".navigate(" in sw)
# 预缓存清单若复活，verify 脚本和实际行为就对不上了；这里明确要求它不存在
check("没有残留预缓存清单", "SHELL_ASSETS" not in sw and "caches.open" not in sw)
check("没有残留 CACHE_NAME", not re.search(r'CACHE_NAME\s*=', sw))

# ---- 2) index.html 引用的 static 文件都得在磁盘上 ----
refs = re.findall(r'(?:src|href)="/static/([^"?]+)(?:\?v=[^"]*)?"', html)
missing_on_disk = sorted({name for name in refs if not (ROOT / "static" / name).exists()})
check("index.html 引用的 static 文件都存在", not missing_on_disk, str(missing_on_disk[:5]))
# agent 工作台的两个文件最容易漏（后加的），单独点名
for must in ("agent-layout.css", "agent-shell.js"):
    check(f"{must} 被 index.html 引用", must in refs)

# ---- 3) ?v= 不能旧于文件 mtime ----
# 没有 SW 之后，?v= 是唯一的失效手段：文件改了而 ?v= 没动，浏览器会继续用旧副本。
TOUCHED = {
    "index.html", "styles.css", "app.js", "agent-layout.css", "agent-shell.js",
    "service-worker.js",
}
stale = []
for name in sorted(set(refs) & TOUCHED):
    path = ROOT / "static" / name
    if not path.exists():
        continue
    found = re.search(re.escape(name) + r"\?v=([a-z0-9\-]+)", html)
    if not found:
        continue
    dates = re.findall(r"(20\d{6})", found.group(1))
    if not dates:
        # 非日期戳（人写的语义版本）不做 mtime 比较，但要求同一文件只有一个戳
        stamps = re.findall(re.escape(name) + r"\?v=([a-z0-9\-]+)", html)
        if len(set(stamps)) > 1:
            stale.append(f"{name} 出现多个不同 ?v= 戳：{sorted(set(stamps))}")
        continue
    mtime = datetime.fromtimestamp(path.stat().st_mtime)
    if mtime.strftime("%Y%m%d") > dates[-1]:
        stale.append(f"{name} (?v={found.group(1)}, 文件 mtime {mtime:%Y-%m-%d})")
check("动过的关键静态文件 ?v= 不陈旧", not stale, "; ".join(stale[:4]))

print()
if FAILS:
    print(f"失败 {len(FAILS)} 项：{FAILS}")
    print("提示：Service Worker 已退役，本脚本不再校验 CACHE_NAME / SHELL_ASSETS，只校验退役状态与 ?v=。")
    raise SystemExit(1)
print("缓存层体检通过（SW 已退役，?v= 是唯一失效手段）")
