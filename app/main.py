"""
三源演示台后端（单镜像、三容器，按 ROLE 区分身份）。

角色与源（docker compose）：
  portal  -> http://localhost:8080  值班门户：设备选择、人工批准、日志取数
  vendor  -> http://localhost:8081  获准厂商诊断页：只能经 postMessage 申请
  rogue   -> http://localhost:8082  未获准站点：固定 origin 之外的来源

关键边界：
- 日志接口 /api/logs 不接受任何浏览器直接调用，必须携带门户后端在人工
  批准后签发的一次性令牌；令牌与设备绑定，用后即焚。
- 后端对 /api/approve 做固定 origin 校验（纵深防御，前端也会校验）。
- 不返回任何 CORS 头，跨源 fetch 默认被浏览器拦截。
"""
from __future__ import annotations

import asyncio
import os
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from devices import get_device, list_devices
from redact import redact

ROLE = os.getenv("APP_ROLE", "portal").lower()
SELF_ORIGIN = os.getenv("SELF_ORIGIN", "http://localhost:8080")
PORTAL_ORIGIN = os.getenv("PORTAL_ORIGIN", "http://localhost:8080")
VENDOR_ORIGIN = os.getenv("VENDOR_ORIGIN", "http://localhost:8081")
ROGUE_ORIGIN = os.getenv("ROGUE_ORIGIN", "http://localhost:8082")
ALLOWED_APPROVER_ORIGINS = {PORTAL_ORIGIN}
MAX_FETCH_DELAY = 30.0

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static" / ROLE

app = FastAPI(title=f"日志授权演示台 - {ROLE}", version="1.0.0")


class _OneTimeTokenStore:
    """进程内一次性令牌存储（演示用，单 worker）。"""

    def __init__(self) -> None:
        self._tokens: dict[str, tuple[str, float]] = {}

    def mint(self, device_id: str) -> str:
        token = secrets.token_urlsafe(32)
        self._tokens[token] = (device_id, time.time())
        return token

    def consume(self, token: str, device_id: str) -> bool:
        record = self._tokens.pop(token, None)
        if record is None:
            return False
        bound_device, _ = record
        return bound_device == device_id


token_store = _OneTimeTokenStore()


@app.middleware("http")
async def security_headers(request, call_next):  # type: ignore[no-untyped-def]
    response = await call_next(request)
    # 只允许明确的源内嵌本页：
    # - portal：仅自身可嵌；frame-src 单独放开厂商源用于演示 iframe。
    # - vendor/rogue：只允许被门户嵌入（能否获得数据由门户的 origin+窗口+文档校验决定）。
    if ROLE == "portal":
        # frame-src 允许加载厂商页和未获准站点页（用于演示）；
        # 未获准站点能否获得数据由消息层固定 origin/窗口/文档校验拦截，而非靠禁止加载。
        csp = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            f"frame-src {VENDOR_ORIGIN} {ROGUE_ORIGIN}; connect-src 'self'; "
            "base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
        )
    else:
        csp = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            f"frame-ancestors {PORTAL_ORIGIN}; base-uri 'none'; form-action 'self'"
        )
    response.headers["Content-Security-Policy"] = csp
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    # 显式不设置 Access-Control-Allow-Origin：跨源 fetch 由浏览器拦截。
    # 嵌入策略统一由 CSP frame-ancestors 表达，避免与 X-Frame-Options 冲突。
    return response


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"role": ROLE, "origin": SELF_ORIGIN, "status": "ok"}


@app.get("/api/config")
async def config() -> dict[str, str]:
    """页面引导配置：告诉当前页面自己的源与门户/厂商/未获准站点源。"""
    return {
        "role": ROLE,
        "selfOrigin": SELF_ORIGIN,
        "portalOrigin": PORTAL_ORIGIN,
        "vendorOrigin": VENDOR_ORIGIN,
        "rogueOrigin": ROGUE_ORIGIN,
    }


class ApproveBody(BaseModel):
    deviceId: str = Field(min_length=1, max_length=64)


@app.post("/api/approve", include_in_schema=False)
async def approve(
    body: ApproveBody,
    origin: str | None = Header(default=None),
) -> JSONResponse:
    # 后端独立校验固定 origin，前端校验被绕过（同源旁窗等）时仍然拒绝。
    if ROLE != "portal":
        raise HTTPException(status_code=404, detail="not found")
    if origin not in ALLOWED_APPROVER_ORIGINS:
        raise HTTPException(status_code=403, detail="origin not allowed")
    if get_device(body.deviceId) is None:
        raise HTTPException(status_code=404, detail="unknown device")
    token = token_store.mint(body.deviceId)
    # 令牌只返回给门户主文档；厂商页面永远拿不到令牌。
    return JSONResponse({"token": token})


@app.get("/api/devices", include_in_schema=False)
async def devices() -> JSONResponse:
    if ROLE != "portal":
        raise HTTPException(status_code=404, detail="not found")
    return JSONResponse({"devices": list_devices()})


@app.get("/api/logs", include_in_schema=False)
async def logs(
    deviceId: str,
    token: str,
    delay: float = 0.0,
) -> JSONResponse:
    if ROLE != "portal":
        raise HTTPException(status_code=404, detail="not found")
    # 无论成败先消费，保证一枚令牌只能成功取数一次。
    if not token_store.consume(token, deviceId):
        raise HTTPException(status_code=403, detail="invalid or reused token")
    device = get_device(deviceId)
    if device is None:
        raise HTTPException(status_code=404, detail="unknown device")
    delay = max(0.0, min(delay, MAX_FETCH_DELAY))
    if delay:
        await asyncio.sleep(delay)
    recent = device["logs"][-20:]
    return JSONResponse(
        {
            "deviceId": deviceId,
            "count": len(recent),
            "entries": [redact(line) for line in recent],
        }
    )


# API 路由先注册，静态挂载兜底；404 时回退到各自角色的 index.html。
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


@app.exception_handler(404)
async def not_found(request, _exc):  # type: ignore[no-untyped-def]
    # API 路径保持 JSON 响应；页面路由回退到角色入口页（SPA 风格）。
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "not found"}, status_code=404)
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return JSONResponse({"detail": "not found"}, status_code=404)
