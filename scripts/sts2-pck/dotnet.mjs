/**
 * Read-only access to a .NET assembly's metadata and IL (ECMA-335), enough to
 * read constant values out of Slay the Spire 2's sts2.dll without running it.
 *
 * Used by extract-card-data.mjs. It parses the PE file, the metadata tables
 * and method bodies, and decodes IL into instruction lists. Nothing here
 * executes or loads the assembly; it only reads bytes.
 */

import { readFileSync } from "node:fs";

/** Metadata table numbers (ECMA-335 II.22). */
export const T = Object.freeze({
  Module: 0x00, TypeRef: 0x01, TypeDef: 0x02, FieldPtr: 0x03, Field: 0x04, MethodPtr: 0x05, MethodDef: 0x06,
  ParamPtr: 0x07, Param: 0x08, InterfaceImpl: 0x09, MemberRef: 0x0a, Constant: 0x0b, CustomAttribute: 0x0c,
  FieldMarshal: 0x0d, DeclSecurity: 0x0e, ClassLayout: 0x0f, FieldLayout: 0x10, StandAloneSig: 0x11,
  EventMap: 0x12, EventPtr: 0x13, Event: 0x14, PropertyMap: 0x15, PropertyPtr: 0x16, Property: 0x17,
  MethodSemantics: 0x18, MethodImpl: 0x19, ModuleRef: 0x1a, TypeSpec: 0x1b, ImplMap: 0x1c, FieldRVA: 0x1d,
  EncLog: 0x1e, EncMap: 0x1f, Assembly: 0x20, AssemblyProcessor: 0x21, AssemblyOS: 0x22, AssemblyRef: 0x23,
  AssemblyRefProcessor: 0x24, AssemblyRefOS: 0x25, File: 0x26, ExportedType: 0x27, ManifestResource: 0x28,
  NestedClass: 0x29, GenericParam: 0x2a, MethodSpec: 0x2b, GenericParamConstraint: 0x2c,
});

/** Coded index kinds: [tag bits, tables (null = unused tag)]. */
const CODED = Object.freeze({
  TypeDefOrRef: [2, [T.TypeDef, T.TypeRef, T.TypeSpec]],
  HasConstant: [2, [T.Field, T.Param, T.Property]],
  HasCustomAttribute: [5, [T.MethodDef, T.Field, T.TypeRef, T.TypeDef, T.Param, T.InterfaceImpl, T.MemberRef, T.Module,
    T.DeclSecurity, T.Property, T.Event, T.StandAloneSig, T.ModuleRef, T.TypeSpec, T.Assembly, T.AssemblyRef, T.File,
    T.ExportedType, T.ManifestResource, T.GenericParam, T.GenericParamConstraint, T.MethodSpec]],
  HasFieldMarshal: [1, [T.Field, T.Param]],
  HasDeclSecurity: [2, [T.TypeDef, T.MethodDef, T.Assembly]],
  MemberRefParent: [3, [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec]],
  HasSemantics: [1, [T.Event, T.Property]],
  MethodDefOrRef: [1, [T.MethodDef, T.MemberRef]],
  MemberForwarded: [1, [T.Field, T.MethodDef]],
  Implementation: [2, [T.File, T.AssemblyRef, T.ExportedType]],
  CustomAttributeType: [3, [null, null, T.MethodDef, T.MemberRef, null]],
  ResolutionScope: [2, [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef]],
  TypeOrMethodDef: [1, [T.TypeDef, T.MethodDef]],
});

