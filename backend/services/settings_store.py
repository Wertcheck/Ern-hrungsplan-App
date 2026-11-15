"""Nicht-geheime Nutzereinstellungen (data_dir/ai_settings.json)."""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, ValidationError

from ..errors import ApiError

ProviderName = Literal["openai", "anthropic", "mock"]
FallbackName = Literal["openai", "anthropic"]
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\-]{0,99}$")


def _model_id(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        if not v:
            return None
        if not _MODEL_RE.match(v):
            raise ValueError("Ungueltige Modell-ID")
        return v
    raise ValueError("Modell-ID muss ein String sein")


ModelId = Annotated[str | None, BeforeValidator(_model_id)]


class ModelsSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    openai: ModelId = None
    anthropic: ModelId = None


class AiSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    provider: ProviderName = "anthropic"
    models: ModelsSetting = Field(default_factory=ModelsSetting)
    temperature: float | None = Field(None, ge=0, le=2)
    max_output_tokens: int = Field(1024, ge=64)
    history_messages: int = Field(12, ge=2)
    monthly_limit_usd: float | None = Field(None, ge=0)
    block_on_limit: bool = True
    fallback_provider: FallbackName | None = None
    auto_fallback: bool = False


class ModelsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    openai: ModelId = None
    anthropic: ModelId = None


class AiSettingsUpdate(BaseModel):
    """Teil-Update: nur gesetzte Felder werden uebernommen."""

    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    provider: ProviderName | None = None
    models: ModelsUpdate | None = None
    temperature: float | None = Field(None, ge=0, le=2)
    max_output_tokens: int | None = Field(None, ge=64)
    history_messages: int | None = Field(None, ge=2)
    monthly_limit_usd: float | None = Field(None, ge=0)
    block_on_limit: bool | None = None
    fallback_provider: FallbackName | None = None
    auto_fallback: bool | None = None


_NOT_NULLABLE = {"enabled", "provider", "models", "max_output_tokens", "history_messages", "block_on_limit", "auto_fallback"}


class SettingsStore:
    def __init__(self, data_dir: Path, max_output_cap: int, history_cap: int):
        self.path = Path(data_dir) / "ai_settings.json"
        self.max_output_cap = max_output_cap
        self.history_cap = history_cap
        self._lock = threading.Lock()

    def _clamp(self, s: AiSettings) -> AiSettings:
        s.max_output_tokens = min(s.max_output_tokens, self.max_output_cap)
        s.history_messages = min(s.history_messages, self.history_cap)
        return s

    def load(self) -> AiSettings:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return self._clamp(AiSettings.model_validate(data))
        except (OSError, ValueError, ValidationError):
            return AiSettings()

    def update(self, patch: AiSettingsUpdate) -> AiSettings:
        with self._lock:
            changes = patch.model_dump(exclude_unset=True)
            bad = [k for k in changes if changes[k] is None and k in _NOT_NULLABLE]
            if bad:
                raise ApiError(422, "validation_error", f"Feld(er) duerfen nicht null sein: {', '.join(bad)}")
            merged = self.load().model_dump()
            if "models" in changes:
                merged["models"] = {**merged["models"], **patch.models.model_dump(exclude_unset=True)}
                changes.pop("models")
            merged.update(changes)
            try:
                new = AiSettings.model_validate(merged)
            except ValidationError as e:
                raise ApiError(422, "validation_error", "Ungueltige Einstellungen: " + "; ".join(
                    f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors(include_input=False, include_url=False))) from None
            if new.max_output_tokens > self.max_output_cap:
                raise ApiError(422, "validation_error", f"max_output_tokens darf hoechstens {self.max_output_cap} sein")
            if new.history_messages > self.history_cap:
                raise ApiError(422, "validation_error", f"history_messages darf hoechstens {self.history_cap} sein")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(new.model_dump_json(indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
            return new
