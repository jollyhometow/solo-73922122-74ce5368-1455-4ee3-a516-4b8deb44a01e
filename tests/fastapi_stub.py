"""测试用 FastAPI / Pydantic 最小桩：仅覆盖 main.py 实际用到的接口。"""
import json


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class JSONResponse:
    def __init__(self, content, status_code=200):
        self.body = json.dumps(content).encode()
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}


class FileResponse:
    def __init__(self, path, status_code=200):
        self.path = path
        self.status_code = status_code
        self.headers = {}


class StaticFiles:
    def __init__(self, directory, html=False):
        self.directory = directory
        self.html = html


class FastAPI:
    def __init__(self, title="", version=""):
        self.title = title
        self.version = version
        self.middlewares = []
        self.exception_handlers = {}

    def middleware(self, _kind):
        def deco(fn):
            self.middlewares.append(fn)
            return fn
        return deco

    def get(self, _path, include_in_schema=True):
        def deco(fn):
            return fn
        return deco

    def post(self, _path, include_in_schema=True):
        def deco(fn):
            return fn
        return deco

    def mount(self, _path, _app, name=None):
        return None

    def exception_handler(self, code):
        def deco(fn):
            self.exception_handlers[code] = fn
            return fn
        return deco


class FieldInfo:
    def __init__(self, default=..., min_length=None, max_length=None):
        self.default = default
        self.min_length = min_length
        self.max_length = max_length


def Field(default=..., min_length=None, max_length=None):  # noqa: N802
    return FieldInfo(default, min_length=min_length, max_length=max_length)


class BaseModel:
    """简化版模型：按注解做类型/长度校验，非法输入抛 HTTPException(422) 风格错误。"""

    def __init__(self, **kwargs):
        for name, annotation in getattr(self, "__annotations__", {}).items():
            if name not in kwargs:
                raise HTTPException(422, f"missing field: {name}")
            value = kwargs[name]
            info = getattr(type(self), name, None)
            if isinstance(info, FieldInfo):
                if info.min_length is not None and len(value) < info.min_length:
                    raise HTTPException(422, f"{name} too short")
                if info.max_length is not None and len(value) > info.max_length:
                    raise HTTPException(422, f"{name} too long")
            if annotation is str and not isinstance(value, str):
                raise HTTPException(422, f"{name} must be string")
            setattr(self, name, value)


class Header:
    def __init__(self, default=None):
        self.default = default


def Header_(default=None):  # noqa: N802
    return Header(default)