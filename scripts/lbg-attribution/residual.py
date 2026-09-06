"""Analyze rowdiff.mjs JSON. Counts are aligned objdiff rows, not instruction distances.
Shape alignment is a separate instruction-only comparison; pool data never becomes register drift.
Objdiff bounds display by its parsed symbol, avoiding objdump's next-local-label/zero-size traps.
"""
import collections
import difflib
import json
import re
import sys

REG = re.compile(r'^(?:r(?:1[0-5]|[0-9])|sp|lr|pc|sl|fp|ip)$')
ALIASES = dict(zip(('lsls lsrs asrs adds subs movs mvns ands orrs eors bics negs muls rsbs adcs sbcs rors').split(), ('lsl lsr asr add sub mov mvn and orr eor bic neg mul rsb adc sbc ror').split()))
REG_ALIAS = {'sl': 'r10', 'fp': 'r11', 'ip': 'r12', 'r13': 'sp', 'r14': 'lr', 'r15': 'pc'}


def tokens(row):
    out = []
    for seg in (row or {}).get('segments', []):
        t = seg['text']
        if not isinstance(t, dict):
            raise ValueError('Unexpected untagged objdiff token')
        tag, val = t['tag'], t.get('val')
        if tag in ('address', 'spacing', 'branch-arrow', 'eol', 'line'):
            continue
        if tag == 'opcode':
            val = val['mnemonic']
            val = ALIASES.get(val, val)
        elif tag == 'symbol':
            val = val.get('name', val.get('demangledName'))
        elif tag in ('signed', 'unsigned', 'addend', 'branch-dest'):
            val = str(int(val))
        else:
            val = str(val).strip()
        if not val:
            continue
        if tag == 'opaque' and REG.fullmatch(val):
            tag, val = 'register', REG_ALIAS.get(val, val)
        out.append((tag, val))
    return out


def opcode(ts):
    return next((v for t, v in ts if t == 'opcode'), '')


def data(ts):
    return opcode(ts).startswith('.')


def categories(a, b):
    if not a or not b:
        return ['pool/data', 'insertion/deletion'] if data(a) or data(b) else ['insertion/deletion']
    if data(a) or data(b):
        return ['pool/data']
    if opcode(a) != opcode(b):
        return ['structure/opcode']
    if a != b and [(t, 'R' if t == 'register' else v) for t, v in a] == [(t, 'R' if t == 'register' else v) for t, v in b]:
        return ['register']
    cats = set()
    seq = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    for tag, i, endi, j, endj in seq.get_opcodes():
        if tag == 'equal':
            continue
        for kind, value in a[i:endi] + b[j:endj]:
            if kind == 'register':
                cats.add('register')
            elif kind == 'branch-dest':
                cats.add('branch-target')
            elif kind in ('symbol', 'addend'):
                cats.add('symbol/addend')
            elif kind in ('signed', 'unsigned'):
                regs = {v for t, v in a + b if t == 'register'}
                cats.add('stack-offset/immediate' if 'sp' in regs else 'pool-offset' if 'pc' in regs else 'immediate')
            else:
                cats.add('operand-structure')
    return sorted(cats) or ['render-equal/metadata']


def shape(ts):
    # Preserve all constants except branch destinations and PC-relative pool offsets.
    # Thus only real instruction register changes can count as register drift.
    pool = any(t == 'register' and v == 'pc' for t, v in ts) and any(v == '[' for t, v in ts)
    result = []
    for t, v in ts:
        if t == 'register':
            v = 'R'
        elif t == 'branch-dest':
            v = 'L'
        elif pool and t in ('signed', 'unsigned'):
            v = '=pool'
        result.append((t, v))
    return tuple(result)


def analyze(doc):
    tally, kind_tally = collections.Counter(), collections.Counter()
    pools = {'target': collections.Counter(), 'candidate': collections.Counter()}
    instructions = {'target': [], 'candidate': []}
    details = []
    score = 0
    for row in doc['rows']:
        a, b = tokens(row['target']), tokens(row['candidate'])
        for side, ts in [('target', a), ('candidate', b)]:
            if data(ts):
                # Symbol and explicit relocation addend are retained in this identity.
                pools[side][json.dumps(ts, separators=(',', ':'))] += 1
            elif opcode(ts):
                instructions[side].append(ts)
        lk = (row['target'] or {}).get('diffKind', 'none')
        rk = (row['candidate'] or {}).get('diffKind', 'none')
        kind = lk if lk != 'none' else rk
        if kind == 'none':
            continue
        score += 1
        kind_tally[kind] += 1
        cats = categories(a, b)
        category = 'register-only' if cats == ['register'] else '+'.join(cats)
        tally[category] += 1
        details.append({'row': row['index'], 'kind': kind, 'category': category, 'target': a, 'candidate': b})
    a, b = instructions['target'], instructions['candidate']
    alignment = difflib.SequenceMatcher(a=[shape(t) for t in a], b=[shape(t) for t in b], autojunk=False)
    shapes = collections.Counter()
    for tag, i, ei, j, ej in alignment.get_opcodes():
        if tag == 'equal':
            shapes['equal_shape_pairs'] += ei - i
            for left, right in zip(a[i:ei], b[j:ej]):
                if left == right:
                    shapes['identical_pairs'] += 1
                elif categories(left, right) == ['register']:
                    shapes['register_only_pairs'] += 1
                else:
                    shapes['normalized_branch_or_pool_pairs'] += 1
        else:
            shapes['structural_regions'] += 1
            shapes['structural_target_instructions'] += ei - i
            shapes['structural_candidate_instructions'] += ej - j
    return {'symbol': doc['symbol'], 'convention': 'aligned objdiff rows; mixed categories count once; shape counts separately align instructions only', 'score': score, 'diff_kinds': kind_tally, 'row_categories': tally, 'instruction_shape_alignment': shapes, 'pool_data_values': pools, 'pool_data_totals': {side: {'rows': sum(values.values()), 'distinct_values': len(values)} for side, values in pools.items()}, 'rows': details}


if __name__ == '__main__':
    with open(sys.argv[1]) as source:
        print(json.dumps(analyze(json.load(source)), indent=2))