/** Column schemas. Types: u8 u16 u32 str guid blob, a table number (simple index), or a CODED key. */
const SCHEMA = {
  [T.Module]: [["generation", "u16"], ["name", "str"], ["mvid", "guid"], ["encId", "guid"], ["encBaseId", "guid"]],
  [T.TypeRef]: [["scope", "ResolutionScope"], ["name", "str"], ["namespace", "str"]],
  [T.TypeDef]: [["flags", "u32"], ["name", "str"], ["namespace", "str"], ["extends", "TypeDefOrRef"], ["fieldList", T.Field], ["methodList", T.MethodDef]],
  [T.FieldPtr]: [["field", T.Field]],
  [T.Field]: [["flags", "u16"], ["name", "str"], ["signature", "blob"]],
  [T.MethodPtr]: [["method", T.MethodDef]],
  [T.MethodDef]: [["rva", "u32"], ["implFlags", "u16"], ["flags", "u16"], ["name", "str"], ["signature", "blob"], ["paramList", T.Param]],
  [T.ParamPtr]: [["param", T.Param]],
  [T.Param]: [["flags", "u16"], ["sequence", "u16"], ["name", "str"]],
  [T.InterfaceImpl]: [["class", T.TypeDef], ["interface", "TypeDefOrRef"]],
  [T.MemberRef]: [["class", "MemberRefParent"], ["name", "str"], ["signature", "blob"]],
  [T.Constant]: [["type", "u8"], ["pad", "u8"], ["parent", "HasConstant"], ["value", "blob"]],
  [T.CustomAttribute]: [["parent", "HasCustomAttribute"], ["type", "CustomAttributeType"], ["value", "blob"]],
  [T.FieldMarshal]: [["parent", "HasFieldMarshal"], ["nativeType", "blob"]],
  [T.DeclSecurity]: [["action", "u16"], ["parent", "HasDeclSecurity"], ["permissionSet", "blob"]],
  [T.ClassLayout]: [["packingSize", "u16"], ["classSize", "u32"], ["parent", T.TypeDef]],
  [T.FieldLayout]: [["offset", "u32"], ["field", T.Field]],
  [T.StandAloneSig]: [["signature", "blob"]],
  [T.EventMap]: [["parent", T.TypeDef], ["eventList", T.Event]],
  [T.EventPtr]: [["event", T.Event]],
  [T.Event]: [["flags", "u16"], ["name", "str"], ["type", "TypeDefOrRef"]],
  [T.PropertyMap]: [["parent", T.TypeDef], ["propertyList", T.Property]],
  [T.PropertyPtr]: [["property", T.Property]],
  [T.Property]: [["flags", "u16"], ["name", "str"], ["type", "blob"]],
  [T.MethodSemantics]: [["semantics", "u16"], ["method", T.MethodDef], ["association", "HasSemantics"]],
  [T.MethodImpl]: [["class", T.TypeDef], ["body", "MethodDefOrRef"], ["declaration", "MethodDefOrRef"]],
  [T.ModuleRef]: [["name", "str"]],
  [T.TypeSpec]: [["signature", "blob"]],
  [T.ImplMap]: [["flags", "u16"], ["member", "MemberForwarded"], ["importName", "str"], ["scope", T.ModuleRef]],
  [T.FieldRVA]: [["rva", "u32"], ["field", T.Field]],
  [T.EncLog]: [["token", "u32"], ["func", "u32"]],
  [T.EncMap]: [["token", "u32"]],
  [T.Assembly]: [["hashAlg", "u32"], ["major", "u16"], ["minor", "u16"], ["build", "u16"], ["revision", "u16"], ["flags", "u32"], ["publicKey", "blob"], ["name", "str"], ["culture", "str"]],
  [T.AssemblyProcessor]: [["processor", "u32"]],
  [T.AssemblyOS]: [["platform", "u32"], ["major", "u32"], ["minor", "u32"]],
  [T.AssemblyRef]: [["major", "u16"], ["minor", "u16"], ["build", "u16"], ["revision", "u16"], ["flags", "u32"], ["publicKey", "blob"], ["name", "str"], ["culture", "str"], ["hash", "blob"]],
  [T.AssemblyRefProcessor]: [["processor", "u32"], ["ref", T.AssemblyRef]],
  [T.AssemblyRefOS]: [["platform", "u32"], ["major", "u32"], ["minor", "u32"], ["ref", T.AssemblyRef]],
  [T.File]: [["flags", "u32"], ["name", "str"], ["hash", "blob"]],
  [T.ExportedType]: [["flags", "u32"], ["typeDefId", "u32"], ["name", "str"], ["namespace", "str"], ["implementation", "Implementation"]],
  [T.ManifestResource]: [["offset", "u32"], ["flags", "u32"], ["name", "str"], ["implementation", "Implementation"]],
  [T.NestedClass]: [["nested", T.TypeDef], ["enclosing", T.TypeDef]],
  [T.GenericParam]: [["number", "u16"], ["flags", "u16"], ["owner", "TypeOrMethodDef"], ["name", "str"]],
  [T.MethodSpec]: [["method", "MethodDefOrRef"], ["instantiation", "blob"]],
  [T.GenericParamConstraint]: [["owner", T.GenericParam], ["constraint", "TypeDefOrRef"]],
};

/** Reads an ECMA-335 compressed unsigned integer. */
export function readCompressed(buf, at) {
  const b = buf[at];
  if ((b & 0x80) === 0) return [b, at + 1];
  if ((b & 0xc0) === 0x80) return [((b & 0x3f) << 8) | buf[at + 1], at + 2];
  return [((b & 0x1f) << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3], at + 4];
}

