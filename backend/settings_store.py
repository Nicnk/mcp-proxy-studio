import asyncio
import json
from pathlib import Path
from typing import Optional

from pydantic import BaseModel


class Settings(BaseModel):
    host: str = "0.0.0.0"
    sse_port: int = 8002
    stream_port: int = 8001
    openapi_port: int = 8003
    inspector_public_host: str = "0.0.0.0"
    enable_analytics: bool = False


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path
        self.lock = asyncio.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(Settings().model_dump_json(indent=2), encoding="utf-8")

    async def get(self) -> Settings:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            settings = Settings(**raw)
            print("get", settings)
            print("get", self.path)
            # needs_upgrade = (
            #     settings.sse_port == 8002
            #     and settings.stream_port == 8001
            #     and settings.openapi_port == 8003
            # )
            # if needs_upgrade:
            #     settings = Settings()
            #     await self.set(settings)
            return settings
        except Exception:
            return Settings()

    async def set(self, settings: Settings) -> Settings:
        async with self.lock:
            print(settings)
            print(self.path)
            self.path.write_text(settings.model_dump_json(indent=2), encoding="utf-8")
        return settings
