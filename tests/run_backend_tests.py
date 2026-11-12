"""
后端安全语义测试（纯标准库 + fastapi_stub，无需安装第三方包）。

运行：python3 -I tests/run_backend_tests.py
覆盖：
1. 脱敏正则（IP/邮箱/手机号/令牌/十六进制摘要）
2. 设备数据与“最近 20 条”截断
3. 固定 origin 校验（批准接口）
4. 一次性令牌：签发、成功消费、复用/伪造/错设备均失败
5. 角色隔离：vendor/rogue 不提供任何 API
6. 延迟上限钳制
7. 取数结果确为脱敏文本、条数正确
"""
import asyncio
import importlib
import os
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "app"))

import fastapi_stub  # noqa: E402

# 在导入 main 之前装好桩包。
fake_pkg = types.ModuleType("fastapi")
for name in dir(fastapi_stub):
    if not name.startswith("_"):
        setattr(fake_pkg, name, getattr(fastapi_stub, name))
sys.modules["fastapi"] = fake_pkg

responses_pkg = types.ModuleType("fastapi.responses")
responses_pkg.FileResponse = fastapi_stub.FileResponse
responses_pkg.JSONResponse = fastapi_stub.JSONResponse
sys.modules["fastapi.responses"] = responses_pkg
fake_pkg.responses = responses_pkg

staticfiles_pkg = types.ModuleType("fastapi.staticfiles")
staticfiles_pkg.StaticFiles = fastapi_stub.StaticFiles
sys.modules["fastapi.staticfiles"] = staticfiles_pkg
fake_pkg.staticfiles = staticfiles_pkg

pydantic_pkg = types.ModuleType("pydantic")
pydantic_pkg.BaseModel = fastapi_stub.BaseModel
pydantic_pkg.Field = fastapi_stub.Field
sys.modules["pydantic"] = pydantic_pkg

from fastapi_stub import HTTPException, JSONResponse  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def load_main(role):
    os.environ["APP_ROLE"] = role
    os.environ["SELF_ORIGIN"] = f"http://localhost:808{ {'portal': 0, 'vendor': 1, 'rogue': 2}[role] }"
    os.environ["PORTAL_ORIGIN"] = "http://localhost:8080"
    os.environ["VENDOR_ORIGIN"] = "http://localhost:8081"
    for mod in ("main", "devices", "redact"):
        sys.modules.pop(mod, None)
    return importlib.import_module("main")


def run(coro):
    return asyncio.run(coro)


def test_redaction():
    print("[1] 脱敏正则")
    redact = importlib.import_module("redact")
    importlib.reload(redact)
    cases = [
        ("地址 192.168.1.10 已同步", "地址 [IPv4] 已同步"),
        ("联系 zhang.wei@vendor.example.com 处理", "联系 [EMAIL] 处理"),
        ("告警短信 13800138000 已发送", "告警短信 [PHONE] 已发送"),
        ("Bearer tk_live_9f2e8d1c7b6a 已签发", "Bearer [TOKEN] 已签发"),
        ("sha256=9f2c7e4a1b8d6053c4e7f921a6b3d8e0f5c7294ab6d1e3f8072c9a4b6d1e5f80",
         "sha256=[HEX]"),
        ("普通中文与版本号 5.15.0 不应误伤", "普通中文与版本号 5.15.0 不应误伤"),
    ]
    for raw, expected in cases:
        got = redact.redact(raw)
        check(f"redact({raw[:24]}...)", got == expected, f"got={got!r}")


def test_devices():
    print("[2] 设备数据")
    devices = importlib.import_module("devices")
    importlib.reload(devices)
    listed = devices.list_devices()
    check("两台设备", len(listed) == 2)
    ids = {d["id"] for d in listed}
    check("设备 ID 正确", ids == {"dev-gw-01", "dev-pump-02"})
    for dev_id in ids:
        dev = devices.get_device(dev_id)
        check(f"{dev_id} 原始日志 >=20 条", len(dev["logs"]) >= 20)
    check("未知设备返回 None", devices.get_device("nope") is None)


