"""Tests des BLS-Importers mit synthetischen Testdaten (Fixture, KEINE echten BLS-Werte)."""
import io
import json
import sys
import zipfile
from pathlib import Path

import openpyxl
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bls_import as b  # noqa: E402

SOURCE = {
    "dataset": "TEST", "version": "0", "publisher": "t", "doi": "x", "license": "t", "licenseUrl": "u", "citation": "c", "retrieved": "2000-01-01",
    "dataFile": "data.xlsx", "archiveSha256": "", "allowedHosts": ["www.blsdb.de"], "archiveName": "BLS_4_0_2025_DE.zip",
}
UNITS = {"ENERCC": "kcal", "PROT625": "g", "FAT": "g", "CHO": "g", "FIBT": "g", "CA": "mg", "MG": "mg", "K": "mg", "FE": "mg", "ZN": "mg",
         "VITAA": "µg", "VITB12": "µg", "VITC": "mg", "VITD": "µg", "VITE": "mg", "FOL": "µg"}


def make_xlsx(rows, units=None, header0="BLS Code"):
    units = units or UNITS
    wb = openpyxl.Workbook()
    ws = wb.active
    hdr = [header0, "Lebensmittelbezeichnung", "Food name"]
    for code, u in units.items():
        hdr += [f"{code} Name [{u}/100g]", f"{code} Datenherkunft", f"{code} Referenz"]
    ws.append(hdr)
    for code, de, vals in rows:
        r = [code, de, de + " en"]
        for c in units:
            r += [vals.get(c, 1), "Analyse", "-"]
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_zip(tmp_path, members, name="a.zip"):
    p = tmp_path / name
    with zipfile.ZipFile(p, "w") as z:
        for n, data in members.items():
            z.writestr(n, data)
    return p


def src_for(p):
    return {**SOURCE, "archiveSha256": b.sha256_bytes(p.read_bytes())}


def test_parse_value_semantik():
    assert b.parse_value(12.5) == (12.5, None)
    assert b.parse_value("-") == (None, "m")          # fehlend ist NICHT 0
    assert b.parse_value(None) == (None, "m")
    assert b.parse_value("TR") == (0.0, "t")
    assert b.parse_value("<LOD") == (0.0, "l")
    assert b.parse_value("<LOD or <LOQ") == (0.0, "l")
    assert b.parse_value("3,5") == (3.5, None)
    with pytest.raises(b.ImportError_):
        b.parse_value("abc")
    with pytest.raises(b.ImportError_):
        b.parse_value(-1)


def test_normalisierung():
    assert b.norm(348.4, "kcal") == 348.0
    assert b.norm(3.622123, "protein") == 3.622
    assert b.norm(0.00012346, "vitaminB12") == 0.0001235


def test_workbook_roundtrip_und_build(tmp_path):
    xlsx = make_xlsx([("G100100", "Testgemüse roh", {"ENERCC": 20, "CHO": "TR", "FIBT": "-"}), ("M200000", "Testmilch", {})])
    foods, info = b.parse_workbook(xlsx)
    assert len(foods) == 2 and info["nutrients"] == 16
    g = foods[0]
    assert g["v"]["carbs"] == 0.0 and g["f"]["carbs"] == "t" and g["v"]["fiber"] is None and g["f"]["fiber"] == "m"
    full, mapped = b.build(foods, SOURCE, {"a": {"code": "G100100"}, "_comment": "x"})
    assert full["meta"]["foodCount"] == 2 and full["fields"][:4] == ["code", "de", "en", "group"]
    assert mapped["foods"]["a"]["quality"] == "verified"  # nur fiber fehlt -> Hauptmakros vollständig
    assert mapped["foods"]["a"]["v"]["fiber"] is None     # fehlender Wert bleibt null, wird nicht zu 0


def test_fehlende_hauptwerte_ergeben_quality_missing():
    foods, _ = b.parse_workbook(make_xlsx([("G100100", "x", {"FAT": "-"})]))
    assert b.quality_of(foods[0]["v"]) == "missing"


