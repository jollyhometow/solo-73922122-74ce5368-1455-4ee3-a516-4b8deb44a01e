"""日志脱敏：把敏感字段替换成标签占位符。"""
from __future__ import annotations

import re

# 顺序敏感：邮箱先于 IP 处理，避免邮箱中的数字被误判。
_PATTERNS = [
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    (re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]+"), "Bearer [TOKEN]"),
    (re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)"), "[IPv4]"),
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "[PHONE]"),
    (re.compile(r"(?<![A-Za-z0-9])[a-fA-F0-9]{32,}(?![A-Za-z0-9])"), "[HEX]"),
]


def redact(text: str) -> str:
    """对单条日志文本做脱敏。"""
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out