/**
 * Opens an assembly.
 * @param {string} path
 */
export function openAssembly(path) {
  const buf = readFileSync(path);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new Error(`${path} is not a PE file`);
  const sectionCount = buf.readUInt16LE(pe + 6);
  const optionalSize = buf.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = buf.readUInt16LE(optional);
  const dataDirs = optional + (magic === 0x20b ? 112 : 96);
  const sections = [];
  for (let i = 0, at = optional + optionalSize; i < sectionCount; i++, at += 40) {
    sections.push({ va: buf.readUInt32LE(at + 12), size: Math.max(buf.readUInt32LE(at + 8), buf.readUInt32LE(at + 16)), raw: buf.readUInt32LE(at + 20) });
  }
  const offset = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
    return rva - s.va + s.raw;
  };
  const cli = offset(buf.readUInt32LE(dataDirs + 14 * 8));
  const root = offset(buf.readUInt32LE(cli + 8));
  if (buf.readUInt32LE(root) !== 0x424a5342) throw new Error("no CLI metadata root");
  const versionLength = buf.readUInt32LE(root + 12);
  let at = root + 16 + versionLength + 2;
  const streamCount = buf.readUInt16LE(at);
  at += 2;
  const streams = {};
  for (let i = 0; i < streamCount; i++) {
    const off = buf.readUInt32LE(at);
    const size = buf.readUInt32LE(at + 4);
    at += 8;
    let end = at;
    while (buf[end] !== 0) end++;
    const name = buf.toString("latin1", at, end);
    at = (end + 4) & ~3;
    streams[name] = { start: root + off, size };
  }
  const tilde = streams["#~"] ?? streams["#-"];
  const heapSizes = buf[tilde.start + 6];
  const valid = buf.readBigUInt64LE(tilde.start + 8);
  const rows = new Array(64).fill(0);
  at = tilde.start + 24;
  for (let i = 0; i < 64; i++) {
    if (valid & (1n << BigInt(i))) {
      rows[i] = buf.readUInt32LE(at);
      at += 4;
    }
  }
  if (heapSizes & 0x40) at += 4;
  const sizes = { str: heapSizes & 1 ? 4 : 2, guid: heapSizes & 2 ? 4 : 2, blob: heapSizes & 4 ? 4 : 2, u8: 1, u16: 2, u32: 4 };
  const colSize = (type) => {
    if (typeof type === "number") return rows[type] < 0x10000 ? 2 : 4;
    if (sizes[type]) return sizes[type];
    const [bits, tables] = CODED[type];
    const max = Math.max(...tables.map((t) => (t == null ? 0 : rows[t])));
    return max < 1 << (16 - bits) ? 2 : 4;
  };
  const tables = {};
  for (let t = 0; t < 64; t++) {
    if (!rows[t]) continue;
    const schema = SCHEMA[t];
    if (!schema) throw new Error(`metadata table 0x${t.toString(16)} has no schema`);
    const cols = schema.map(([name, type]) => ({ name, type, size: colSize(type) }));
    const rowSize = cols.reduce((n, c) => n + c.size, 0);
    tables[t] = { start: at, rowSize, count: rows[t], cols };
    at += rowSize * rows[t];
  }

  const strings = streams["#Strings"];
  const blobs = streams["#Blob"];
  const us = streams["#US"];
  const stringCache = new Map();
  const str = (index) => {
    if (!stringCache.has(index)) {
      let end = strings.start + index;
      while (buf[end] !== 0) end++;
      stringCache.set(index, buf.toString("utf8", strings.start + index, end));
    }
    return stringCache.get(index);
  };
  const blob = (index) => {
    const [length, start] = readCompressed(buf, blobs.start + index);
    return buf.subarray(start, start + length);
  };
  const userString = (index) => {
    const [length, start] = readCompressed(buf, us.start + index);
    return buf.toString("utf16le", start, start + length - 1);
  };
  const decodeCoded = (type, value) => {
    const [bits, list] = CODED[type];
    return { table: list[value & ((1 << bits) - 1)], row: value >>> bits };
  };
  const rowCache = new Map();
  /** One table row (1-based), columns decoded; heap values stay indexes except strings. */
  const row = (table, index) => {
    const key = table * 0x1000000 + index;
    if (rowCache.has(key)) return rowCache.get(key);
    const info = tables[table];
    if (!info || index < 1 || index > info.count) throw new Error(`row ${index} of table 0x${table.toString(16)} does not exist`);
    let p = info.start + (index - 1) * info.rowSize;
    const out = { table, index };
    for (const c of info.cols) {
      const v = c.size === 1 ? buf[p] : c.size === 2 ? buf.readUInt16LE(p) : buf.readUInt32LE(p);
      p += c.size;
      if (c.type === "str") out[c.name] = str(v);
      else if (typeof c.type === "string" && CODED[c.type]) out[c.name] = decodeCoded(c.type, v);
      else out[c.name] = v;
    }
    rowCache.set(key, out);
    return out;
  };
  const count = (table) => tables[table]?.count ?? 0;

  return { buf, offset, rows, row, count, blob, userString, str };
}

