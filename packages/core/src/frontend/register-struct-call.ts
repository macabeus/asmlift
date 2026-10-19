// asmlift — THE CALLER HALF OF A STRUCT RETURNED IN THE RETURN REGISTER.
//
// A callee the project declares to return a struct of one, two or four bytes, on a target whose
// rule (aggregate.ts `returnsInMemory`) hands it back in the return register — agbcc's r0 for a
// struct of one non-bitfield member, mwcc's r3 for any struct of eight bytes or less — fills that
// register with the struct's bytes as the target lays them in a word. The call plan lets the call
// write the register as its result, marked `REGISTER_STRUCT` (frontend/call-plan.ts
// `registerStructLocal` says which calls), so the frontend reads it as it reads any call's word.
//
// Here the word becomes what C says it is: the struct, assigned by the call to a local of its
// type, and re-read off that local. The call takes the local's address the way a call returning a
// struct through memory takes its destination (`sret`), so it prints `s = mk(x);`; the word is a
// load of the local at offset 0, of the struct's own size, and on a big-endian target shifted up to
// the top of the word, which is where the struct's first byte sits there (mwcc's `{u16}` member is
// `srwi r0,r3,16` off the call). Whatever the caller then takes out of the word — a truncating
// store, a shift, a mask — reads the local's bytes, and the member recovery spells it as the
// member it is: `gV = s.h;`. Save one: a 4-byte read of the local (a `{u32}`'s member, or agbcc's
// `{u16}`, rounded to four bytes, read whole by an add only a halfword store reads: `gH += s.h;`
// is `gH = *(s32 *)&s + gH;`) is spelled `*(s32 *)&s`, because
// structure.ts `frameStructMember` keeps a 4-byte read's own signedness (`spellsAccessType`) rather
// than the member's. That is the frame-member spelling on every toolchain, the O32 struct returned
// through memory's too (`gW = *(s32 *)&sp16;`), not something of this file's: the value is right,
// and only where a reader's operand order or a frame copy depends on it (gcc 2.7.2's `&sp16` adds
// one) does the cast cost bytes.
//
// WHAT THE IMAGE LEAVES OUT IS NO VALUE. A struct of one or two bytes — mwcc's; agbcc rounds every
// struct to four — fills only that much of the register, and the rest holds whatever the callee
// left. The load reads it as zero, which is right only where nothing reads it, so every reader of
// the register must need only the struct's bits (`demandedBits`): a truncating store, a shift that
// drops the rest, a mask. A function that reads past them — stores the whole word, compares it,
// returns it where its own declaration says it returns a value — declines; one whose return
// nothing declares returns no value instead, where that guessed return is the only such reader.
import {
  type Block,
  CALL_RETURN_OBJECT,
  type Fn,
  OWN_RETURN_OBJECT,
  type Op,
  REGISTER_STRUCT,
  RETURNS_OBJECT,
  STRUCT_HOMED,
  type Value,
  calleeName,
  defOpMap,
  mkOp,
  mkValue,
  replaceAllUsesWith,
} from '../ir/core';
import { qualified } from '../ir/discipline';
import { type IrType, T, typeEquals } from '../ir/types';
import { type FnProto, type Prototypes, declaresVoidReturn } from '../proto';
import type { TargetDescription } from '../target';
import { registerStructLocal } from './call-plan';
import { FrontendUnsupportedError } from './errors';

/** One call's struct, as `liftRegisterStructCalls` re-read it: the block it was assigned in, the
 *  local, the struct's size, the image word the frontend read, and the load of the struct's bytes
 *  (the word itself where no shift moves them). */
interface Image {
  block: Block;
  callee: string;
  local: Value;
  size: number;
  word: Value;
  loaded: Value;
  /** the call as it was before it took the local, and the ops it added (`dropUnreadImage`) */
  call: Op;
  operands: Value[];
  attrs: Op['attrs'];
  added: Op[];
}

/** What `liftRegisterStructCalls` did to the function's own return. */
export interface OwnReturnOfCalls {
  /** every `ret` hands back a call's struct whole, by value (`return mk(x);`) */
  handedBack: boolean;
  /** some call's struct is read in this function, so a word the function returns may be computed
   *  from it: through an op, a join, or a frame slot it is stored to and reloaded from (mwcc's home,
   *  an array, a local whose address escapes). Only the function's own struct return
   *  (pipeline.ts `returnOwnStruct`) can spell such a word, and the bytes do not say whether the
   *  word is one, so the question is not narrowed to the reads this pass can follow: before this
   *  pass existed, every such read refused. */
  readsCallStruct: boolean;
}