def test_mapping_auf_unbekannten_code_bricht_ab():
    foods, _ = b.parse_workbook(make_xlsx([("G100100", "x", {})]))
    with pytest.raises(b.ImportError_):
        b.build(foods, SOURCE, {"a": {"code": "Z999999"}})


def test_doppelte_codes_und_ungueltige_codes_werden_abgelehnt():
    with pytest.raises(b.ImportError_):
        b.parse_workbook(make_xlsx([("G100100", "a", {}), ("G100100", "b", {})]))
    with pytest.raises(b.ImportError_):
        b.parse_workbook(make_xlsx([("12345", "a", {})]))


def test_geaenderte_einheit_oder_kopfzeile_wird_abgelehnt():
    with pytest.raises(b.ImportError_):
        b.parse_workbook(make_xlsx([("G100100", "a", {})], units={**UNITS, "CA": "g"}))
    with pytest.raises(b.ImportError_):
        b.parse_workbook(make_xlsx([("G100100", "a", {})], header0="Code"))


def test_archiv_pruefung(tmp_path):
    x = make_xlsx([("G100100", "a", {})])
    ok = make_zip(tmp_path, {"d/data.xlsx": x})
    assert b.read_member(ok, src_for(ok)) == x
    # falscher Hash
    with pytest.raises(b.ImportError_, match="SHA-256"):
        b.read_member(ok, {**SOURCE, "archiveSha256": "0" * 64})
    assert b.read_member(ok, {**SOURCE, "archiveSha256": "0" * 64}, accept_new_hash=True) == x
    # Path-Traversal und ausführbare Dateien
    bad = make_zip(tmp_path, {"../evil.xlsx": x, "d/data.xlsx": x}, "bad.zip")
    with pytest.raises(b.ImportError_, match="Unsicher"):
        b.read_member(bad, src_for(bad))
    exe = make_zip(tmp_path, {"d/data.xlsx": x, "d/setup.exe": b"MZ"}, "exe.zip")
    with pytest.raises(b.ImportError_, match="Ausführbare"):
        b.read_member(exe, src_for(exe))
    nodata = make_zip(tmp_path, {"d/other.xlsx": x}, "n.zip")
    with pytest.raises(b.ImportError_, match="nicht im Archiv"):
        b.read_member(nodata, src_for(nodata))


def test_download_link_extraktion_und_hostpruefung():
    html = '<a href="&#47;assets&#47;uploads&#47;BLS&#95;4&#95;0&#95;2025&#95;DE&#46;zip?token=ABC">x</a>'
    assert b.find_download_url(html, SOURCE).startswith("https://www.blsdb.de/assets/uploads/BLS_4_0_2025_DE.zip")
    evil = '<a href="https://evil.example/BLS_4_0_2025.zip?x=1">x</a>'
    with pytest.raises(b.ImportError_, match="Host"):
        b.find_download_url(evil, SOURCE)
    with pytest.raises(b.ImportError_):
        b.find_download_url("<html></html>", SOURCE)


def test_cli_end_to_end_mit_fixture(tmp_path, monkeypatch):
    x = make_xlsx([("G100100", "Testgemüse roh", {"ENERCC": 20})])
    z = make_zip(tmp_path, {"d/data.xlsx": x, "d/README.pdf": b"%PDF"})
    monkeypatch.setattr(b, "HERE", tmp_path)
    (tmp_path / "mapping.json").write_text(json.dumps({"a": {"code": "G100100"}}))
    out = tmp_path / "out"
    (tmp_path / "SOURCE.json").write_text(json.dumps(src_for(z)))
    assert b.main(["--zip", str(z), "--out", str(out)]) == 0
    assert json.loads((out / "bls40.json").read_text())["meta"]["foodCount"] == 1
    assert (out / "mapped.json").exists()
