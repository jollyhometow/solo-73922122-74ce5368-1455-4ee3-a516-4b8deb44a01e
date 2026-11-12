"""两台演示设备及其原始日志（含敏感字段，取数时由后端脱敏）。"""
from __future__ import annotations

from typing import Any

# 每台设备 24 条日志，接口只返回最近 20 条，便于演示截断。
DEVICES: dict[str, dict[str, Any]] = {
    "dev-gw-01": {
        "id": "dev-gw-01",
        "name": "边缘网关 GW-01（机房 A）",
        "model": "EdgeGateway X100",
        "logs": [
            "2026-11-12 08:00:01 INFO  systemd: 系统启动完成，内核版本 5.15.0",
            "2026-11-12 08:00:05 INFO  net: eth0 获取地址 10.12.8.21/24，网关 10.12.8.1",
            "2026-11-12 08:00:09 INFO  ntp: 已与 192.168.1.10 时间同步，偏差 4ms",
            "2026-11-12 08:05:12 INFO  sensor: 温度传感器自检通过 26.3C",
            "2026-11-12 08:10:44 INFO  vpn: 对端 203.0.113.77 建立 IPSec 隧道",
            "2026-11-12 08:21:03 WARN  auth: 管理员 admin 登录失败（来源 10.12.8.99）",
            "2026-11-12 08:21:31 INFO  auth: 管理员 admin 登录成功（来源 10.12.8.99）",
            "2026-11-12 08:35:18 INFO  modbus: 采集设备 192.168.4.12 寄存器成功",
            "2026-11-12 08:47:02 WARN  mqtt: 连接 broker 198.51.100.23 重试 1 次后恢复",
            "2026-11-12 09:02:55 INFO  ops: 技术支持 zhang.wei@vendor.example.com 建立远程会话",
            "2026-11-12 09:03:41 INFO  ops: 执行诊断命令 diag --channel 3，返回 0",
            "2026-11-12 09:15:20 ERROR modem: 拨号失败，APN 配置被重置为默认值",
            "2026-11-12 09:16:02 INFO  modem: 重新拨号成功，地址 100.64.7.33",
            "2026-11-12 09:30:11 WARN  cert: 与 203.0.113.77 的证书剩余 12 天到期",
            "2026-11-12 09:44:27 INFO  firewall: 放行端口 8443 给维护终端 10.12.8.55",
            "2026-11-12 10:02:09 ERROR sensor: 温度读数 78.9C 超过阈值 75.0C",
            "2026-11-12 10:02:12 INFO  alarm: 已向值班员 13800138000 推送高温告警",
            "2026-11-12 10:08:40 INFO  sensor: 温度恢复至 51.2C，告警解除",
            "2026-11-12 10:20:15 INFO  api: GET /api/v1/status 来自 192.168.4.200 200",
            "2026-11-12 10:35:51 INFO  api: POST /api/v1/upgrade 来自 10.12.8.99 202",
            "2026-11-12 10:36:02 INFO  ota: 下载固件 https://ota.example.com/fw/x100-2.4.1.bin",
            "2026-11-12 10:41:18 INFO  ota: 固件校验 sha256=9f2c7e4a1b8d6053c4e7f921a6b3d8e0f5c7294ab6d1e3f8072c9a4b6d1e5f80",
            "2026-11-12 10:52:33 INFO  notify: 巡检报告已发送至 ops-center@factory.example.cn",
            "2026-11-12 11:00:00 INFO  rotate: 日志轮转完成，归档 12 个分段",
        ],
    },
    "dev-pump-02": {
        "id": "dev-pump-02",
        "name": "泵房控制器 PUMP-02（厂区 B）",
        "model": "PumpCtrl P2000",
        "logs": [
            "2026-11-12 07:30:02 INFO  boot: 控制器上电自检，固件 4.2.0",
            "2026-11-12 07:30:07 INFO  io: 数字量输入 DI0-DI7 状态正常",
            "2026-11-12 07:30:11 INFO  net: 接入工业交换机，IP 172.16.20.42/24",
            "2026-11-12 07:31:00 INFO  pump: 1# 泵启动，设定压力 0.65MPa",
            "2026-11-12 07:45:18 INFO  pump: 出口压力稳定 0.64MPa，流量 82m3/h",
            "2026-11-12 08:02:44 WARN  vib: 2# 泵振动值 4.8mm/s 接近预警线",
            "2026-11-12 08:15:09 INFO  scada: 向 172.16.20.10 上报遥测数据成功",
            "2026-11-12 08:30:31 INFO  auth: 巡检账号 inspector 登录（172.16.20.88）",
            "2026-11-12 08:41:57 ERROR comm: 与从站 172.16.21.15 Modbus 超时",
            "2026-11-12 08:42:09 INFO  comm: 从站 172.16.21.15 恢复，丢包 3 帧",
            "2026-11-12 09:05:22 INFO  ota: 检查更新 https://ota.example.com/fw/p2000-4.2.1.bin",
            "2026-11-12 09:11:48 INFO  ota: 校验通过 a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            "2026-11-12 09:12:03 INFO  ota: 升级完成，等待下次重启生效",
            "2026-11-12 09:25:36 WARN  temp: 电机绕组温度 91.2C（预警 90C）",
            "2026-11-12 09:26:40 INFO  alarm: 通知维保联系人 13911112222",
            "2026-11-12 09:40:12 INFO  pump: 2# 泵按计划切换为备用",
            "2026-11-12 09:55:47 ERROR seal: 3# 泵机械密封泄漏开关动作",
            "2026-11-12 09:56:02 INFO  alarm: 泄漏告警推送至 maintenance@plant.example.net",
            "2026-11-12 10:10:18 INFO  pump: 3# 泵停机，进出口阀自动关闭",
            "2026-11-12 10:25:51 INFO  ops: 厂商工程师 li.gong@vendor.example.com 远程接入",
            "2026-11-12 10:26:33 INFO  auth: 临时令牌签发 Bearer tk_live_9f2e8d1c7b6a59483726150493827160afedcba9",
            "2026-11-12 10:48:20 INFO  auth: 临时令牌已轮换，旧令牌失效",
            "2026-11-12 10:55:09 INFO  vib: 2# 泵振动回落至 2.1mm/s，预警解除",
            "2026-11-12 11:00:01 INFO  report: 日报已抄送 duty-room@plant.example.net 与 172.16.20.10",
        ],
    },
}


def list_devices() -> list[dict[str, str]]:
    return [
        {"id": d["id"], "name": d["name"], "model": d["model"]}
        for d in DEVICES.values()
    ]


def get_device(device_id: str) -> dict[str, Any] | None:
    return DEVICES.get(device_id)
