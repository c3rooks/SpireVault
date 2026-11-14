/**
 * A small symbolic evaluator for IL method bodies (see dotnet.mjs).
 *
 * It walks a method's instructions once, in order, keeping a stack of
 * expression nodes instead of values, and returns the statements the method
 * performs (calls whose result is discarded, field stores) and what it
 * returns. Constants fold (ints, strings, System.Decimal), arrays and the
 * compiler's collection-expression wrappers become plain lists, so a getter
 * such as `CanonicalVars => [new DamageVar(8m, ValueProp.Move), ...]` comes
 * back as a list of `new` nodes with constant arguments.
 *
 * Branches are not followed: a method with control flow is evaluated as if
 * every instruction ran, and `hasBranches` says so, so the caller can refuse
 * to trust anything that depends on it.
 */

import { methodBody, T } from "./dotnet.mjs";

const BRANCH_POP = {
  "brfalse.s": 1, "brtrue.s": 1, brfalse: 1, brtrue: 1, switch: 1,
  "beq.s": 2, "bge.s": 2, "bgt.s": 2, "ble.s": 2, "blt.s": 2, "bne.un.s": 2, "bge.un.s": 2, "bgt.un.s": 2, "ble.un.s": 2, "blt.un.s": 2,
  beq: 2, bge: 2, bgt: 2, ble: 2, blt: 2, "bne.un": 2, "bge.un": 2, "bgt.un": 2, "ble.un": 2, "blt.un": 2,
  "br.s": 0, br: 0, leave: 0, "leave.s": 0, endfinally: 0,
};
const BINARY = new Set(["add", "sub", "mul", "div", "rem", "and", "or", "xor", "shl", "shr", "shr.un", "ceq", "cgt", "cgt.un", "clt", "clt.un", "add.ovf", "sub.ovf", "mul.ovf", "div.un", "rem.un"]);

/** Node constructors. */
export const node = {
  const: (v) => ({ k: "const", v }),
  decimal: (v) => ({ k: "decimal", v }),
  unknown: (why) => ({ k: "unknown", why }),
};

/** Numeric value of a const / decimal node, else undefined. */
export function numberOf(n) {
  if (!n) return undefined;
  if (n.k === "decimal") return n.v;
  if (n.k === "const" && typeof n.v === "number") return n.v;
  if (n.k === "const" && typeof n.v === "boolean") return n.v ? 1 : 0;
  return undefined;
}

/** System.Decimal(lo, mid, hi, isNegative, scale) as a JS number. */
function decimalFromParts(lo, mid, hi, negative, scale) {
  const mag = (BigInt(hi >>> 0) << 64n) | (BigInt(mid >>> 0) << 32n) | BigInt(lo >>> 0);
  const value = Number(mag) / 10 ** scale;
  return negative ? -value : value;
}

