"""Konfiguration (pydantic-settings). Liest backend/.env; Schluessel sind SecretStr."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent


def env_file_candidates() -> list[Path]:
    """Suchreihenfolge: $ENV_FILE, <Repo-Root>/.env, backend/.env (erste existierende gewinnt)."""
    cands: list[Path] = []
    explicit = os.environ.get("ENV_FILE", "").strip()
    if explicit:
        cands.append(Path(explicit).expanduser())
    cands += [REPO_ROOT / ".env", BACKEND_DIR / ".env"]
    return cands


def resolve_env_file() -> Path | None:
    for c in env_file_candidates():
        try:
            if c.is_file():
                return c
        except OSError:
            continue
    return None
DEFAULT_PRICING_PATH = Path(__file__).resolve().parent / "pricing.json"
DEFAULT_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]


def _a(name: str, plain: bool = False) -> AliasChoices:
    return AliasChoices(f"NUTRI_{name.upper()}", name.upper()) if plain else AliasChoices(f"NUTRI_{name.upper()}")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file_encoding="utf-8",
        extra="ignore",
        validate_by_name=True,
        validate_by_alias=True,
    )

    host: str = Field("127.0.0.1", validation_alias=_a("host"))
    port: int = Field(8787, validation_alias=_a("port"))
    allowed_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: list(DEFAULT_ORIGINS), validation_alias=_a("allowed_origins", True)
    )

    openai_api_key: SecretStr = Field(SecretStr(""), validation_alias=AliasChoices("OPENAI_API_KEY"))
    anthropic_api_key: SecretStr = Field(SecretStr(""), validation_alias=AliasChoices("ANTHROPIC_API_KEY"))
    openai_default_model: str = Field("", validation_alias=AliasChoices("OPENAI_DEFAULT_MODEL"))
    anthropic_default_model: str = Field("claude-opus-5-5", validation_alias=AliasChoices("ANTHROPIC_DEFAULT_MODEL"))

    request_timeout_s: float = Field(60.0, gt=0, validation_alias=_a("request_timeout_s"))
    rate_limit_per_min: int = Field(20, ge=0, validation_alias=_a("rate_limit_per_min"))
    max_body_bytes: int = Field(262144, gt=0, validation_alias=_a("max_body_bytes"))
    max_history_cap: int = Field(30, ge=2, validation_alias=_a("max_history_cap"))
    max_output_tokens_cap: int = Field(4096, ge=64, validation_alias=_a("max_output_tokens_cap"))
    data_dir: Path = Field(BACKEND_DIR / "data", validation_alias=_a("data_dir"))
    pricing_path: Path = Field(DEFAULT_PRICING_PATH, validation_alias=_a("pricing_path"))
    enable_mock_provider: bool = Field(False, validation_alias=_a("enable_mock_provider", True))

    def __init__(self, **kwargs):
        if "_env_file" not in kwargs:
            kwargs["_env_file"] = resolve_env_file()  # nie veraendert, nur gelesen
        super().__init__(**kwargs)

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, v):
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    # --- Hilfen (geben nie Schluesselteile aus) ---
    def has_key(self, provider: str) -> bool:
        if provider == "openai":
            return bool(self.openai_api_key.get_secret_value().strip())
        if provider == "anthropic":
            return bool(self.anthropic_api_key.get_secret_value().strip())
        return False

    def default_model(self, provider: str) -> str | None:
        if provider == "openai":
            return self.openai_default_model.strip() or None
        if provider == "anthropic":
            return self.anthropic_default_model.strip() or None
        if provider == "mock":
            return "mock-1"
        return None

    def secret_values(self) -> list[str]:
        return [self.openai_api_key.get_secret_value(), self.anthropic_api_key.get_secret_value()]
