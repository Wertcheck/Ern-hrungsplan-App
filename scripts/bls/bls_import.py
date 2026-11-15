#!/usr/bin/env python3
"""
Reproduzierbarer Import des Bundeslebensmittelschlüssels (BLS 4.0, Max Rubner-Institut, CC BY 4.0).

Schritte (siehe BLS_INTEGRATION.md):
  1. Archiv beschaffen:  --download  (Seite https://www.blsdb.de/download, nur freigegebene Hosts) oder --zip <Datei>
  2. Prüfen:            SHA-256 gegen scripts/bls/SOURCE.json, Mitgliedsnamen, Größenlimits. Es wird NICHTS entpackt oder
                         ausgeführt; die XLSX wird direkt aus dem ZIP gelesen.
  3. Normalisieren:     Werte pro 100 g essbarem Anteil; '-'/leer = fehlend (NICHT 0); 'TR' = Spuren; '<LOD'/'<LOQ' = unter Nachweisgrenze.
  4. Ausgabe:           src/data/bls/bls40.json (vollständig, kompakt), src/data/bls/mapped.json (Zuordnung zu App-Lebensmitteln)

Aufruf:  python scripts/bls/bls_import.py --zip BLS_4_0_2025_DE.zip   |   --download
Es werden keine Schlüssel benötigt und keine Nutzerdaten übertragen.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import sys
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT_DIR = ROOT / "src" / "data" / "bls"
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_UNCOMPRESSED = 300 * 1024 * 1024
BAD_EXT = (".exe", ".bat", ".cmd", ".sh", ".js", ".vbs", ".dll", ".msi", ".ps1", ".jar", ".com", ".scr", ".py", ".so", ".dylib")

# BLS-Komponentencode -> (App-Feld). Einheiten gemäß BLS (pro 100 g): kcal, g, mg, µg – identisch mit der App.
FIELDS = [
    ("ENERCC", "kcal"), ("PROT625", "protein"), ("FAT", "fat"), ("CHO", "carbs"), ("FIBT", "fiber"),
    ("CA", "calcium"), ("MG", "magnesium"), ("K", "kalium"), ("FE", "eisen"), ("ZN", "zink"),
    ("VITAA", "vitaminA"), ("VITB12", "vitaminB12"), ("VITC", "vitaminC"), ("VITD", "vitaminD"), ("VITE", "vitaminE"), ("FOL", "folat"),
]
MACRO_FIELDS = ("kcal", "protein", "fat", "carbs", "fiber")
MICRO_FIELDS = tuple(n for _, n in FIELDS[5:])
# Hauptgruppen (erster Buchstabe des BLS-Codes). Beschriftung ist eine App-seitige Zusammenfassung nach Inhalt,
# kein Bestandteil des Datensatzes.
GROUP_LABELS = {
    "B": "Brot", "C": "Getreide", "D": "Backwaren", "E": "Eier, Teigwaren", "F": "Obst", "G": "Gemüse", "H": "Hülsenfrüchte, Nüsse, Samen",
    "K": "Kartoffeln, Pilze, Stärke", "M": "Milch, Milchprodukte", "N": "Getränke (alkoholfrei)", "P": "Getränke (alkoholisch)",
    "Q": "Fette, Öle", "R": "Gewürze, Zutaten", "S": "Zucker, Honig, Süßwaren", "T": "Fisch, Meeresfrüchte", "U": "Fleisch",
    "V": "Geflügel, Wild, Innereien", "W": "Wurstwaren, Speck", "X": "Zubereitete Komponenten, Soßen, Suppen", "Y": "Gerichte",
}


class ImportError_(Exception):
    pass


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def find_download_url(html: str, source: dict) -> str:
    m = re.search(r'href="((?:https?:)?[^"]*?' + re.escape(source["archiveName"].split(".")[0].replace("_DE", "")) + r'[^"]*?\.zip[^"]*)"', html.replace("&#47;", "/").replace("&#95;", "_").replace("&#46;", "."))
    if not m:
        raise ImportError_("Download-Link auf der Downloadseite nicht gefunden (Seitenstruktur geändert?).")
    url = m.group(1)
    if url.startswith("/"):
        url = "https://www.blsdb.de" + url
    host = urlparse(url).hostname or ""
    if host not in source["allowedHosts"]:
        raise ImportError_(f"Host nicht freigegeben: {host}")
    return url


def download(source: dict, dest: Path) -> None:
    req = urllib.request.Request(source["downloadPage"], headers={"User-Agent": "ernaehrungsplan-bls-import/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - Host siehe allowedHosts
        html = r.read().decode("utf-8", "replace")
    url = find_download_url(html, source)
    req = urllib.request.Request(url, headers={"User-Agent": "ernaehrungsplan-bls-import/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310
        data = r.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        raise ImportError_("Archiv größer als erlaubt.")
    dest.write_bytes(data)


def read_member(zip_path: Path, source: dict, accept_new_hash: bool = False) -> bytes:
    """Prüft das Archiv und gibt die Bytes der Daten-XLSX zurück. Entpackt nichts auf die Festplatte."""
    raw = zip_path.read_bytes()
    if len(raw) > MAX_ARCHIVE:
        raise ImportError_("Archiv größer als erlaubt.")
    digest = sha256_bytes(raw)
    if digest != source["archiveSha256"] and not accept_new_hash:
        raise ImportError_(f"SHA-256 weicht von SOURCE.json ab ({digest[:12]}…). Neue Version? Mit --accept-new-hash und angepasster SOURCE.json fortfahren.")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if z.testzip() is not None:
            raise ImportError_("Archiv beschädigt.")
        total = 0
        target = None
        for info in z.infolist():
            name = info.filename
            if name.startswith("/") or ".." in Path(name).parts or "\\" in name:
                raise ImportError_(f"Unsicherer Dateiname im Archiv: {name!r}")
            if name.lower().endswith(BAD_EXT):
                raise ImportError_(f"Ausführbare/Skript-Datei im Archiv: {name!r}")
            total += info.file_size
            if Path(name).name == source["dataFile"]:
                target = info
        if total > MAX_UNCOMPRESSED:
            raise ImportError_("Entpackte Größe über dem Limit.")
        if target is None:
            raise ImportError_(f"{source['dataFile']} nicht im Archiv.")
        return z.read(target)


def parse_value(v):
    """-> (zahl | None, flag | None). flag: 't' Spuren, 'l' unter Nachweisgrenze, 'm' fehlend."""
    if v is None:
        return None, "m"
    if isinstance(v, bool):
        return None, "m"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None, "m"
        if v < 0:
            raise ImportError_(f"Negativer Wert: {v}")
        return float(v), None
    s = str(v).strip()
    if s in ("", "-"):
        return None, "m"
    if s == "TR":
        return 0.0, "t"
    if s.startswith("<LO"):
        return 0.0, "l"
    try:
        f = float(s.replace(",", "."))
    except ValueError as e:
        raise ImportError_(f"Unbekanntes Wertformat: {s!r}") from e
    if f < 0:
        raise ImportError_(f"Negativer Wert: {f}")
    return f, None


def norm(x: float, name: str) -> float:
    """Einheitliche Genauigkeit: kcal ganzzahlig, sonst 4 signifikante Stellen (BLS liefert uneinheitlich viele Nachkommastellen)."""
    if name == "kcal":
        return float(round(x))
    return float(f"{x:.4g}")


def parse_workbook(xlsx: bytes) -> tuple[list[dict], dict]:
    import openpyxl

    wb = openpyxl.load_workbook(io.BytesIO(xlsx), read_only=True, data_only=True)
    ws = wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    hdr = next(it)
    if not hdr or str(hdr[0]).strip() != "BLS Code" or "Lebensmittelbezeichnung" not in str(hdr[1]):
        raise ImportError_("Unerwartete Kopfzeile – Tabellenformat geändert?")
    cols: dict[str, tuple[int, str]] = {}
    for i, h in enumerate(hdr):
        m = re.match(r"^(\S+) (.*) \[(.+)/100g\]$", str(h))
        if m:
            cols[m.group(1)] = (i, m.group(3))
    units = {"kcal": "kcal", "protein": "g", "fat": "g", "carbs": "g", "fiber": "g", "calcium": "mg", "magnesium": "mg", "kalium": "mg",
             "eisen": "mg", "zink": "mg", "vitaminA": "µg", "vitaminB12": "µg", "vitaminC": "mg", "vitaminD": "µg", "vitaminE": "mg", "folat": "µg"}
    for code, field in FIELDS:
        if code not in cols:
            raise ImportError_(f"Nährstoffspalte {code} fehlt.")
        if cols[code][1] != units[field]:
            raise ImportError_(f"Einheit von {code} ist {cols[code][1]!r}, erwartet {units[field]!r}.")
    foods, seen = [], set()
    for row in it:
        if not row or not row[0]:
            continue
        code = str(row[0]).strip()
        if not re.fullmatch(r"[A-Z][0-9A-Z]{6}", code):
            raise ImportError_(f"Unerwarteter BLS-Code: {code!r}")
        if code in seen:
            raise ImportError_(f"Doppelter BLS-Code: {code}")
        seen.add(code)
        vals, flags = {}, {}
        for bls_code, field in FIELDS:
            n, fl = parse_value(row[cols[bls_code][0]])
            vals[field] = None if n is None else norm(n, field)
            if fl:
                flags[field] = fl
        foods.append({"code": code, "de": str(row[1]).strip(), "en": (str(row[2]).strip() if row[2] else ""), "group": code[0], "v": vals, "f": flags})
    return foods, {"columns": len(hdr), "nutrients": len(cols)}


def quality_of(v: dict) -> str:
    return "missing" if any(v[k] is None for k in ("kcal", "protein", "fat", "carbs")) else "verified"


def build(foods: list[dict], source: dict, mapping: dict) -> tuple[dict, dict]:
    fields = ["code", "de", "en", "group", *[n for _, n in FIELDS], "flags"]
    rows = []
    for f in foods:
        flags = ",".join(f"{k}:{v}" for k, v in sorted(f["f"].items()))
        rows.append([f["code"], f["de"], f["en"], f["group"], *[f["v"][n] for _, n in FIELDS], flags])
    by_code = {f["code"]: f for f in foods}
    stats = {n: sum(1 for f in foods if f["v"][n] is None) for _, n in FIELDS}
    meta = {
        "dataset": source["dataset"], "version": source["version"], "publisher": source["publisher"], "doi": source["doi"], "license": source["license"],
        "licenseUrl": source["licenseUrl"], "citation": source["citation"], "retrieved": source["retrieved"], "archiveSha256": source["archiveSha256"],
        "foodCount": len(foods), "importer": "bls_import.py/1", "schema": 1, "units": "pro 100 g essbarer Anteil; kcal; g; mg; µg",
        "carbsDefinition": "verfügbare Kohlenhydrate (CHO, ohne Ballaststoffe)", "missingCounts": stats,
        "groupLabels": GROUP_LABELS, "groupLabelsNote": "App-seitige Beschriftung nach Inhalt, nicht Teil des Datensatzes",
        "flagsLegend": {"t": "Spuren (TR) – als 0 geführt", "l": "unter Nachweis-/Bestimmungsgrenze – als 0 geführt", "m": "fehlend (null)"},
    }
    full = {"meta": meta, "fields": fields, "rows": rows}
    mapped = {}
    for fid, m in sorted((k, v) for k, v in mapping.items() if not k.startswith("_")):
        f = by_code.get(m["code"])
        if not f:
            raise ImportError_(f"Mapping {fid}: BLS-Code {m['code']} nicht im Datensatz.")
        mapped[fid] = {"code": f["code"], "blsName": f["de"], "rename": m.get("rename"), "quality": quality_of(f["v"]),
                       "v": {k: f["v"][k] for k in (*MACRO_FIELDS, *MICRO_FIELDS)}, "flags": f["f"]}
    return full, {"meta": {k: meta[k] for k in ("dataset", "version", "publisher", "doi", "license", "licenseUrl", "citation", "retrieved", "archiveSha256")}, "foods": mapped}


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False) + "\n", encoding="utf-8")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--zip", type=Path, help="bereits heruntergeladenes BLS-Archiv")
    g.add_argument("--download", action="store_true", help="Archiv von blsdb.de laden")
    ap.add_argument("--accept-new-hash", action="store_true", help="neue Archivversion akzeptieren (SOURCE.json danach aktualisieren)")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    a = ap.parse_args(argv)
    source = json.loads((HERE / "SOURCE.json").read_text(encoding="utf-8"))
    mapping = json.loads((HERE / "mapping.json").read_text(encoding="utf-8"))
    zip_path = a.zip
    if a.download:
        zip_path = HERE / ".download" / source["archiveName"]
        zip_path.parent.mkdir(exist_ok=True)
        download(source, zip_path)
    try:
        xlsx = read_member(zip_path, source, a.accept_new_hash)
        foods, info = parse_workbook(xlsx)
        full, mapped = build(foods, source, mapping)
    except ImportError_ as e:
        print(f"IMPORT ABGEBROCHEN: {e}", file=sys.stderr)
        return 1
    a.out.mkdir(parents=True, exist_ok=True)
    write_json(a.out / "bls40.json", full)
    write_json(a.out / "mapped.json", mapped)
    print(f"{len(foods)} Lebensmittel, {info['nutrients']} Nährstoffe gelesen; {len(mapped['foods'])} App-Lebensmittel zugeordnet.")
    print("Fehlende Werte je importiertem Feld:", {k: v for k, v in full["meta"]["missingCounts"].items() if v})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