def test_portal_role():
    print("[3] 门户角色：origin 校验 + 一次性令牌 + 取数")
    main = load_main("portal")

    # 3.1 非白名单 origin 不能批准
    try:
        run(main.approve(main.ApproveBody(deviceId="dev-gw-01"), origin="http://evil.example"))
        check("非白名单 origin 批准被拒", False, "未抛异常")
    except HTTPException as exc:
        check("非白名单 origin 批准被拒", exc.status_code == 403)

    # 缺少 Origin 头同样拒绝
    try:
        run(main.approve(main.ApproveBody(deviceId="dev-gw-01"), origin=None))
        check("缺失 Origin 批准被拒", False, "未抛异常")
    except HTTPException as exc:
        check("缺失 Origin 批准被拒", exc.status_code == 403)

    # 3.2 合法批准签发令牌
    resp = run(main.approve(main.ApproveBody(deviceId="dev-gw-01"), origin="http://localhost:8080"))
    check("批准返回 JSONResponse", isinstance(resp, JSONResponse))
    import json
    token = json.loads(resp.body)["token"]
    check("令牌为非空字符串", isinstance(token, str) and len(token) > 20)

    # 3.3 未知设备不能批准
    try:
        run(main.approve(main.ApproveBody(deviceId="dev-xxx"), origin="http://localhost:8080"))
        check("未知设备批准 404", False, "未抛异常")
    except HTTPException as exc:
        check("未知设备批准 404", exc.status_code == 404)

    # 3.4 伪造令牌取数失败
    try:
        run(main.logs(deviceId="dev-gw-01", token="forged", delay=0))
        check("伪造令牌被拒", False, "未抛异常")
    except HTTPException as exc:
        check("伪造令牌被拒", exc.status_code == 403)

    # 3.5 正常取数：20 条、已脱敏、含占位符
    resp = run(main.logs(deviceId="dev-gw-01", token=token, delay=0))
    payload = json.loads(resp.body)
    check("返回 20 条", payload["count"] == 20 and len(payload["entries"]) == 20)
    joined = "\n".join(payload["entries"])
    check("日志已脱敏（无原始 IP）", "192.168.1.10" not in joined and "[IPv4]" in joined)
    check("邮箱被脱敏", "[EMAIL]" in joined)
    check("手机号被脱敏", "[PHONE]" in joined)
    check("设备 ID 回显一致", payload["deviceId"] == "dev-gw-01")

    # 3.6 同一令牌复用必须失败（一次性）
    try:
        run(main.logs(deviceId="dev-gw-01", token=token, delay=0))
        check("令牌复用被拒", False, "未抛异常")
    except HTTPException as exc:
        check("令牌复用被拒", exc.status_code == 403)

    # 3.7 令牌与设备绑定：A 设备令牌不能取 B 设备
    token_a = json.loads(
        run(main.approve(main.ApproveBody(deviceId="dev-gw-01"), origin="http://localhost:8080")).body
    )["token"]
    try:
        run(main.logs(deviceId="dev-pump-02", token=token_a, delay=0))
        check("跨设备使用令牌被拒", False, "未抛异常")
    except HTTPException as exc:
        check("跨设备使用令牌被拒", exc.status_code == 403)
    # 被拒后令牌也已消费，再用于原设备同样失败
    try:
        run(main.logs(deviceId="dev-gw-01", token=token_a, delay=0))
        check("失败消费后令牌不可再用", False, "未抛异常")
    except HTTPException as exc:
        check("失败消费后令牌不可再用", exc.status_code == 403)

    # 3.8 延迟钳制：负值/超大值不报错且不实际长时间睡眠
    token_b = json.loads(
        run(main.approve(main.ApproveBody(deviceId="dev-pump-02"), origin="http://localhost:8080")).body
    )["token"]
    resp = run(main.logs(deviceId="dev-pump-02", token=token_b, delay=999))
    payload = json.loads(resp.body)
    check("超大延迟被钳制且仍返回 20 条", payload["count"] == 20)

    token_c = json.loads(
        run(main.approve(main.ApproveBody(deviceId="dev-pump-02"), origin="http://localhost:8080")).body
    )["token"]
    resp = run(main.logs(deviceId="dev-pump-02", token=token_c, delay=-5))
    check("负延迟被钳制为 0 且正常返回", json.loads(resp.body)["count"] == 20)

    # 3.9 设备列表接口仅门户可用
    resp = run(main.devices())
    check("门户设备列表 2 台", len(json.loads(resp.body)["devices"]) == 2)

    # 3.10 配置接口各角色都有（直接返回 dict，真实 FastAPI 负责序列化）
    cfg = run(main.config())
    check("配置回显角色", cfg["role"] == "portal")


def test_other_roles():
    print("[4] 厂商/未获准角色：API 全部关闭")
    for role in ("vendor", "rogue"):
        main = load_main(role)
        for name, coro in [
            ("devices", main.devices()),
            ("logs", main.logs("dev-gw-01", "whatever", 0)),
        ]:
            try:
                run(coro)
                check(f"{role} 关闭 /api/{name}", False, "未抛异常")
            except HTTPException as exc:
                check(f"{role} 关闭 /api/{name}", exc.status_code == 404)
        try:
            run(main.approve(main.ApproveBody(deviceId="dev-gw-01"), origin="http://localhost:8080"))
            check(f"{role} 关闭 /api/approve", False, "未抛异常")
        except HTTPException as exc:
            check(f"{role} 关闭 /api/approve", exc.status_code == 404)
        import json as _json
        check(f"{role} 配置角色正确", run(main.config())["role"] == role)
        check(f"{role} 健康检查", run(main.healthz())["status"] == "ok")


def main_entry():
    test_redaction()
    test_devices()
    test_portal_role()
    test_other_roles()
    print(f"\n结果：{PASS} 通过 / {FAIL} 失败")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main_entry()
