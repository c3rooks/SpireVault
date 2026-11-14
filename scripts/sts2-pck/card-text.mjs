/**
 * A card's rules text the way the game builds it, as the game's BBCode.
 *
 * Mirrors CardModel.GetDescriptionForPile (sts2.dll, v0.113.0):
 *   1. the localized "<ID>.description" template is formatted with
 *      SmartFormat and the card's dynamic vars, plus IfUpgraded, OnTable,
 *      InCombat (false: a card face is shown out of combat), energyPrefix and
 *      singleStarIcon;
 *   2. keyword lines are added: Unplayable, Innate, Retain, Sly, Ethereal
 *      above (CardKeywordOrder.beforeDescription, each inserted at the top),
 *      Exhaust, Eternal below, each as "[gold]<Title>[/gold].";
 *   3. non-empty parts are joined with "\n".
 *
 * Formatters (MegaCrit.Sts2.Core.Localization.Formatters): diff -> the value,
 * wrapped in [green] when the upgrade changed it (DynamicVar.WasJustUpgraded);
 * energyIcons / starIcons -> 1..4 icons, else "<n>" + one icon; show ->
 * IfUpgraded's options; plus SmartFormat's own plural / conditional / choose.
 *
 * The faces show an upgraded card the way the shipped "+" renders do: the
 * card just upgraded (CardModel.UpgradeInternal: CurrentUpgradeLevel 1, every
 * var OnUpgrade touched has WasJustUpgraded set), so changed numbers are green,
 * while IfUpgraded text is plain (UpgradeDisplay.Upgraded, as for any upgraded
 * card; only the upgrade-preview screen paints it green). Armaments+,
 * Malaise+ and Compact+ in the shipped set confirm both.
 */

const KEYWORDS_BEFORE = ["Ethereal", "Sly", "Retain", "Innate", "Unplayable"]; // each inserted at index 0
const KEYWORDS_AFTER = ["Exhaust", "Eternal"];
const STAR_ICON = "[img]res://images/packed/sprite_fonts/star_icon.png[/img]";
const energyIcon = (prefix) => `[img]res://images/packed/sprite_fonts/${prefix}_energy_icon.png[/img]`;
const KNOWN_FORMATTERS = new Set(["diff", "inverseDiff", "energyIcons", "starIcons", "plural", "show", "choose", "cond", "percentMore", "percentLess", "abs"]);

/** A dynamic var at display time. */
class Var {
  constructor(name, value, highlighted) {
    this.name = name;
    this.value = value;
    this.highlighted = highlighted;
  }
  toString() {
    return String(Math.trunc(this.value));
  }
  /** DynamicVar.ToHighlightedString + StsTextUtilities.HighlightChangeText. */
  highlightedString() {
    return this.highlighted ? `[green]${this}[/green]` : String(this);
  }
}

/* --------------------------------------------------- SmartFormat parse --- */

/** Parses a format string into literal / placeholder items, stopping at an unmatched "}". */
function parseFormat(text, start = 0) {
  const items = [];
  let literal = "";
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      if (literal) items.push(literal);
      literal = "";
      const [placeholder, next] = parsePlaceholder(text, i + 1);
      items.push(placeholder);
      i = next;
    } else if (c === "}") {
      break;
    } else {
      literal += c;
      i++;
    }
  }
  if (literal) items.push(literal);
  return [items, i];
}

/** `{selector[:formatter[(options)]][:format]}` starting after "{". */
function parsePlaceholder(text, start) {
  let i = start;
  while (i < text.length && text[i] !== ":" && text[i] !== "}") i++;
  const selector = text.slice(start, i);
  if (text[i] === "}") return [{ selector }, i + 1];
  i++; // ':'
  let formatter = null;
  let options = null;
  const m = /^([A-Za-z]+)(\(([^)]*)\))?(:|\})/.exec(text.slice(i));
  if (m && KNOWN_FORMATTERS.has(m[1])) {
    formatter = m[1];
    options = m[3] ?? null;
    i += m[0].length;
    if (m[4] === "}") return [{ selector, formatter, options, format: null }, i];
  }
  // The format runs to the matching "}"; split it at top-level "|".
  const formats = [];
  let current = [];
  let literal = "";
  while (i < text.length && text[i] !== "}") {
    if (text[i] === "{") {
      if (literal) current.push(literal);
      literal = "";
      const [inner, next] = parsePlaceholder(text, i + 1);
      current.push(inner);
      i = next;
    } else if (text[i] === "|") {
      if (literal) current.push(literal);
      literal = "";
      formats.push(current);
      current = [];
      i++;
    } else {
      literal += text[i++];
    }
  }
  if (literal) current.push(literal);
  formats.push(current);
  return [{ selector, formatter, options, format: formats }, i + 1];
}

/* ---------------------------------------------------- SmartFormat eval --- */

function evaluateItems(items, scope, current) {
  return items.map((item) => (typeof item === "string" ? item : evaluatePlaceholder(item, scope, current))).join("");
}

function lookup(selector, scope, current) {
  if (selector === "") return current;
  if (!(selector in scope)) throw new Error(`no value for {${selector}}`);
  return scope[selector];
}