/* ---------------------------------------------------------------- IL --- */

/** Operand kinds: 0 none, 'i1' 'u1' 'i4' 'i8' 'r4' 'r8' 'tok' 'br1' 'br4' 'sw' 'u2'. */
const ONE = {};
const TWO = {};
function op(table, code, name, operand = 0) {
  table[code] = { name, operand };
}
[
  [0x00, "nop"], [0x01, "break"], [0x02, "ldarg.0"], [0x03, "ldarg.1"], [0x04, "ldarg.2"], [0x05, "ldarg.3"],
  [0x06, "ldloc.0"], [0x07, "ldloc.1"], [0x08, "ldloc.2"], [0x09, "ldloc.3"], [0x0a, "stloc.0"], [0x0b, "stloc.1"],
  [0x0c, "stloc.2"], [0x0d, "stloc.3"], [0x0e, "ldarg.s", "u1"], [0x0f, "ldarga.s", "u1"], [0x10, "starg.s", "u1"],
  [0x11, "ldloc.s", "u1"], [0x12, "ldloca.s", "u1"], [0x13, "stloc.s", "u1"], [0x14, "ldnull"], [0x15, "ldc.i4.m1"],
  [0x16, "ldc.i4.0"], [0x17, "ldc.i4.1"], [0x18, "ldc.i4.2"], [0x19, "ldc.i4.3"], [0x1a, "ldc.i4.4"], [0x1b, "ldc.i4.5"],
  [0x1c, "ldc.i4.6"], [0x1d, "ldc.i4.7"], [0x1e, "ldc.i4.8"], [0x1f, "ldc.i4.s", "i1"], [0x20, "ldc.i4", "i4"],
  [0x21, "ldc.i8", "i8"], [0x22, "ldc.r4", "r4"], [0x23, "ldc.r8", "r8"], [0x25, "dup"], [0x26, "pop"],
  [0x27, "jmp", "tok"], [0x28, "call", "tok"], [0x29, "calli", "tok"], [0x2a, "ret"],
  [0x2b, "br.s", "br1"], [0x2c, "brfalse.s", "br1"], [0x2d, "brtrue.s", "br1"], [0x2e, "beq.s", "br1"], [0x2f, "bge.s", "br1"],
  [0x30, "bgt.s", "br1"], [0x31, "ble.s", "br1"], [0x32, "blt.s", "br1"], [0x33, "bne.un.s", "br1"], [0x34, "bge.un.s", "br1"],
  [0x35, "bgt.un.s", "br1"], [0x36, "ble.un.s", "br1"], [0x37, "blt.un.s", "br1"],
  [0x38, "br", "br4"], [0x39, "brfalse", "br4"], [0x3a, "brtrue", "br4"], [0x3b, "beq", "br4"], [0x3c, "bge", "br4"],
  [0x3d, "bgt", "br4"], [0x3e, "ble", "br4"], [0x3f, "blt", "br4"], [0x40, "bne.un", "br4"], [0x41, "bge.un", "br4"],
  [0x42, "bgt.un", "br4"], [0x43, "ble.un", "br4"], [0x44, "blt.un", "br4"], [0x45, "switch", "sw"],
  [0x46, "ldind.i1"], [0x47, "ldind.u1"], [0x48, "ldind.i2"], [0x49, "ldind.u2"], [0x4a, "ldind.i4"], [0x4b, "ldind.u4"],
  [0x4c, "ldind.i8"], [0x4d, "ldind.i"], [0x4e, "ldind.r4"], [0x4f, "ldind.r8"], [0x50, "ldind.ref"], [0x51, "stind.ref"],
  [0x52, "stind.i1"], [0x53, "stind.i2"], [0x54, "stind.i4"], [0x55, "stind.i8"], [0x56, "stind.r4"], [0x57, "stind.r8"],
  [0x58, "add"], [0x59, "sub"], [0x5a, "mul"], [0x5b, "div"], [0x5c, "div.un"], [0x5d, "rem"], [0x5e, "rem.un"],
  [0x5f, "and"], [0x60, "or"], [0x61, "xor"], [0x62, "shl"], [0x63, "shr"], [0x64, "shr.un"], [0x65, "neg"], [0x66, "not"],
  [0x67, "conv.i1"], [0x68, "conv.i2"], [0x69, "conv.i4"], [0x6a, "conv.i8"], [0x6b, "conv.r4"], [0x6c, "conv.r8"],
  [0x6d, "conv.u4"], [0x6e, "conv.u8"], [0x6f, "callvirt", "tok"], [0x70, "cpobj", "tok"], [0x71, "ldobj", "tok"],
  [0x72, "ldstr", "tok"], [0x73, "newobj", "tok"], [0x74, "castclass", "tok"], [0x75, "isinst", "tok"], [0x76, "conv.r.un"],
  [0x79, "unbox", "tok"], [0x7a, "throw"], [0x7b, "ldfld", "tok"], [0x7c, "ldflda", "tok"], [0x7d, "stfld", "tok"],
  [0x7e, "ldsfld", "tok"], [0x7f, "ldsflda", "tok"], [0x80, "stsfld", "tok"], [0x81, "stobj", "tok"],
  [0x82, "conv.ovf.i1.un"], [0x83, "conv.ovf.i2.un"], [0x84, "conv.ovf.i4.un"], [0x85, "conv.ovf.i8.un"], [0x86, "conv.ovf.u1.un"],
  [0x87, "conv.ovf.u2.un"], [0x88, "conv.ovf.u4.un"], [0x89, "conv.ovf.u8.un"], [0x8a, "conv.ovf.i.un"], [0x8b, "conv.ovf.u.un"],
  [0x8c, "box", "tok"], [0x8d, "newarr", "tok"], [0x8e, "ldlen"], [0x8f, "ldelema", "tok"], [0x90, "ldelem.i1"],
  [0x91, "ldelem.u1"], [0x92, "ldelem.i2"], [0x93, "ldelem.u2"], [0x94, "ldelem.i4"], [0x95, "ldelem.u4"], [0x96, "ldelem.i8"],
  [0x97, "ldelem.i"], [0x98, "ldelem.r4"], [0x99, "ldelem.r8"], [0x9a, "ldelem.ref"], [0x9b, "stelem.i"], [0x9c, "stelem.i1"],
  [0x9d, "stelem.i2"], [0x9e, "stelem.i4"], [0x9f, "stelem.i8"], [0xa0, "stelem.r4"], [0xa1, "stelem.r8"], [0xa2, "stelem.ref"],
  [0xa3, "ldelem", "tok"], [0xa4, "stelem", "tok"], [0xa5, "unbox.any", "tok"], [0xb3, "conv.ovf.i1"], [0xb4, "conv.ovf.u1"],
  [0xb5, "conv.ovf.i2"], [0xb6, "conv.ovf.u2"], [0xb7, "conv.ovf.i4"], [0xb8, "conv.ovf.u4"], [0xb9, "conv.ovf.i8"],
  [0xba, "conv.ovf.u8"], [0xc2, "refanyval", "tok"], [0xc3, "ckfinite"], [0xc6, "mkrefany", "tok"], [0xd0, "ldtoken", "tok"],
  [0xd1, "conv.u2"], [0xd2, "conv.u1"], [0xd3, "conv.i"], [0xd4, "conv.ovf.i"], [0xd5, "conv.ovf.u"], [0xd6, "add.ovf"],
  [0xd7, "add.ovf.un"], [0xd8, "mul.ovf"], [0xd9, "mul.ovf.un"], [0xda, "sub.ovf"], [0xdb, "sub.ovf.un"], [0xdc, "endfinally"],
  [0xdd, "leave", "br4"], [0xde, "leave.s", "br1"], [0xdf, "stind.i"], [0xe0, "conv.u"],
].forEach(([code, name, operand]) => op(ONE, code, name, operand));
[
  [0x00, "arglist"], [0x01, "ceq"], [0x02, "cgt"], [0x03, "cgt.un"], [0x04, "clt"], [0x05, "clt.un"], [0x06, "ldftn", "tok"],
  [0x07, "ldvirtftn", "tok"], [0x09, "ldarg", "u2"], [0x0a, "ldarga", "u2"], [0x0b, "starg", "u2"], [0x0c, "ldloc", "u2"],
  [0x0d, "ldloca", "u2"], [0x0e, "stloc", "u2"], [0x0f, "localloc"], [0x11, "endfilter"], [0x12, "unaligned.", "u1"],
  [0x13, "volatile."], [0x14, "tail."], [0x15, "initobj", "tok"], [0x16, "constrained.", "tok"], [0x17, "cpblk"],
  [0x18, "initblk"], [0x19, "no.", "u1"], [0x1a, "rethrow"], [0x1c, "sizeof", "tok"], [0x1d, "refanytype"], [0x1e, "readonly."],
].forEach(([code, name, operand]) => op(TWO, code, name, operand));

