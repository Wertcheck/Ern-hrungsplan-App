from __future__ import annotations

import pytest

from backend import check_env
from backend.ai.providers.base_provider import AuthError
from backend.config import settings as settings_mod
from backend.config.settings import Settings, resolve_env_file

from .conftest import SECRET, ScriptedProvider


@pytest.fixture
def fake_roots(tmp_path, monkeypatch):
    repo, backend = tmp_path / "repo", tmp_path / "repo" / "backend"
    backend.mkdir(parents=True)
    monkeypatch.setattr(settings_mod, "REPO_ROOT", repo)
    monkeypatch.setattr(settings_mod, "BACKEND_DIR", backend)
    for k in ("ENV_FILE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_DEFAULT_MODEL"):
        monkeypatch.delenv(k, raising=False)
    return repo, backend


def test_search_order(fake_roots, monkeypatch, tmp_path):
    repo, backend = fake_roots
    assert resolve_env_file() is None
    (backend / ".env").write_text("OPENAI_API_KEY=" + SECRET + "-backend\n")
    assert resolve_env_file() == backend / ".env"
    (repo / ".env").write_text("OPENAI_API_KEY=" + SECRET + "-repo\n")
    assert resolve_env_file() == repo / ".env"
    s = Settings(data_dir=tmp_path)
    assert s.openai_api_key.get_secret_value() == SECRET + "-repo"
    explicit = tmp_path / "x.env"
    explicit.write_text("OPENAI_API_KEY=" + SECRET + "-explicit\n")
    monkeypatch.setenv("ENV_FILE", str(explicit))
    assert resolve_env_file() == explicit
    assert Settings(data_dir=tmp_path).openai_api_key.get_secret_value() == SECRET + "-explicit"
    monkeypatch.setenv("ENV_FILE", str(tmp_path / "gibt-es-nicht.env"))  # fehlt -> naechste Stufe
    assert resolve_env_file() == repo / ".env"


def test_path_with_space_and_umlaut(fake_roots, monkeypatch, tmp_path):
    d = tmp_path / "Ernährungsplan Projekt"
    d.mkdir()
    f = d / "geheim ä.env"
    f.write_text("ANTHROPIC_API_KEY=" + SECRET + "\n", encoding="utf-8")
    monkeypatch.setenv("ENV_FILE", str(f))
    assert resolve_env_file() == f
    assert Settings(data_dir=tmp_path).has_key("anthropic")


def test_process_env_wins(fake_roots, monkeypatch, tmp_path):
    repo, _ = fake_roots
    (repo / ".env").write_text("OPENAI_API_KEY=aus-datei-1234\nOPENAI_DEFAULT_MODEL=file-model\n")
    monkeypatch.setenv("OPENAI_API_KEY", SECRET)
    s = Settings(data_dir=tmp_path)
    assert s.openai_api_key.get_secret_value() == SECRET and s.openai_default_model == "file-model"


def test_env_file_not_modified(fake_roots, tmp_path):
    repo, _ = fake_roots
    f = repo / ".env"
    f.write_text("OPENAI_API_KEY=abc12345\n")
    before = (f.read_bytes(), f.stat().st_mtime_ns)
    Settings(data_dir=tmp_path)
    check_env.main([], settings=Settings(data_dir=tmp_path))
    assert (f.read_bytes(), f.stat().st_mtime_ns) == before
    assert [p.name for p in repo.iterdir() if p.is_file()] == [".env"]


def test_check_env_never_prints_secret(fake_roots, capsys, tmp_path):
    repo, _ = fake_roots
    (repo / ".env").write_text(f"OPENAI_API_KEY={SECRET}\nANTHROPIC_API_KEY={SECRET}-anthropic\n")
    code = check_env.main([])
    out = capsys.readouterr().out
    assert code == 0
    assert SECRET not in out and "anthropic\n" not in out.replace("ANTHROPIC", "")
    assert "OPENAI_API_KEY: gesetzt" in out and "ANTHROPIC_API_KEY: gesetzt" in out
    assert str(repo / ".env") in out and "Syntax: OK" in out
    assert str(len(SECRET)) not in out.split("Schluessel:")[1]


def test_check_env_missing_file_and_keys(fake_roots, capsys):
    assert check_env.main([]) == 1
    out = capsys.readouterr().out
    assert "keine .env-Datei" in out and "OPENAI_API_KEY: fehlt" in out and "ANTHROPIC_API_KEY: fehlt" in out


def test_check_env_syntax_problems_no_content(fake_roots, capsys):
    repo, _ = fake_roots
    (repo / ".env").write_text(f"# ok\nOPENAI_API_KEY={SECRET}\nGEHEIME ZEILE OHNE GLEICH\nANTHROPIC_API_KEY=\"offen\n")
    assert check_env.main([]) == 1
    out = capsys.readouterr().out
    assert "Zeile 3" in out and "Zeile 4" in out and "GEHEIME" not in out and SECRET not in out and "offen" not in out


def test_live_with_fake_providers(fake_roots, capsys):
    repo, _ = fake_roots
    (repo / ".env").write_text(f"OPENAI_API_KEY={SECRET}\nANTHROPIC_API_KEY={SECRET}b\n")
    seen = []

    def factory(name, s):
        seen.append(name)
        return ScriptedProvider([])

    assert check_env.main(["--live"], provider_factory=factory) == 0
    out = capsys.readouterr().out
    assert seen == ["openai", "anthropic"] and "openai: OK" in out and "anthropic: OK" in out and SECRET not in out


def test_live_failure_sanitized_exit1(fake_roots, capsys):
    repo, _ = fake_roots
    (repo / ".env").write_text(f"OPENAI_API_KEY={SECRET}\n")

    class Bad(ScriptedProvider):
        async def list_models(self):
            raise AuthError(f"kaputt {SECRET} Bearer abcdefgh1234")

    assert check_env.main(["--live"], provider_factory=lambda n, s: Bad([])) == 1
    out = capsys.readouterr().out
    assert "AuthError" in out and SECRET not in out and "abcdefgh1234" not in out and "anthropic: uebersprungen" in out


def test_no_network_without_live(fake_roots, capsys):
    repo, _ = fake_roots
    (repo / ".env").write_text(f"OPENAI_API_KEY={SECRET}\n")

    def boom(n, s):
        raise AssertionError("kein Provider ohne --live")

    assert check_env.main([], provider_factory=boom) == 0