function shortTypeName(name) {
  const plain = name.replace(/<.*$/, "");
  return plain.slice(Math.max(plain.lastIndexOf("."), plain.lastIndexOf("/")) + 1).replace(/`\d+$/, "");
}

/**
 * Evaluates a MethodDef.
 * @param {object} ctx  { asm, md }
 * @param {number} methodIndex  MethodDef row
 * @param {object[]} args  argument nodes (arg 0 = this for instance methods)
 * @param {{ typeArgs?: string[], fold?: Record<string, number> }} [generic]
 *   owner's generic arguments (for `!0`), and calls to fold to a constant,
 *   keyed "Owner::name" (e.g. CardModel::get_CurrentUpgradeLevel during an upgrade)
 */
export function evaluate(ctx, methodIndex, args, generic = {}) {
  const { asm, md } = ctx;
  const def = asm.row(T.MethodDef, methodIndex);
  if (!def.rva) return { statements: [], returns: [], hasBranches: false, empty: true };
  const body = methodBody(asm, def.rva);
  const stack = [];
  const locals = new Map();
  const statements = [];
  const returns = [];
  let hasBranches = false;
  const pop = () => (stack.length ? stack.pop() : node.unknown("stack underflow"));
  const popN = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.unshift(pop());
    return out;
  };
  const resolveTypeToken = (token) => {
    const table = token >>> 24;
    if (table === T.TypeSpec) {
      const name = md.tokenType(token);
      const m = name.match(/^!(\d+)$/);
      if (m && generic.typeArgs?.[Number(m[1])]) return generic.typeArgs[Number(m[1])];
      return name;
    }
    return md.tokenType(token);
  };

  for (const ins of body.instructions) {
    const { name, operand } = ins;
    if (name.startsWith("ldc.i4")) {
      const v = name === "ldc.i4.m1" ? -1 : name === "ldc.i4" || name === "ldc.i4.s" ? operand : Number(name.slice(7));
      stack.push(node.const(v));
      continue;
    }
    if (name === "ldc.i8") { stack.push(node.const(Number(operand))); continue; }
    if (name === "ldc.r4" || name === "ldc.r8") { stack.push(node.const(operand)); continue; }
    if (name === "ldstr") { stack.push(node.const(asm.userString(operand & 0xffffff))); continue; }
    if (name === "ldnull") { stack.push(node.const(null)); continue; }
    if (/^ldarg(\.|$)/.test(name)) {
      const i = name.includes(".s") || name === "ldarg" ? operand : Number(name.slice(6));
      stack.push(args[i] ?? node.unknown(`arg ${i}`));
      continue;
    }
    if (/^ldarga/.test(name)) { stack.push({ k: "argaddr", i: operand, value: args[operand] }); continue; }
    if (/^starg/.test(name)) { args[operand] = pop(); continue; }
    if (/^ldloc(\.|$)/.test(name)) {
      const i = name.includes(".s") || name === "ldloc" ? operand : Number(name.slice(6));
      stack.push(locals.get(i) ?? node.unknown(`local ${i}`));
      continue;
    }
    if (/^ldloca/.test(name)) { stack.push({ k: "localaddr", i: operand }); continue; }
    if (/^stloc/.test(name)) {
      const i = name.includes(".s") || name === "stloc" ? operand : Number(name.slice(6));
      locals.set(i, pop());
      continue;
    }
    if (name === "dup") { const top = pop(); stack.push(top, top); continue; }
    if (name === "pop") { statements.push(pop()); continue; }
    if (name === "nop" || name.endsWith(".") || name === "constrained.") continue;
    if (name in BRANCH_POP) { popN(BRANCH_POP[name]); hasBranches = true; continue; }
    if (name === "ret") {
      const sig = md.methodSig(asm.blob(def.signature));
      if (sig.ret !== "void") returns.push(pop());
      continue;
    }
    if (name.startsWith("conv.") || name === "box" || name === "unbox.any" || name === "castclass" || name === "isinst" || name === "ckfinite") continue;
    if (name === "neg") { const a = pop(); const v = numberOf(a); stack.push(v === undefined ? { k: "op", op: "neg", args: [a] } : { ...a, v: -v }); continue; }
    if (name === "not") { stack.push({ k: "op", op: "not", args: [pop()] }); continue; }
    if (BINARY.has(name)) {
      const [a, b] = popN(2);
      const x = numberOf(a);
      const y = numberOf(b);
      if (x !== undefined && y !== undefined && a.k === "const" && b.k === "const") {
        const r = { add: x + y, sub: x - y, mul: x * y, ceq: Number(x === y), cgt: Number(x > y), clt: Number(x < y), and: x & y, or: x | y }[name];
        if (r !== undefined) { stack.push(node.const(r)); continue; }
      }
      stack.push({ k: "op", op: name, args: [a, b] });
      continue;
    }
    if (name === "ldtoken") {
      const table = operand >>> 24;
      if (table === T.Field) stack.push({ k: "fieldtoken", field: operand & 0xffffff });
      else if (table === T.MethodDef || table === T.MemberRef) stack.push({ k: "methodtoken", ref: md.methodRef(operand) });
      else stack.push({ k: "typetoken", type: resolveTypeToken(operand) });
      continue;
    }
    if (name === "ldftn" || name === "ldvirtftn") {
      if (name === "ldvirtftn") pop();
      stack.push({ k: "ftn", ref: md.methodRef(operand) });
      continue;
    }
    if (name === "newarr") {
      const length = numberOf(pop());
      stack.push({ k: "array", type: resolveTypeToken(operand), items: new Array(length ?? 0).fill(null) });
      continue;
    }
    if (name.startsWith("stelem")) {
      const [array, index, value] = popN(3);
      if (array.k === "array" && numberOf(index) !== undefined) array.items[numberOf(index)] = value;
      else statements.push({ k: "stelem", array, index, value });
      continue;
    }
    if (name.startsWith("ldelem")) {
      const [array, index] = popN(2);
      stack.push(array.k === "array" && numberOf(index) !== undefined ? array.items[numberOf(index)] ?? node.unknown("ldelem") : { k: "ldelem", array, index });
      continue;
    }
    if (name === "ldlen") {
      const array = pop();
      stack.push(array.k === "array" ? node.const(array.items.length) : { k: "op", op: "ldlen", args: [array] });
      continue;
    }
    if (name === "initobj") {
      const address = pop();
      if (address.k === "localaddr") locals.set(address.i, { k: "default", type: resolveTypeToken(operand) });
      continue;
    }
    if (name === "ldsfld" || name === "ldsflda") {
      const f = md.fieldRef(operand);
      if (f.owner === "System.Decimal" && f.name in { One: 1, Zero: 1, MinusOne: 1 }) {
        stack.push(node.decimal({ One: 1, Zero: 0, MinusOne: -1 }[f.name]));
      } else if (f.owner === "System.String" && f.name === "Empty") {
        stack.push(node.const(""));
      } else {
        stack.push({ k: "field", owner: f.owner, name: f.name, def: f.def, static: true });
      }
      continue;
    }
    if (name === "ldfld" || name === "ldflda") {
      const obj = pop();
      const f = md.fieldRef(operand);
      stack.push({ k: "field", owner: f.owner, name: f.name, def: f.def, obj });
      continue;
    }
    if (name === "stfld") {
      const [obj, value] = popN(2);
      const f = md.fieldRef(operand);
      statements.push({ k: "stfld", owner: f.owner, name: f.name, obj, value });
      continue;
    }
    if (name === "stsfld") {
      const f = md.fieldRef(operand);
      statements.push({ k: "stsfld", owner: f.owner, name: f.name, value: pop() });
      continue;
    }
    if (name === "newobj") {
      const ref = md.methodRef(operand);
      const callArgs = popN(ref.sig.count);
      stack.push(construct(ref, callArgs));
      continue;
    }
    if (name === "call" || name === "callvirt") {
      const ref = md.methodRef(operand);
      const callArgs = popN(ref.sig.count + (ref.sig.hasThis ? 1 : 0));
      const folded = generic.fold?.[`${ref.owner}::${ref.name}`];
      const result = folded !== undefined ? node.const(folded) : callNode(ctx, ref, callArgs);
      if (result.k === "initarray") continue;
      if (ref.sig.ret === "void") statements.push(result);
      else stack.push(result);
      continue;
    }
    if (name === "throw") { statements.push({ k: "throw", value: pop() }); continue; }
    // Anything else: keep the stack shape honest with an unknown.
    statements.push(node.unknown(`unhandled ${name}`));
  }
  return { statements, returns, hasBranches, locals };
}

/** newobj: decimals and the compiler's read-only collection wrappers fold. */
function construct(ref, args) {
  if (ref.owner === "System.Decimal") {
    if (args.length === 1 && numberOf(args[0]) !== undefined) return node.decimal(numberOf(args[0]));
    if (args.length === 5 && args.every((a) => numberOf(a) !== undefined)) {
      const [lo, mid, hi, negative, scale] = args.map(numberOf);
      return node.decimal(decimalFromParts(lo, mid, hi, Boolean(negative), scale));
    }
  }
  if (/^<>z__ReadOnlyArray`1/.test(ref.owner) && args[0]?.k === "array") return args[0];
  if (/^<>z__ReadOnlySingleElementList`1/.test(ref.owner)) return { k: "array", type: ref.owner, items: [args[0]] };
  if (/^<>z__ReadOnlyList`1/.test(ref.owner) && args[0]?.k === "list") return { k: "array", type: ref.owner, items: args[0].items };
  if (/^System\.Collections\.Generic\.(List|HashSet)`1/.test(ref.owner)) return { k: "list", type: ref.owner, items: [] };
  return { k: "new", type: ref.owner, ref, args };
}

/** call / callvirt: a few framework helpers fold, everything else stays a call node. */
function callNode(ctx, ref, args) {
  const { asm, md } = ctx;
  if (ref.owner === "System.Decimal" && ref.name === "op_Implicit" && numberOf(args[0]) !== undefined) return node.decimal(numberOf(args[0]));
  if (ref.owner === "System.Type" && ref.name === "GetTypeFromHandle") return args[0];
  if (ref.owner === "System.Reflection.MemberInfo" && ref.name === "get_Name" && args[0]?.k === "typetoken") {
    return node.const(shortTypeName(args[0].type));
  }
  if (ref.owner === "System.Array" && ref.name === "Empty") return { k: "array", type: ref.genericArgs[0], items: [] };
  if (ref.owner === "System.Runtime.CompilerServices.RuntimeHelpers" && ref.name === "InitializeArray") {
    const [array, token] = args;
    const rva = token?.k === "fieldtoken" ? md.fieldRva.get(token.field) : undefined;
    if (array?.k === "array" && rva !== undefined) {
      const at = asm.offset(rva);
      // Every array this extractor initialises this way is of an int-backed enum.
      for (let i = 0; i < array.items.length; i++) array.items[i] = node.const(asm.buf.readInt32LE(at + i * 4));
      return { k: "initarray" };
    }
  }
  if (/^System\.Collections\.Generic\.(List|HashSet)`1/.test(ref.owner) && ref.name === "Add" && args[0]?.k === "list") {
    args[0].items.push(args[1]);
    return { k: "initarray" };
  }
  return { k: "call", owner: ref.owner, name: ref.name, ref, args };
}