function numeric(value) {
  if (value instanceof Var) return value.value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number(value);
}

function iconRun(count, value, icon) {
  if (count > 0 && count < 5) return icon.repeat(count);
  return `${value instanceof Var ? value.highlightedString() : count}${icon}`;
}

function evaluatePlaceholder(p, scope, current) {
  const value = lookup(p.selector, scope, current);
  const formats = p.format ?? [];
  const option = (index) => evaluateItems(formats[index] ?? [], scope, value);
  switch (p.formatter) {
    case "diff":
      if (!(value instanceof Var)) throw new Error(`diff() on non-var {${p.selector}}`);
      return value.highlightedString();
    case "inverseDiff":
      throw new Error("inverseDiff() is not supported");
    case "energyIcons": {
      if (typeof value === "string") return iconRun(Number(p.options), Number(p.options), energyIcon(value === "colorless" ? scope.__colorlessEnergy : value));
      return iconRun(Math.trunc(numeric(value)), value, energyIcon(scope.energyPrefix === "colorless" ? scope.__colorlessEnergy : scope.energyPrefix));
    }
    case "starIcons":
      return iconRun(Math.trunc(numeric(value)), value, STAR_ICON);
    case "show": {
      const display = value.display; // 0 normal, 1 upgraded, 2 upgrade preview
      if (display === 0) return option(1);
      if (display === 1) return option(0);
      return `[green]${option(0)}[/green]`;
    }
    case "plural": {
      // SmartFormat English: 2 forms -> 1 | other; 3 forms -> 0 | 1 | other.
      const n = numeric(value);
      if (formats.length >= 3) return option(n === 0 ? 0 : n === 1 ? 1 : 2);
      return option(n === 1 ? 0 : 1);
    }
    case "choose": {
      const choices = (p.options ?? "").split("|");
      const index = choices.indexOf(String(value instanceof Var ? value.toString() : value));
      return option(index === -1 ? choices.length : index);
    }
    case "cond":
    case null:
    default: {
      if (!p.format) return value instanceof Var ? value.toString() : String(value);
      // SmartFormat's conditional formatter, auto-detected.
      if (typeof value === "boolean") return option(value ? 0 : 1);
      if (typeof value === "string") return option(value ? 0 : 1);
      const n = numeric(value);
      if (formats.length === 1) return option(0);
      return option(n === 0 ? 0 : 1);
    }
  }
}

/* ------------------------------------------------------------- public --- */

/**
 * @param {object} card  an entry of card-data.json
 * @param {string} template  the localized description
 * @param {{ upgraded: boolean, keywordTitles: Record<string,string>, colorlessEnergy?: string }} options
 * @returns {string} BBCode
 */
export function cardDescription(card, template, { upgraded, keywordTitles, colorlessEnergy = "colorless" }) {
  const vars = new Map();
  for (const v of card.vars) {
    if (v.name == null || v.base == null) continue;
    const value = upgraded ? v.base + v.upgrade : v.base;
    vars.set(v.name, new Var(v.name, value, upgraded && v.upgraded));
  }
  // CalculatedVar: shows its CalculationBase var out of combat (Calculate()
  // multiplies the extra by 0 when no combat is in progress), and is marked
  // upgraded when that base changes (RecalculateForUpgradeOrEnchant).
  for (const v of card.vars) {
    if (!/^Calculated/.test(v.kind) || !vars.has("CalculationBase")) continue;
    const base = vars.get("CalculationBase");
    const baseVar = card.vars.find((x) => x.name === "CalculationBase");
    vars.set(v.name, new Var(v.name, base.value, upgraded && baseVar.upgrade !== 0));
  }
  const scope = {
    ...Object.fromEntries(vars),
    IfUpgraded: { display: upgraded ? 1 : 0 },
    OnTable: false,
    InCombat: false,
    IsTargeting: false,
    TargetType: card.target ?? "None",
    GainsBlock: false,
    IsOstyAlive: false,
    energyPrefix: card.energyIcon ?? "colorless",
    singleStarIcon: STAR_ICON,
    __colorlessEnergy: colorlessEnergy,
  };
  const [items] = parseFormat(template);
  const parts = [evaluateItems(items, scope, null)];
  const keywords = new Set(card.keywords);
  if (upgraded) {
    for (const k of card.upgrade.addKeywords) keywords.add(k);
    for (const k of card.upgrade.removeKeywords) keywords.delete(k);
  }
  const keywordLine = (k) => `[gold]${keywordTitles[k] ?? k}[/gold].`;
  for (const k of KEYWORDS_BEFORE) if (keywords.has(k)) parts.unshift(keywordLine(k));
  for (const k of KEYWORDS_AFTER) if (keywords.has(k)) parts.push(keywordLine(k));
  return parts.filter((p) => p !== "").join("\n");
}

/** BBCode -> plain text (icons dropped), for comparisons. */
export function plainText(bbcode) {
  return bbcode.replace(/\[img\][^[]*\[\/img\]/g, "").replace(/\[\/?[a-z]+\]/g, "");
}
