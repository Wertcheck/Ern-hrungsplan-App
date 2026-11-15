"""CLI: python -m backend.check_env [--live]

Zeigt, welche .env verwendet wird (nur Pfad), ob die Schluessel gesetzt sind
(nur 'gesetzt'/'fehlt' - nie Wert, Laenge oder Teile) und prueft die Syntax.
Ohne --live kein Netzwerkzugriff. --live: kostenloser models.list-Test je Provider.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from pathlib import Path

from .ai.providers import registry
from .ai.providers.base_provider import ProviderError
from .config.settings import Settings, env_file_candidates, resolve_env_file
from .security import redact, set_known_secrets

_LINE = re.compile(r"^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=")


def syntax_problems(path: Path) -> list[str]:
    """Nur Zeilennummern und Art des Problems - nie Zeileninhalte."""
    problems: list[str] = []
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return ["Datei ist nicht UTF-8-kodiert"]
    except OSError:
        return ["Datei nicht lesbar"]
    for n, line in enumerate(text.splitlines(), 1):
        st = line.strip()
        if not st or st.startswith("#"):
            continue
        if not _LINE.match(line):
            problems.append(f"Zeile {n}: keine gueltige KEY=Wert-Zeile")
            continue
        value = line.split("=", 1)[1].strip()
        if value[:1] in ("'", '"') and (len(value) < 2 or value[-1] != value[0]):
            problems.append(f"Zeile {n}: Anfuehrungszeichen nicht geschlossen")
    return problems


def main(argv: list[str] | None = None, settings: Settings | None = None, provider_factory=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.check_env")
    ap.add_argument("--live", action="store_true", help="kostenloser Verbindungstest (models.list) je Provider")
    args = ap.parse_args(argv)
    ok = True

    env_path = resolve_env_file()
    print("Suchreihenfolge fuer die .env:")
    for c in env_file_candidates():
        print(f"  {'*' if c == env_path else ' '} {c}")
    if env_path is None:
        print("FEHLER: keine .env-Datei gefunden (Prozess-Umgebungsvariablen koennen trotzdem gesetzt sein).")
        ok = False
    else:
        print(f"Verwendet: {env_path}")
        problems = syntax_problems(env_path)
        for p in problems:
            print(f"SYNTAX: {p}")
        print("Syntax: " + ("OK" if not problems else "Probleme gefunden"))
        ok = ok and not problems

    try:
        s = settings or Settings()
    except Exception as e:
        print(f"FEHLER: Einstellungen nicht ladbar ({type(e).__name__}).")
        return 1
    set_known_secrets(s.secret_values())

    print("Schluessel:")
    for name, var in (("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY")):
        print(f"  {var}: {'gesetzt' if s.has_key(name) else 'fehlt'}")
    if not (s.has_key("openai") or s.has_key("anthropic")):
        print("FEHLER: kein API-Schluessel gesetzt.")
        ok = False

    if args.live:
        factory = provider_factory or registry.create_provider
        print("Live-Test (models.list, keine Tokens):")
        for name in ("openai", "anthropic"):
            if not s.has_key(name):
                print(f"  {name}: uebersprungen (kein Schluessel)")
                continue
            try:
                models = asyncio.run(factory(name, s).list_models())
                print(f"  {name}: OK ({len(models)} Modelle)")
            except ProviderError as e:
                print(f"  {name}: FEHLER {type(e).__name__} ({e.code}): {redact(e.message)}")
                ok = False
            except Exception as e:
                print(f"  {name}: FEHLER {type(e).__name__}")
                ok = False
    print("Ergebnis: " + ("OK" if ok else "Probleme gefunden"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
