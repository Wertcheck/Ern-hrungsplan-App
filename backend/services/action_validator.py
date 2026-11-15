"""Struktur-/Katalogpruefung der KI-Aktionsvorschlaege. Fuehrt nichts aus."""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from ..ai.providers.base_provider import ToolSpec
from .nutrition_context import S32, S100, S200, S300, NutritionContext, collect_valid_ids

MAX_PROPOSALS = 10
TOOL_NAME = "propose_actions"
Slot = Literal["fruehstueck", "mittag", "abend", "snack"]
Factor = Annotated[float, Field(ge=0.25, le=3.0, allow_inf_nan=False)]
Name80 = Annotated[str, Field(max_length=80, min_length=1)]


class _A(BaseModel):
    model_config = ConfigDict(extra="ignore")
    reason: S300 | None = None


class SwapMeal(_A):
    type: Literal["swap_meal"]
    date: S32
    meal_id: S100
    recipe_id: S100


class AddMeal(_A):
    type: Literal["add_meal"]
    date: S32
    slot: Slot
    recipe_id: S100
    portion_factor: Factor | None = None


class RemoveMeal(_A):
    type: Literal["remove_meal"]
    date: S32
    meal_id: S100


class SetPortion(_A):
    type: Literal["set_portion"]
    date: S32
    meal_id: S100
    portion_factor: Factor


class Ingredient(BaseModel):
    model_config = ConfigDict(extra="ignore")
    food_name: S200
    grams: Annotated[float, Field(ge=0.1, le=3000, allow_inf_nan=False)]


class CreateRecipe(_A):
    type: Literal["create_recipe"]
    name: Annotated[str, Field(min_length=1, max_length=80)]
    slots: Annotated[list[Slot], Field(min_length=1, max_length=4)]
    ingredients: Annotated[list[Ingredient], Field(min_length=1, max_length=30)]
    steps: Annotated[list[S300], Field(max_length=15)] = []


class ExcludeFood(_A):
    type: Literal["exclude_food"]
    food_name: S200


class AddShoppingItem(_A):
    type: Literal["add_shopping_item"]
    name: S200
    amount: S100 | None = None


Action = Annotated[
    Union[SwapMeal, AddMeal, RemoveMeal, SetPortion, CreateRecipe, ExcludeFood, AddShoppingItem],
    Field(discriminator="type"),
]
_ADAPTER: TypeAdapter = TypeAdapter(Action)
ACTION_TYPES = {"swap_meal", "add_meal", "remove_meal", "set_portion", "create_recipe", "exclude_food", "add_shopping_item"}


def _inline(node: Any, defs: dict) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            return _inline(defs[node["$ref"].split("/")[-1]], defs)
        out: dict = {}
        for k, v in node.items():
            if k in ("title", "discriminator", "$defs"):
                continue
            if k == "properties" and isinstance(v, dict):
                out[k] = {pk: _inline(pv, defs) for pk, pv in v.items()}
                continue
            out["anyOf" if k == "oneOf" else k] = _inline(v, defs)
        return out
    if isinstance(node, list):
        return [_inline(x, defs) for x in node]
    return node


def propose_actions_tool() -> ToolSpec:
    schema = _ADAPTER.json_schema(mode="validation")
    item = _inline(schema, schema.get("$defs", {}))
    params = {
        "type": "object",
        "properties": {"proposals": {"type": "array", "items": item, "maxItems": MAX_PROPOSALS}},
        "required": ["proposals"],
    }
    return ToolSpec(
        name=TOOL_NAME,
        description=(
            "Schlaegt Planaenderungen vor. Nur Vorschlaege: der Nutzer muss jede Aenderung selbst bestaetigen. "
            "Verwende ausschliesslich IDs, Daten und Lebensmittelnamen aus dem Kontext."
        ),
        parameters=params,
    )


def _reject(raw: Any, reason: str) -> dict:
    t = raw.get("type") if isinstance(raw, dict) else None
    return {"type": str(t)[:40] if isinstance(t, str) and t else "unknown", "reason": reason}


def _err_reason(e: ValidationError) -> str:
    first = e.errors(include_input=False, include_url=False)[0]
    loc = ".".join(str(x) for x in first["loc"][1:]) or "Aktion"
    return f"Ungueltige Felder ({loc}: {first['msg']})"[:300]


def validate_proposals(raw_list: Any, ctx: NutritionContext | None) -> tuple[list[dict], list[dict]]:
    accepted: list[dict] = []
    rejected: list[dict] = []
    if not isinstance(raw_list, list):
        return [], [{"type": "unknown", "reason": "proposals ist keine Liste"}]
    ids = collect_valid_ids(ctx)
    for n, raw in enumerate(raw_list):
        if n >= MAX_PROPOSALS:
            rejected.append(_reject(raw, f"Zu viele Vorschlaege (maximal {MAX_PROPOSALS})"))
            continue
        if not isinstance(raw, dict) or raw.get("type") not in ACTION_TYPES:
            rejected.append(_reject(raw, "Unbekannter Aktionstyp"))
            continue
        try:
            act = _ADAPTER.validate_python(raw)
        except ValidationError as e:
            rejected.append(_reject(raw, _err_reason(e)))
            continue
        reason = _check(act, ids, ctx)
        if reason:
            rejected.append({"type": act.type, "reason": reason})
        else:
            accepted.append(act.model_dump(exclude_none=True))
    return accepted, rejected


def _check(act: Any, ids, ctx: NutritionContext | None) -> str | None:
    t = act.type
    if t in ("exclude_food", "add_shopping_item"):
        return None
    if t == "create_recipe":
        if not ids.foods:
            return "Kein Lebensmittelkatalog uebermittelt"
        for ing in act.ingredients:
            if ing.food_name.strip().lower() not in ids.foods:
                return f"Zutat nicht im Lebensmittelkatalog: {ing.food_name[:60]}"
        return None
    if ctx is None or ctx.plan is None:
        return "Kein Plan im Kontext uebermittelt"
    if act.date not in ids.dates:
        return f"Datum nicht im Plan: {act.date[:32]}"
    if t in ("swap_meal", "remove_meal", "set_portion"):
        meals = ids.meals_by_date.get(act.date, {})
        if act.meal_id not in meals:
            return f"meal_id nicht im Plan fuer {act.date}: {act.meal_id[:60]}"
    if t in ("swap_meal", "add_meal"):
        if act.recipe_id not in ids.recipe_ids:
            return f"recipe_id nicht im Rezeptkatalog: {act.recipe_id[:60]}"
        if t == "swap_meal" and ids.meals_by_date[act.date].get(act.meal_id) == act.recipe_id:
            return "Rezept ist bereits fuer diese Mahlzeit geplant"
    return None
