#!/usr/bin/env node
/**
 * Extracts every card's printed data from Slay the Spire 2's compiled code
 * (sts2.dll) into card-data.json, for build-card-faces.mjs.
 *
 * What a card face prints that the resource pack does not have: energy cost
 * (or X, or none), star cost, type, rarity, keywords and the numbers its rules
 * text substitutes, base and upgraded. In the game each card is a C# class:
 *
 *   ctor            base(cost, CardType, CardRarity, TargetType, showInLibrary)
 *   CanonicalVars   [new DamageVar(8m, ...), new PowerVar<VulnerablePower>(2m), ...]
 *   CanonicalKeywords, HasEnergyCostX, CanonicalStarCost, HasStarCostX
 *   OnUpgrade       DynamicVars.Damage.UpgradeValueBy(2m); EnergyCost.UpgradeBy(-1);
 *                   AddKeyword(...); RemoveKeyword(...)
 *
 * This reads those methods' IL without running anything (dotnet.mjs parses
 * the assembly, il-eval.mjs folds the IL into expressions) and keeps only the
 * resulting data. A value that is not a constant in the IL is never guessed:
 * the card gets a `problems` entry instead, and build-card-faces.mjs refuses
 * to print text that depends on it.
 *
 *   node scripts/sts2-pck/extract-card-data.mjs [path/to/sts2.dll] [--out file]
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAssembly, metadataIndex } from "./dotnet.mjs";
import { evaluate, numberOf } from "./il-eval.mjs";
import { arg } from "./pck.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DLL = `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Slay the Spire 2/SlayTheSpire2.app/Contents/Resources/data_sts2_macos_arm64/sts2.dll`;
const NS = "MegaCrit.Sts2.Core";
const CARD_MODEL = `${NS}.Models.CardModel`;
const DYNAMIC_VAR = `${NS}.Localization.DynamicVars.DynamicVar`;
const GAME_BUILD = "v0.113.0";

/** CardModel overrides read as constants: [getter, output field]. */
const CONSTANT_OVERRIDES = [
  ["get_HasEnergyCostX", "costX"],
  ["get_CanonicalStarCost", "starCost"],
  ["get_HasStarCostX", "starCostX"],
  ["get_MaxUpgradeLevel", "maxUpgradeLevel"],
  ["get_IsPlayable", "playable"],
];

/**
 * Values that are not IL constants but are fixed by code that runs before a
 * card is shown, each read by hand from the IL named here. Keep this short.
 */
const KNOWN_NON_CONSTANTS = {
  // ShowOff.CanonicalVars: PowerVar<AimPower>(CurrentAim). CurrentAim is set by
  // UpdateAim() = DynamicVars["BaseAim"].IntValue + IncreasedAim, and
  // IncreasedAim starts at 0 (only AfterCombatEnd raises it), so a fresh card
  // shows BaseAim. Resolved below from the BaseAim var.
  "ShowOff:AimPower": (vars) => vars.find((v) => v.name === "BaseAim")?.base,
};