/** Rewrites every call `REGISTER_STRUCT` marks into the struct assigned to a local of its declared
 *  type, its word re-read off that local. `prototypes` is the table the frontend planned the calls
 *  from, so each marked callee's declaration lays the local out; `ownDeclaration` is the function's
 *  own, stated or the context's, which says whether its return reads the register, and `ownStruct`
 *  the struct it declares it returns in that register, if it does.
 *
 *  A FUNCTION THAT RETURNS WHAT A CALL RETURNED returns the call: where every `ret` hands back the
 *  very image a call to a callee declared to return the function's own struct left in the
 *  register, and nothing else reads that image, the call's value is the struct and each `ret`
 *  returns it, `return mk(x);`. Split into the local and a member copy instead, `ret.x = mk_ret.x`,
 *  it compiles to a frame copy the source never had (mwcc: `stw r3,8(r1)`). */
export function liftRegisterStructCalls(
  fn: Fn,
  prototypes: Prototypes,
  target: TargetDescription,
  ownDeclaration: FnProto | undefined,
  ownStruct: Extract<IrType, { kind: 'struct' }> | undefined,
): OwnReturnOfCalls {
  const bigEndian = target.capabilities.endianness === 'big';
  const images: Image[] = [];
  const rets = fn.blocks.map((b) => b.ops[b.ops.length - 1]).filter((op) => op?.opcode === 'ret');
  const marked = new Map<Value, Op>();
  for (const op of fn.blocks.flatMap((b) => b.ops)) {
    if (op.opcode === 'call' && op.attrs[REGISTER_STRUCT] !== undefined) {
      marked.set(op.results[0], op);
    }
  }
  if (marked.size === 0) {
    return { handedBack: false, readsCallStruct: false };
  }
  const defs = defOpMap(fn);
  const isFrameAddress = (v: Value): boolean => {
    const d = defs.get(v);
    return d?.opcode === 'laddr' && d.attrs[OWN_RETURN_OBJECT] !== true && d.attrs[CALL_RETURN_OBJECT] === undefined;
  };
  // a store of the image into a frame word is its home (`foldFrameHome`), which reads no member
  const homeStore = (op: Op, word: Value): boolean =>
    op.opcode === 'store' &&
    op.operands[1] === word &&
    op.operands[0] !== word &&
    isFrameAddress(op.operands[0]) &&
    !qualified(op);
  const handedBack =
    ownStruct !== undefined &&
    rets.length > 0 &&
    rets.every((r) => {
      const word = r.operands.length === 1 ? r.operands[0] : undefined;
      const call = word === undefined ? undefined : marked.get(word);
      const type = call === undefined ? undefined : registerStructLocal(prototypes[calleeName(call)!], target);
      return (
        type !== undefined &&
        typeEquals(type, ownStruct) &&
        fn.blocks.every((b) =>
          b.ops.every(
            (op) =>
              (op === r || homeStore(op, word!) || !op.operands.includes(word!)) &&
              op.successors.every((e) => !e.args.includes(word!)),
          ),
        )
      );
    });
  // a struct the source names — it has a home — is returned as that local, `return mk_ret;`; one
  // with none is the call itself, `return mk(x);`
  const returnedWhole = new Map<Value, Op>();
  if (handedBack) {
    for (const r of rets) {
      const word = r.operands[0];
      const call = marked.get(word)!;
      const homed =
        call.attrs[REGISTER_STRUCT] === STRUCT_HOMED || fn.blocks.some((b) => b.ops.some((op) => homeStore(op, word)));
      if (homed) {
        returnedWhole.set(word, r);
        continue;
      }
      const { [REGISTER_STRUCT]: _, ...attrs } = call.attrs;
      call.attrs = attrs;
      call.results = [mkValue(ownStruct)];
      r.operands = [call.results[0]];
    }
  }
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const call = b.ops[i];
      if (call.opcode !== 'call' || call.attrs[REGISTER_STRUCT] === undefined) {
        continue;
      }
      const callee = calleeName(call);
      const own = callee !== undefined && Object.hasOwn(prototypes, callee) ? prototypes[callee] : undefined;
      // the type the plan marked the call by (`registerStructLocal` is its one derivation)
      const type = registerStructLocal(own, target);
      if (callee === undefined || type?.size === undefined) {
        throw new Error(`'${fn.name}': a call marked to return a struct in a register has no declared struct`);
      }
      const size = type.size;
      const word = call.results[0];
      const { [REGISTER_STRUCT]: _, ...attrs } = call.attrs;
      // a struct nothing reads is the call's statement alone, as a discarded scalar is
      const read = fn.blocks.some(
        (x) =>
          x.ops.some((op) => op.operands.includes(word)) ||
          x.ops.some((op) => op.successors.some((e) => e.args.includes(word))),
      );
      if (!read) {
        call.attrs = attrs;
        continue;
      }
      const object = mkOp('laddr', {
        results: [mkValue(T.ptr(type))],
        // one local per call, which `nth` keeps apart: two calls' structs are two objects, and one
        // read of the first may come after the second
        attrs: {
          off: 0,
          width: 1,
          signed: false,
          count: size,
          aggregate: true,
          [CALL_RETURN_OBJECT]: callee,
          nth: images.length,
        },
      });
      const local = object.results[0];
      // the local's address is the call's first operand, as a hidden pointer's is, so every index
      // the call names into its operands moves up one
      const shifted = (key: string, step: number) =>
        Array.isArray(attrs[key])
          ? { [key]: (attrs[key] as number[]).map((v, k) => (k % step === 0 ? v + 1 : v)) }
          : {};
      call.attrs = {
        ...attrs,
        sret: true,
        ...shifted('doubles', 1),
        ...shifted('byValue', 2),
        ...shifted('byValueWords', 2),
      };
      const operands = call.operands;
      call.operands = [local, ...call.operands];
      call.results = [mkValue(type)];
      const lift = 32 - 8 * size;
      const loaded = bigEndian && lift > 0 ? mkValue(T.unk(32)) : word;
      const reads = [
        mkOp('load', { operands: [local], results: [loaded], attrs: { off: 0, width: size, signed: false } }),
      ];
      if (loaded !== word) {
        reads.push(mkOp('shl', { operands: [loaded], results: [word], attrs: { imm: lift } }));
      }
      b.ops.splice(i + 1, 0, ...reads);
      // the locals open the entry block in the order of their calls
      fn.blocks[0].ops.splice(images.length, 0, object);
      if (b === fn.blocks[0]) {
        i++;
      }
      images.push({ block: b, callee, local, size, word, loaded, call, operands, attrs, added: [object, ...reads] });
      const ret = returnedWhole.get(word);
      if (ret !== undefined) {
        ret.operands = [local];
        ret.attrs = { ...ret.attrs, [RETURNS_OBJECT]: true };
      }
    }
  }

  // THE MEMBER TAKEN BACK DOWN IS THE LOAD. A big-endian caller reads a sub-word struct's first
  // member by shifting the register down by exactly what the image shifted it up (`srwi r0,r3,16`
  // for a `{u16}`), and the load is narrower than the shift leaves room for, so the two shifts
  // cancel: what that shift computes is the load itself.
  for (const { word, loaded, size } of images) {
    for (const op of fn.blocks.flatMap((x) => x.ops)) {
      if (
        loaded !== word &&
        op.opcode === 'shr_u' &&
        op.operands.length === 1 &&
        op.operands[0] === word &&
        op.attrs.imm === 32 - 8 * size
      ) {
        replaceAllUsesWith(fn, op.results[0], loaded);
      }
    }
  }
  for (const image of images) {
    foldFrameHome(fn, image);
  }
  // what the image leaves out must be what no reader reads (`demandedBits`)
  const structBits = (size: number): number =>
    size >= 4 ? FULL : bigEndian ? (FULL << (32 - 8 * size)) >>> 0 : (1 << (8 * size)) - 1;
  const readsPast = ({ word, size }: Image, voidOwn: boolean): boolean =>
    (demandedBits(fn, word, voidOwn) & ~structBits(size)) >>> 0 !== 0;
  // A RETURN NOTHING DECLARES IS NO READER OF WHAT THE IMAGE LEAVES OUT. With no own declaration,
  // the `ret` reading the return register is the frontend's guess (a scalar callee's word is
  // returned the same way, `v0 = g(); return v0;`), and the bytes do not decide it, as they do not
  // decide a guessed arity (frontend/ssa.ts `noteStructImage`). Where that guess is the only reader
  // past the struct's bits, and every `ret` hands back a call's image as it came back, the function
  // returns no value: the register below a struct of one or two bytes holds none, so no C return
  // can be what it holds, and `void` is the spelling those bytes compile from.
  if (
    ownDeclaration === undefined &&
    images.some((image) => readsPast(image, false)) &&
    images.every((image) => !readsPast(image, true)) &&
    rets.every((r) => r.operands.length === 1 && images.some(({ word }) => word === r.operands[0]))
  ) {
    for (const r of rets) {
      r.operands = [];
    }
    // …and a struct only that guess read is now one nothing reads: the call's statement alone
    for (const image of [...images]) {
      if (dropUnreadImage(fn, image)) {
        images.splice(images.indexOf(image), 1);
      }
    }
  }
  const voidOwn = declaresVoidReturn(ownDeclaration);
  for (const image of images) {
    const { size, callee, word } = image;
    if (readsPast(image, voidOwn)) {
      // a home `foldFrameHome` left — one read outside the call's block (mwcc 2.3.3 stores the
      // word whole in each arm of an `if` and reads the member in the join), or written again
      // before it is read — is no read past the struct, only one this fold does not follow
      if (fn.blocks.some((b) => b.ops.some((op) => homeStore(op, word) && op.attrs.width === 4))) {
        throw new FrontendUnsupportedError(
          `cannot lift '${fn.name}': local stack frames not supported — \`${callee}\` hands back a struct of ` +
            `${size} byte${size === 1 ? '' : 's'} in ${target.returnReg}, and its frame home is written again or ` +
            "read where the fold into the call's local does not reach",
        );
      }
      throw new FrontendUnsupportedError(
        `cannot lift '${fn.name}': \`${callee}\` hands back a struct of ${size} byte${size === 1 ? '' : 's'} in ` +
          `${target.returnReg}, and this function reads bits of the register past it — what the callee left there is no value`,
      );
    }
  }
  return { handedBack, readsCallStruct: images.length > 0 };
}