/**
 * Decodes a method body at an RVA into instructions.
 * @returns {{ maxStack: number, code: Buffer, instructions: Array<{ offset: number, name: string, operand: any, next: number }> }}
 */
export function methodBody(asm, rva) {
  const { buf } = asm;
  const at = asm.offset(rva);
  const first = buf[at];
  let codeStart;
  let codeSize;
  let maxStack = 8;
  if ((first & 3) === 2) {
    codeStart = at + 1;
    codeSize = first >> 2;
  } else {
    const headerSize = (buf.readUInt16LE(at) >> 12) * 4;
    maxStack = buf.readUInt16LE(at + 2);
    codeSize = buf.readUInt32LE(at + 4);
    codeStart = at + headerSize;
  }
  const code = buf.subarray(codeStart, codeStart + codeSize);
  const instructions = [];
  let p = 0;
  while (p < code.length) {
    const offset = p;
    let info;
    if (code[p] === 0xfe) {
      info = TWO[code[p + 1]];
      p += 2;
    } else {
      info = ONE[code[p]];
      p += 1;
    }
    if (!info) throw new Error(`unknown IL opcode 0x${code[offset].toString(16)} at ${offset}`);
    let operand = null;
    switch (info.operand) {
      case "i1": operand = code.readInt8(p); p += 1; break;
      case "u1": operand = code[p]; p += 1; break;
      case "u2": operand = code.readUInt16LE(p); p += 2; break;
      case "i4": operand = code.readInt32LE(p); p += 4; break;
      case "tok": operand = code.readUInt32LE(p); p += 4; break;
      case "i8": operand = code.readBigInt64LE(p); p += 8; break;
      case "r4": operand = code.readFloatLE(p); p += 4; break;
      case "r8": operand = code.readDoubleLE(p); p += 8; break;
      case "br1": operand = p + 1 + code.readInt8(p); p += 1; break;
      case "br4": operand = p + 4 + code.readInt32LE(p); p += 4; break;
      case "sw": {
        const n = code.readUInt32LE(p);
        p += 4;
        const base = p + n * 4;
        operand = Array.from({ length: n }, (_, i) => base + code.readInt32LE(p + i * 4));
        p = base;
        break;
      }
      default: break;
    }
    instructions.push({ offset, name: info.name, operand, next: p });
  }
  return { maxStack, code, instructions };
}