function shortName(full) {
  const plain = full.replace(/<.*$/, "");
  return plain.slice(Math.max(plain.lastIndexOf("."), plain.lastIndexOf("/")) + 1).replace(/`\d+$/, "");
}

function main() {
  const dllPath = process.argv.slice(2).find((a) => a.endsWith(".dll")) || DEFAULT_DLL;
  const outPath = arg("out", join(HERE, "card-data.json"));
  const asm = openAssembly(dllPath);
  const md = metadataIndex(asm);
  const ctx = { asm, md };

  const enumOf = (name) => md.enumMembers(`${NS}.Entities.Cards.${name}`);
  const CARD_TYPE = enumOf("CardType");
  const RARITY = enumOf("CardRarity");
  const TARGET = enumOf("TargetType");
  const KEYWORD = enumOf("CardKeyword");

  const isSubclassOf = (typeIndex, base) => {
    for (let i = typeIndex, guard = 0; i && guard < 20; guard++) {
      const parent = md.extendsName(i);
      if (parent === base) return true;
      i = md.byName.get(parent);
    }
    return false;
  };
  const methodNamed = (typeIndex, name) => md.methodsOf(typeIndex).find((m) => m.name === name);

  /** DynamicVarSet.get_Damage etc. -> the var name each looks up. */
  const varSetGetters = new Map();
  const varSet = md.byName.get(`${NS}.Localization.DynamicVars.DynamicVarSet`);
  for (const m of md.methodsOf(varSet)) {
    if (!m.name.startsWith("get_") || m.name === "get_Item" || m.name === "get_Count") continue;
    const r = evaluate(ctx, m.index, [{ k: "this" }]);
    const ret = r.returns[0];
    if (ret?.k === "call" && ret.name === "get_Item" && ret.args[1]?.k === "const") varSetGetters.set(m.name, ret.args[1].v);
  }

  /**
   * A `new XVar(args)` node -> { name, base } by following its constructors
   * down to DynamicVar(string name, decimal baseValue).
   */
  const resolveVar = (n, depth = 0) => {
    if (depth > 6) return { problem: "constructor chain too deep" };
    if (n?.k === "call" && n.args[0]?.k === "new" && /WithMultiplier|FromOsty/.test(n.name)) return resolveVar(n.args[0], depth);
    if (n?.k !== "new") return { problem: `not a constructor (${n?.k})` };
    if (n.type === DYNAMIC_VAR) return { name: n.args[0], base: n.args[1] };
    if (!n.ref.def) return { problem: `unresolved constructor ${n.type}` };
    const typeArgs = n.ref.ownerArgs ?? [];
    const self = { k: "self" };
    const r = evaluate(ctx, n.ref.def, [self, ...n.args], { typeArgs });
    const chained = r.statements.find((s) => s.k === "call" && s.name === ".ctor" && s.args[0] === self);
    if (!chained) return { problem: `no base constructor call in ${n.type}` };
    return resolveVar({ k: "new", type: chained.owner, ref: chained.ref, args: chained.args.slice(1) }, depth + 1);
  };

  /** OnUpgrade target expression -> var name. */
  const varNameOf = (target) => {
    if (target?.k !== "call") return null;
    if (target.name === "get_Item" && target.args[1]?.k === "const") return target.args[1].v;
    if (varSetGetters.has(target.name)) return varSetGetters.get(target.name);
    return null;
  };

  /** Card pools: class name -> pool's energy colour, cost outline colour and frame material. */
  const pools = new Map();
  const poolModel = md.byName.get(`${NS}.Models.CardPoolModel`);
  for (const [name, index] of md.byName) {
    if (md.extendsName(index) !== `${NS}.Models.CardPoolModel`) continue;
    const constant = (getter, owner = index) => {
      const m = methodNamed(owner, getter);
      let v = m && evaluate(ctx, m.index, [{ k: "this" }]).returns[0];
      if (v?.k === "new" && v.type === "Godot.Color" && v.args[0]?.k === "const") v = v.args[0]; // new Color("5a4411")
      return v?.k === "const" ? v.v : null;
    };
    const pool = {
      pool: shortName(name).replace(/CardPool$/, ""),
      energy: constant("get_EnergyColorName"),
      frame: constant("get_CardFrameMaterialPath"),
      // CardPoolModel.EnergyOutlineColor: the cost number's outline (NCard.UpdateEnergyCostColor).
      energyOutline: constant("get_EnergyOutlineColor") ?? constant("get_EnergyOutlineColor", poolModel),
    };
    const generate = methodNamed(index, "GenerateAllCards");
    if (!generate) continue;
    const r = evaluate(ctx, generate.index, [{ k: "this" }]);
    for (const ret of r.returns) {
      for (const item of ret?.items ?? []) {
        if (item?.k === "call" && item.name === "Card" && item.ref.genericArgs[0]) {
          const cls = item.ref.genericArgs[0];
          if (!pools.has(cls)) pools.set(cls, []);
          pools.get(cls).push(pool);
        }
      }
    }
  }

  const cards = {};
  for (const [className, typeIndex] of md.byName) {
    if (!className.startsWith(`${NS}.Models.Cards.`) || !isSubclassOf(typeIndex, CARD_MODEL)) continue;
    if (/\.Mocks\.|Deprecated/.test(className)) continue;
    const cls = shortName(className);
    const problems = [];
    const card = { class: cls };

    // Constructor -> base(cost, type, rarity, target, showInLibrary).
    const ctor = methodNamed(typeIndex, ".ctor");
    const base = ctor && evaluate(ctx, ctor.index, [{ k: "this" }]).statements.find((s) => s.k === "call" && s.name === ".ctor" && s.owner === CARD_MODEL);
    if (!base) {
      problems.push("constructor does not call CardModel(cost, type, rarity, target, bool) directly");
    } else {
      const [, cost, type, rarity, target] = base.args;
      card.cost = numberOf(cost) ?? null;
      card.type = CARD_TYPE.get(numberOf(type)) ?? null;
      card.rarity = RARITY.get(numberOf(rarity)) ?? null;
      card.target = TARGET.get(numberOf(target)) ?? null;
      for (const [field, value] of [["cost", card.cost], ["type", card.type], ["rarity", card.rarity]]) {
        if (value == null) problems.push(`${field} is not a constant`);
      }
    }

    for (const [getter, field] of CONSTANT_OVERRIDES) {
      const m = methodNamed(typeIndex, getter);
      if (!m) continue;
      const r = evaluate(ctx, m.index, [{ k: "this" }]);
      const v = numberOf(r.returns[0]);
      if (r.hasBranches || r.returns.length !== 1 || v === undefined) problems.push(`${getter} is not a constant`);
      else card[field] = field === "costX" || field === "starCostX" || field === "playable" ? Boolean(v) : v;
    }

    // Keywords.
    const kw = methodNamed(typeIndex, "get_CanonicalKeywords");
    card.keywords = [];
    if (kw) {
      const r = evaluate(ctx, kw.index, [{ k: "this" }]);
      const items = r.returns[0]?.items;
      if (r.hasBranches || !items || items.some((i) => numberOf(i) === undefined)) problems.push("CanonicalKeywords is not a constant list");
      else card.keywords = items.map((i) => KEYWORD.get(numberOf(i)));
    }

    // Dynamic vars.
    card.vars = [];
    const cv = methodNamed(typeIndex, "get_CanonicalVars");
    if (cv) {
      const r = evaluate(ctx, cv.index, [{ k: "this" }]);
      const items = r.returns.length === 1 ? r.returns[0]?.items : null;
      if (!items) problems.push("CanonicalVars is not a list");
      for (const item of items ?? []) {
        const v = resolveVar(item);
        if (v.problem) {
          problems.push(`var: ${v.problem}`);
          continue;
        }
        const name = v.name?.k === "const" ? v.name.v : null;
        let baseValue = numberOf(v.base);
        if (name && baseValue === undefined && KNOWN_NON_CONSTANTS[`${cls}:${name}`]) baseValue = KNOWN_NON_CONSTANTS[`${cls}:${name}`](card.vars);
        const kind = shortName(item.k === "call" ? item.args[0].type : item.type);
        if (!name) problems.push(`a ${kind} has a non-constant name`);
        else if (baseValue === undefined) problems.push(`${name} has a non-constant base value`);
        card.vars.push({ name, kind, base: baseValue ?? null, upgrade: 0, upgraded: false });
      }
    }

    // Upgrade.
    card.upgrade = { cost: 0, starCost: 0, addKeywords: [], removeKeywords: [] };
    const up = methodNamed(typeIndex, "OnUpgrade");
    if (up) {
      // The faces show the first upgrade: CardModel.UpgradeInternal raises
      // CurrentUpgradeLevel to 1 before it calls OnUpgrade (Dingy Dagger reads it).
      const r = evaluate(ctx, up.index, [{ k: "this" }], { fold: { [`${CARD_MODEL}::get_CurrentUpgradeLevel`]: 1 } });
      for (const s of r.statements) {
        if (s.k !== "call") continue;
        if (s.name === "UpgradeValueBy") {
          const name = varNameOf(s.args[0]);
          const delta = numberOf(s.args[1]);
          const v = card.vars.find((x) => x.name === name);
          if (!v || delta === undefined) problems.push(`upgrade of ${name ?? "an unknown var"} by ${delta ?? "a non-constant"}`);
          else {
            v.upgrade += delta;
            v.upgraded = true;
          }
        } else if (s.name === "UpgradeBy" && /CardEnergyCost$/.test(s.owner)) {
          const delta = numberOf(s.args[1]);
          if (delta === undefined) problems.push("energy cost upgrade is not a constant");
          else card.upgrade.cost += delta;
        } else if (s.name === "UpgradeStarCostBy") {
          const delta = numberOf(s.args[1]);
          if (delta === undefined) problems.push("star cost upgrade is not a constant");
          else card.upgrade.starCost += delta;
        } else if (s.name === "AddKeyword" || s.name === "RemoveKeyword") {
          const k = KEYWORD.get(numberOf(s.args[1]));
          if (!k) problems.push(`${s.name} of a non-constant keyword`);
          else card.upgrade[s.name === "AddKeyword" ? "addKeywords" : "removeKeywords"].push(k);
        } else if (s.name === "get_DynamicVars" || s.name === "OnUpgrade") {
          // base.OnUpgrade() and bare property reads are harmless.
        } else if (s.owner === className && s.name === "UpdateAim") {
          // ShowOff: recomputes CurrentAim from BaseAim, which upgrading does not change.
        } else {
          problems.push(`OnUpgrade calls ${shortName(s.owner)}.${s.name}`);
        }
      }
    }

    const poolList = pools.get(className) ?? [];
    if (poolList.length) {
      card.pool = poolList[0].pool;
      card.energyIcon = poolList[0].energy;
      card.energyOutline = poolList[0].energyOutline;
      card.frame = poolList[0].frame;
      if (poolList.length > 1) card.otherPools = poolList.slice(1).map((p) => p.pool);
    } else {
      problems.push("in no card pool");
    }
    if (problems.length) card.problems = problems;
    // CardModel's ModelId entry: the class name in SCREAMING_SNAKE case.
    const id = cls.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toUpperCase();
    cards[id] = card;
  }

  const source = `Read from Slay the Spire 2 ${GAME_BUILD} sts2.dll (assembly IL, not run) by scripts/sts2-pck/extract-card-data.mjs. ` +
    "Per card (keyed by its localization id): energy cost (-1 = no cost orb), costX, star cost, type, rarity, target, keywords, " +
    "every dynamic var's base value and first-upgrade delta (upgraded = OnUpgrade touches it), upgrade cost/keyword changes, " +
    "and the pool's energy icon, cost outline colour and frame material. Regenerate after a game patch.";
  // One card per line keeps diffs after a patch readable.
  const lines = Object.keys(cards).sort().map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(cards[id])}`);
  writeFileSync(outPath, `{\n  "_source": ${JSON.stringify(source)},\n  "cards": {\n${lines.map((l) => `  ${l}`).join(",\n")}\n  }\n}\n`);
  const withProblems = Object.entries(cards).filter(([, c]) => c.problems);
  process.stdout.write(`${Object.keys(cards).length} cards -> ${outPath}; ${withProblems.length} with problems\n`);
  for (const [id, c] of withProblems) process.stdout.write(`  ${id}: ${c.problems.join("; ")}\n`);
}

main();