/** Put back the call `image` was built from, where nothing outside the ops it added reads its
 *  word, its load or its local. */
function dropUnreadImage(fn: Fn, image: Image): boolean {
  const own = new Set([image.call, ...image.added]);
  const read = (v: Value): boolean =>
    fn.blocks.some((b) =>
      b.ops.some((op) => !own.has(op) && (op.operands.includes(v) || op.successors.some((e) => e.args.includes(v)))),
    );
  if (read(image.word) || read(image.loaded) || read(image.local)) {
    return false;
  }
  image.call.operands = image.operands;
  image.call.attrs = image.attrs;
  image.call.results = [image.word];
  for (const b of fn.blocks) {
    b.ops = b.ops.filter((op) => !image.added.includes(op));
  }
  return true;
}

/** THE STRUCT'S FRAME HOME IS THE LOCAL. A compiler that gives the struct a home in the frame stores
 *  the register there as it comes back (mwcc: `bl mk; stw r3,8(r1); lhz r0,8(r1)` for `s = mk(x);
 *  gOut = s.a;`) and reads its members off the home, so the home's bytes are the local's. Each load
 *  of them is rewritten to read the local, which spells it as the member it is, and the store goes
 *  where nothing else touches those bytes — the C's own assignment is that store.
 *
 *  Only what the bytes prove is folded. The home is a frame object whose address is no value — only
 *  ever the base of a load or a store — so nothing but those accesses reaches its bytes; the store
 *  writes the image whole (the word, or on big-endian the struct's own bytes, `sth`), unqualified,
 *  in the call's block; and only the loads that follow it there, before any other store to the
 *  home's bytes, and that lie inside the struct, read what it stored. A load of the pad past a
 *  struct of one or two bytes reads no member, and stops the walk. */
