from __future__ import annotations

from dataclasses import dataclass

from .config.settings import Settings
from .services.ai_service import AiService
from .services.settings_store import SettingsStore
from .services.usage_ledger import UsageLedger


@dataclass
class Container:
    settings: Settings
    store: SettingsStore
    ledger: UsageLedger
    service: AiService
