"""Ernaehrungskontext: strikt validierte Eingabe + kompaktes Rendering fuer den Prompt."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints

MAX_CONTEXT_CHARS = 12000


def clean_text(v):
    """Entfernt Steuer-/Formatzeichen (inkl. Zeilenumbrueche) und normalisiert Leerraum."""
    if isinstance(v, str):
        out = "".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else c for c in v)
        return " ".join(out.split())
    return v


def _s(n: int):
    return Annotated[str, BeforeValidator(clean_text), StringConstraints(max_length=n)]


S32, S100, S200, S300 = _s(32), _s(100), _s(200), _s(300)
Num = Annotated[float, Field(ge=0, le=1_000_000, allow_inf_nan=False)]
Pct = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Profile(_M):
    goal: S200 | None = None
    activity: S200 | None = None
    kcal_target: int | None = Field(None, ge=0, le=20000)
    persons: int | None = Field(None, ge=1, le=50)
    meal_count: int | None = Field(None, ge=1, le=20)
    age: int | None = Field(None, ge=0, le=130)
    height_cm: float | None = Field(None, ge=20, le=300, allow_inf_nan=False)
    weight_kg: float | None = Field(None, ge=1, le=700, allow_inf_nan=False)


class MacroTargets(_M):
    protein_pct: Pct | None = None
    carbs_pct: Pct | None = None
    fat_pct: Pct | None = None


class Restriction(_M):
    allergen: S200
    severity: Literal["allergy", "intolerance"]


class Oils(_M):
    main: S200 | None = None
    warm: S200 | None = None
    cold: S200 | None = None


class PlanMeal(_M):
    meal_id: S100
    slot: S32 | None = None
    recipe_id: S100 | None = None
    recipe_name: S200 | None = None
    factor: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)] | None = None
    kcal: Num | None = None
    protein: Num | None = None
    carbs: Num | None = None
    fat: Num | None = None


class PlanDay(_M):
    date: S32
    total_kcal: Num | None = None
    meals: list[PlanMeal] = Field(default_factory=list, max_length=20)


class Plan(_M):
    kcal_target: int | None = Field(None, ge=0, le=20000)
    days: list[PlanDay] = Field(default_factory=list, max_length=14)


class CatalogRecipe(_M):
    id: S100
    name: S200
    slots: list[S32] = Field(default_factory=list, max_length=10)
    kcal: Num | None = None
    protein: Num | None = None
    carbs: Num | None = None
    fat: Num | None = None


class ShoppingItem(_M):
    name: S200
    grams: Num | None = None


class WeightPoint(_M):
    date: S32
    kg: Annotated[float, Field(ge=1, le=700, allow_inf_nan=False)]


class Progress(_M):
    weights: list[WeightPoint] = Field(default_factory=list, max_length=60)
    adherence_pct: Pct | None = None


class NutrientGap(_M):
    nutrient: S200
    status: S200 | None = None
    note: S300 | None = None


class NutritionContext(_M):
    profile: Profile | None = None
    macro_targets: MacroTargets | None = None
    diets: list[S200] = Field(default_factory=list, max_length=20)
    custom_rules: list[S200] = Field(default_factory=list, max_length=20)
    restrictions: list[Restriction] = Field(default_factory=list, max_length=20)
    excluded_terms: list[S200] = Field(default_factory=list, max_length=50)
    excluded_foods: list[S200] = Field(default_factory=list, max_length=100)
    preferred_foods: list[S200] = Field(default_factory=list, max_length=100)
    oils: Oils | None = None
    plan: Plan | None = None
    recipe_catalog: list[CatalogRecipe] = Field(default_factory=list, max_length=80)
    food_catalog: list[S200] = Field(default_factory=list, max_length=250)
    shopping: list[ShoppingItem] = Field(default_factory=list, max_length=100)
    progress: Progress | None = None
    nutrient_gaps: list[NutrientGap] = Field(default_factory=list, max_length=30)


# ---------------------------------------------------------------- IDs

@dataclass
class ValidIds:
    dates: set[str] = field(default_factory=set)
    meals_by_date: dict[str, dict[str, str | None]] = field(default_factory=dict)  # date -> meal_id -> recipe_id
    recipe_ids: set[str] = field(default_factory=set)
    foods: set[str] = field(default_factory=set)  # kleingeschrieben

    @property
    def meal_ids(self) -> set[str]:
        return {m for d in self.meals_by_date.values() for m in d}


def collect_valid_ids(ctx: NutritionContext | None) -> ValidIds:
    ids = ValidIds()
    if ctx is None:
        return ids
    if ctx.plan:
        for day in ctx.plan.days:
            ids.dates.add(day.date)
            slot = ids.meals_by_date.setdefault(day.date, {})
            for m in day.meals:
                slot[m.meal_id] = m.recipe_id
    ids.recipe_ids = {r.id for r in ctx.recipe_catalog}
    ids.foods = {f.strip().lower() for f in ctx.food_catalog if f.strip()}
    return ids


# ---------------------------------------------------------------- Rendering

def _n(x: float | int | None) -> str:
    if x is None:
        return ""
    x = round(float(x), 1)
    return str(int(x)) if x == int(x) else str(x)


def _kv(parts: list[tuple[str, object, str]]) -> str:
    return " | ".join(f"{label}: {_n(v) if isinstance(v, (int, float)) else v}{unit}" for label, v, unit in parts if v not in (None, ""))


def _macros(o) -> str:
    bits = []
    for lbl, v in (("kcal", o.kcal), ("P", o.protein), ("K", o.carbs), ("F", o.fat)):
        if v is not None:
            bits.append(f"{lbl} {_n(v)}" + (" g" if lbl != "kcal" else ""))
    return ", ".join(bits)


Section = tuple[str, list[str]]


def _safety_sections(ctx: NutritionContext) -> list[Section]:
    out: list[Section] = []
    allergies = [r.allergen for r in ctx.restrictions if r.severity == "allergy"]
    intol = [r.allergen for r in ctx.restrictions if r.severity == "intolerance"]
    lines = []
    if allergies:
        lines.append("Allergien (strikt meiden): " + "; ".join(allergies))
    if intol:
        lines.append("Unvertraeglichkeiten: " + "; ".join(intol))
    if ctx.excluded_terms:
        lines.append("Ausgeschlossene Begriffe: " + "; ".join(ctx.excluded_terms))
    if ctx.excluded_foods:
        lines.append("Ausgeschlossene Lebensmittel: " + "; ".join(ctx.excluded_foods))
    if ctx.diets:
        lines.append("Ernaehrungsformen: " + "; ".join(ctx.diets))
    if ctx.custom_rules:
        lines.append("Eigene Regeln: " + "; ".join(ctx.custom_rules))
    if lines:
        out.append(("Sicherheitsrelevant (hat immer Vorrang, nie lockern)", lines))
    return out


def _other_sections(ctx: NutritionContext) -> list[Section]:
    out: list[Section] = []
    if ctx.profile:
        p = ctx.profile
        line = _kv([("Ziel", p.goal, ""), ("Aktivitaet", p.activity, ""), ("Kalorienziel", p.kcal_target, " kcal"),
                    ("Personen", p.persons, ""), ("Mahlzeiten/Tag", p.meal_count, ""), ("Alter", p.age, ""),
                    ("Groesse", p.height_cm, " cm"), ("Gewicht", p.weight_kg, " kg")])
        if line:
            out.append(("Profil", [line]))
    if ctx.macro_targets:
        m = ctx.macro_targets
        line = _kv([("Protein", m.protein_pct, " %"), ("Kohlenhydrate", m.carbs_pct, " %"), ("Fett", m.fat_pct, " %")])
        if line:
            out.append(("Makroziele", [line]))
    if ctx.oils:
        line = _kv([("Hauptoel", ctx.oils.main, ""), ("zum Erhitzen", ctx.oils.warm, ""), ("kalt", ctx.oils.cold, "")])
        if line:
            out.append(("Oele", [line]))
    if ctx.plan and (ctx.plan.days or ctx.plan.kcal_target is not None):
        title = "Plan" + (f" (Kalorienziel/Tag: {_n(ctx.plan.kcal_target)})" if ctx.plan.kcal_target is not None else "")
        lines: list[str] = []
        for d in ctx.plan.days:
            tot = f", gesamt {_n(d.total_kcal)} kcal" if d.total_kcal is not None else ""
            lines.append(f"Tag date={d.date}{tot}")
            for m in d.meals:
                bits = [f"date={d.date}", f"meal_id={m.meal_id}", m.slot or "-"]
                if m.recipe_id:
                    bits.append(f"recipe_id={m.recipe_id}")
                else:
                    bits.append("recipe_id=-")
                if m.recipe_name:
                    bits.append(m.recipe_name)
                if m.factor is not None:
                    bits.append(f"Portion x{_n(m.factor)}")
                mac = _macros(m)
                if mac:
                    bits.append(mac)
                lines.append("- " + " | ".join(bits))
        out.append((title, lines))
    if ctx.recipe_catalog:
        lines = []
        for r in ctx.recipe_catalog:
            bits = [f"recipe_id={r.id}", r.name]
            if r.slots:
                bits.append("Slots: " + ",".join(r.slots))
            mac = _macros(r)
            if mac:
                bits.append(mac)
            lines.append("- " + " | ".join(bits))
        out.append(("Rezeptkatalog (nur diese recipe_id sind erlaubt)", lines))
    if ctx.shopping:
        out.append(("Einkaufsliste", [f"- {s.name}" + (f" ({_n(s.grams)} g)" if s.grams is not None else "") for s in ctx.shopping]))
    if ctx.progress:
        lines = []
        if ctx.progress.weights:
            lines.append("Gewichtsverlauf: " + "; ".join(f"{w.date} {_n(w.kg)} kg" for w in ctx.progress.weights))
        if ctx.progress.adherence_pct is not None:
            lines.append(f"Planeinhaltung: {_n(ctx.progress.adherence_pct)} %")
        if lines:
            out.append(("Fortschritt", lines))
    if ctx.nutrient_gaps:
        out.append(("Naehrstoffluecken", [f"- {g.nutrient}" + (f" ({g.status})" if g.status else "") + (f": {g.note}" if g.note else "") for g in ctx.nutrient_gaps]))
    if ctx.preferred_foods:
        out.append(("Bevorzugte Lebensmittel", ["; ".join(ctx.preferred_foods)]))
    if ctx.food_catalog:
        out.append(("Lebensmittelkatalog (nur diese Namen fuer create_recipe)", ["; ".join(ctx.food_catalog)]))
    return out


def _fmt(title: str, lines: list[str]) -> str:
    return f"## {title}\n" + "\n".join(lines)


def render_context(ctx: NutritionContext | None, max_chars: int = MAX_CONTEXT_CHARS) -> str:
    """Kompakter deutscher Kontexttext. Sicherheitsrelevantes wird nie gekuerzt."""
    if ctx is None:
        return ""
    parts: list[str] = []
    used = 0
    for title, lines in _safety_sections(ctx):
        t = _fmt(title, lines)
        parts.append(t)
        used += len(t) + 2
    skipped: list[str] = []
    reserve = 200  # Platz fuer den Sammelhinweis ausgelassener Abschnitte
    for title, lines in _other_sections(ctx):
        full = _fmt(title, lines)
        remaining = max_chars - reserve - used
        if len(full) + 2 <= remaining:
            parts.append(full)
            used += len(full) + 2
            continue
        note_tpl = "[... {n} weitere Zeilen wegen Groessenlimit nicht uebermittelt]"
        head = f"## {title}\n"
        kept: list[str] = []
        size = len(head) + len(note_tpl.format(n=len(lines))) + 2
        if remaining - size > 80:
            for ln in lines:
                if size + len(ln) + 1 > remaining:
                    break
                kept.append(ln)
                size += len(ln) + 1
        if kept:
            t = head + "\n".join(kept) + "\n" + note_tpl.format(n=len(lines) - len(kept))
            parts.append(t)
            used += len(t) + 2
        else:
            skipped.append(title.split(" (")[0])
    if skipped:
        parts.append("[Wegen Groessenlimit nicht uebermittelt: " + ", ".join(skipped) + "]")
    return "\n\n".join(parts)