/* ------------------------------------------------------ type helpers --- */

/**
 * Names, members and signatures over an opened assembly: everything the
 * extractor needs to turn tokens into readable names.
 */
export function metadataIndex(asm) {
  const typeCount = asm.count(T.TypeDef);
  const methodCount = asm.count(T.MethodDef);
  const fieldCount = asm.count(T.Field);
  const nestedIn = new Map();
  for (let i = 1; i <= asm.count(T.NestedClass); i++) {
    const r = asm.row(T.NestedClass, i);
    nestedIn.set(r.nested, r.enclosing);
  }
  const typeDefName = (index) => {
    const r = asm.row(T.TypeDef, index);
    const outer = nestedIn.get(index);
    if (outer) return `${typeDefName(outer)}/${r.name}`;
    return r.namespace ? `${r.namespace}.${r.name}` : r.name;
  };
  const typeRefName = (index) => {
    const r = asm.row(T.TypeRef, index);
    if (r.scope.table === T.TypeRef) return `${typeRefName(r.scope.row)}/${r.name}`;
    return r.namespace ? `${r.namespace}.${r.name}` : r.name;
  };
  const byName = new Map();
  for (let i = 1; i <= typeCount; i++) byName.set(typeDefName(i), i);

  /** Methods / fields of each TypeDef, by list ranges. */
  const ranges = (column, total, i) => {
    const start = asm.row(T.TypeDef, i)[column];
    const end = i < typeCount ? asm.row(T.TypeDef, i + 1)[column] : total + 1;
    return [start, end];
  };
  const methodsOf = (typeIndex) => {
    const [a, b] = ranges("methodList", methodCount, typeIndex);
    const out = [];
    for (let m = a; m < b; m++) out.push({ index: m, ...asm.row(T.MethodDef, m) });
    return out;
  };
  const fieldsOf = (typeIndex) => {
    const [a, b] = ranges("fieldList", fieldCount, typeIndex);
    const out = [];
    for (let f = a; f < b; f++) out.push({ index: f, ...asm.row(T.Field, f) });
    return out;
  };
  const methodOwner = new Int32Array(methodCount + 2);
  const fieldOwner = new Int32Array(fieldCount + 2);
  for (let i = 1; i <= typeCount; i++) {
    const [ma, mb] = ranges("methodList", methodCount, i);
    for (let m = ma; m < mb; m++) methodOwner[m] = i;
    const [fa, fb] = ranges("fieldList", fieldCount, i);
    for (let f = fa; f < fb; f++) fieldOwner[f] = i;
  }

  /** Constant-table values for fields (enum members), by field index. */
  const constants = new Map();
  for (let i = 1; i <= asm.count(T.Constant); i++) {
    const r = asm.row(T.Constant, i);
    if (r.parent.table !== T.Field) continue;
    const b = asm.blob(r.value);
    const value = { 0x02: () => b[0] !== 0, 0x04: () => b.readInt8(0), 0x05: () => b[0], 0x06: () => b.readInt16LE(0), 0x07: () => b.readUInt16LE(0),
      0x08: () => b.readInt32LE(0), 0x09: () => b.readUInt32LE(0), 0x0e: () => b.toString("utf16le") }[r.type];
    if (value) constants.set(r.parent.row, value());
  }

  const fieldRva = new Map();
  for (let i = 1; i <= asm.count(T.FieldRVA); i++) {
    const r = asm.row(T.FieldRVA, i);
    fieldRva.set(r.field, r.rva);
  }

  /** Readable name of a TypeDefOrRef / TypeSpec target. */
  const typeName = (table, index) => {
    if (table === T.TypeDef) return typeDefName(index);
    if (table === T.TypeRef) return typeRefName(index);
    if (table === T.TypeSpec) return typeSpecName(asm.blob(asm.row(T.TypeSpec, index).signature));
    return `?${table}:${index}`;
  };
  const sigType = (b, at) => {
    const e = b[at++];
    const prim = { 0x01: "void", 0x02: "bool", 0x03: "char", 0x04: "sbyte", 0x05: "byte", 0x06: "short", 0x07: "ushort", 0x08: "int",
      0x09: "uint", 0x0a: "long", 0x0b: "ulong", 0x0c: "float", 0x0d: "double", 0x0e: "string", 0x18: "nint", 0x19: "nuint", 0x1c: "object" }[e];
    if (prim) return [prim, at];
    if (e === 0x11 || e === 0x12) {
      const [coded, next] = readCompressed(b, at);
      const tables = [T.TypeDef, T.TypeRef, T.TypeSpec];
      return [typeName(tables[coded & 3], coded >> 2), next];
    }
    if (e === 0x15) {
      let [base, next] = sigType(b, at);
      const [n, n2] = readCompressed(b, next);
      next = n2;
      const args = [];
      for (let i = 0; i < n; i++) {
        const [a, n3] = sigType(b, next);
        args.push(a);
        next = n3;
      }
      return [`${base}<${args.join(",")}>`, next];
    }
    if (e === 0x13 || e === 0x1e) {
      const [n, next] = readCompressed(b, at);
      return [`${e === 0x13 ? "!" : "!!"}${n}`, next];
    }
    if (e === 0x1d) {
      const [inner, next] = sigType(b, at);
      return [`${inner}[]`, next];
    }
    if (e === 0x0f || e === 0x10) {
      const [inner, next] = sigType(b, at);
      return [`${inner}${e === 0x10 ? "&" : "*"}`, next];
    }
    if (e === 0x1f || e === 0x20) {
      const [, next] = readCompressed(b, at);
      return sigType(b, next);
    }
    if (e === 0x45) return sigType(b, at);
    return [`?0x${e.toString(16)}`, b.length];
  };
  const typeSpecName = (b) => sigType(b, 0)[0];
  const typeSpecGenericArgs = (b) => {
    if (b[0] !== 0x15) return [];
    let [, next] = sigType(b, 1);
    const [n, n2] = readCompressed(b, next);
    next = n2;
    const args = [];
    for (let i = 0; i < n; i++) {
      const [a, n3] = sigType(b, next);
      args.push(a);
      next = n3;
    }
    return args;
  };

  /** Method signature: hasThis, param count, return type, param types. */
  const methodSig = (b) => {
    let at = 0;
    const conv = b[at++];
    if (conv & 0x10) [, at] = readCompressed(b, at);
    const [count, next] = readCompressed(b, at);
    at = next;
    const [ret, n2] = sigType(b, at);
    at = n2;
    const params = [];
    for (let i = 0; i < count; i++) {
      const [p, n3] = sigType(b, at);
      params.push(p);
      at = n3;
    }
    return { hasThis: Boolean(conv & 0x20), count, ret, params };
  };

  /** A method token (MethodDef, MemberRef or MethodSpec) as { owner, name, sig, genericArgs, def }. */
  const methodRef = (token) => {
    const table = token >>> 24;
    const index = token & 0xffffff;
    if (table === T.MethodDef) {
      const r = asm.row(T.MethodDef, index);
      return { owner: typeDefName(methodOwner[index]), name: r.name, sig: methodSig(asm.blob(r.signature)), genericArgs: [], def: index };
    }
    if (table === T.MemberRef) {
      const r = asm.row(T.MemberRef, index);
      const owner = r.class.table === T.MethodDef ? typeDefName(methodOwner[r.class.row]) : typeName(r.class.table, r.class.row);
      const ownerArgs = r.class.table === T.TypeSpec ? typeSpecGenericArgs(asm.blob(asm.row(T.TypeSpec, r.class.row).signature)) : [];
      return { owner, name: r.name, sig: methodSig(asm.blob(r.signature)), genericArgs: [], ownerArgs, def: resolveMemberRef(r) };
    }
    if (table === T.MethodSpec) {
      const r = asm.row(T.MethodSpec, index);
      const inner = methodRef(((r.method.table) << 24) | r.method.row);
      const b = asm.blob(r.instantiation);
      let [n, at] = readCompressed(b, 1);
      const args = [];
      for (let i = 0; i < n; i++) {
        const [a, next] = sigType(b, at);
        args.push(a);
        at = next;
      }
      return { ...inner, genericArgs: args };
    }
    throw new Error(`token 0x${token.toString(16)} is not a method`);
  };
  /** A MemberRef on a type defined in this assembly -> its MethodDef index (by name + param count). */
  const resolveMemberRef = (r) => {
    let typeIndex = null;
    if (r.class.table === T.TypeDef) typeIndex = r.class.row;
    if (r.class.table === T.TypeSpec) {
      const b = asm.blob(asm.row(T.TypeSpec, r.class.row).signature);
      if (b[0] === 0x15 && b[1] === 0x12) {
        const [coded] = readCompressed(b, 2);
        if ((coded & 3) === 0) typeIndex = coded >> 2;
      }
    }
    if (!typeIndex) return null;
    const sig = methodSig(asm.blob(r.signature));
    const hit = methodsOf(typeIndex).filter((m) => m.name === r.name && methodSig(asm.blob(m.signature)).count === sig.count);
    return hit.length === 1 ? hit[0].index : null;
  };
  const fieldRef = (token) => {
    const table = token >>> 24;
    const index = token & 0xffffff;
    if (table === T.Field) {
      const r = asm.row(T.Field, index);
      return { owner: typeDefName(fieldOwner[index]), name: r.name, def: index };
    }
    if (table === T.MemberRef) {
      const r = asm.row(T.MemberRef, index);
      return { owner: typeName(r.class.table, r.class.row), name: r.name, def: null };
    }
    throw new Error(`token 0x${token.toString(16)} is not a field`);
  };
  const tokenType = (token) => typeName(token >>> 24, token & 0xffffff);

  /** Base-type chain of a TypeDef, as names. */
  const extendsName = (typeIndex) => {
    const e = asm.row(T.TypeDef, typeIndex).extends;
    return e.row ? typeName(e.table, e.row) : null;
  };

  /** Enum TypeDef -> Map(value -> member name). */
  const enumMembers = (name) => {
    const index = byName.get(name);
    if (!index) throw new Error(`no enum ${name}`);
    const out = new Map();
    for (const f of fieldsOf(index)) if (constants.has(f.index)) out.set(constants.get(f.index), f.name);
    return out;
  };

  return {
    byName, typeDefName, methodsOf, fieldsOf, methodOwner, fieldOwner, constants, fieldRva, methodRef, fieldRef,
    tokenType, extendsName, enumMembers, methodSig, typeName,
  };
}