function foldFrameHome(fn: Fn, { block, local, size, word, loaded }: Image): void {
  const defs = defOpMap(fn);
  const frameOff = (v: Value): number | undefined => {
    const d = defs.get(v);
    return d?.opcode === 'laddr' &&
      d.attrs[CALL_RETURN_OBJECT] === undefined &&
      d.attrs[OWN_RETURN_OBJECT] !== true &&
      typeof d.attrs.off === 'number'
      ? d.attrs.off
      : undefined;
  };
  const at = block.ops.findIndex(
    (op) =>
      op.opcode === 'store' &&
      frameOff(op.operands[0]) !== undefined &&
      !qualified(op) &&
      ((op.operands[1] === word && op.attrs.width === 4) || (op.operands[1] === loaded && op.attrs.width === size)),
  );
  if (at < 0) {
    return;
  }
  const home = block.ops[at];
  const base = frameOff(home.operands[0])! + (home.attrs.off as number);
  const touches = (op: Op): boolean => {
    const off = frameOff(op.operands[0]);
    const from = (off ?? NaN) + (op.attrs.off as number);
    return from < base + (home.attrs.width as number) && from + (op.attrs.width as number) > base;
  };
  // every frame address in the function is only the base of an access, or nothing may be folded
  const ops = fn.blocks.flatMap((b) => b.ops);
  for (const op of ops) {
    const bases = op.opcode === 'load' || op.opcode === 'store' ? 1 : 0;
    if (op.operands.slice(bases).some((v) => frameOff(v) !== undefined)) {
      return;
    }
  }
  for (const op of block.ops.slice(at + 1)) {
    if (op.opcode === 'store' && touches(op)) {
      break;
    }
    if (op.opcode !== 'load' || !touches(op)) {
      continue;
    }
    const from = frameOff(op.operands[0])! + (op.attrs.off as number) - base;
    if (from < 0 || from + (op.attrs.width as number) > size || qualified(op)) {
      break;
    }
    op.operands = [local, ...op.operands.slice(1)];
    op.attrs = { ...op.attrs, off: from };
  }
  if (!ops.some((op) => op !== home && (op.opcode === 'load' || op.opcode === 'store') && touches(op))) {
    block.ops.splice(block.ops.indexOf(home), 1);
  }
}

const FULL = 0xffffffff;

/** THE BITS OF `v` ANY READER NEEDS, as a mask: a store of W bytes needs the low 8W bits of the
 *  value it stores, a constant mask and the bitwise ops pass their readers' bits through, a shift
 *  by a constant moves them, an add, a subtract or a multiply needs every bit up to its readers'
 *  highest, since a carry only travels up, and a join needs what its parameter's readers need.
 *  Every other reader — a compare, a call, an address — needs all 32, and so does a join that
 *  reaches itself again. A `ret` needs none where the function's own declaration returns nothing. */
function demandedBits(fn: Fn, root: Value, voidOwn: boolean): number {
  const defs = defOpMap(fn);
  const memo = new Map<Value, number>();
  const constOf = (x: Value): number | undefined => {
    const d = defs.get(x);
    return d?.opcode === 'const' && typeof d.attrs.value === 'number' ? d.attrs.value >>> 0 : undefined;
  };
  const upTo = (d: number): number => (d === 0 ? 0 : d >= 0x80000000 ? FULL : (2 ** (32 - Math.clz32(d)) - 1) >>> 0);
  const of = (v: Value): number => {
    const known = memo.get(v);
    if (known !== undefined) {
      return known;
    }
    memo.set(v, FULL); // a reader reached again through a join needs everything
    let need = 0;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        for (const e of op.successors) {
          e.args.forEach((a, i) => {
            if (a === v) {
              need |= of(e.block.params[i]);
            }
          });
        }
        if (!op.operands.includes(v)) {
          continue;
        }
        const out = () => (op.results.length === 1 ? of(op.results[0]) : FULL);
        const imm = typeof op.attrs.imm === 'number' && op.operands.length === 1 ? op.attrs.imm : undefined;
        const other = op.operands.length === 2 ? op.operands[op.operands[0] === v ? 1 : 0] : undefined;
        switch (op.opcode) {
          case 'store':
            need |=
              op.operands[0] === v || typeof op.attrs.width !== 'number' || op.attrs.width >= 4
                ? FULL
                : (1 << (8 * op.attrs.width)) - 1;
            break;
          case 'ret':
            need |= voidOwn ? 0 : FULL;
            break;
          case 'and': {
            const c = other === undefined || other === v ? undefined : constOf(other);
            need |= c === undefined ? out() : out() & c;
            break;
          }
          case 'or':
          case 'xor':
          case 'not':
            need |= other === v ? FULL : out();
            break;
          case 'add':
          case 'sub':
          case 'mul':
          case 'neg':
            need |= other === v ? FULL : upTo(out());
            break;
          case 'shl':
            need |= imm === undefined ? FULL : out() >>> imm;
            break;
          case 'shr_u':
            need |= imm === undefined ? FULL : (out() << imm) >>> 0;
            break;
          case 'shr_s': {
            const d = out();
            need |=
              imm === undefined ? FULL : ((d << imm) | (imm > 0 && d >>> (32 - imm) !== 0 ? 0x80000000 : 0)) >>> 0;
            break;
          }
          default:
            need |= FULL;
        }
        need >>>= 0;
      }
    }
    memo.set(v, need);
    return need;
  };
  return of(root);
}
