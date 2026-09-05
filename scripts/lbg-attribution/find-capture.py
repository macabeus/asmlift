#!/usr/bin/env python3
"""Index captured compile units by function-body tokens; never substitute stdout's declarations.

First run: find-capture.py CAPTURE_DIR RENDER.c --symbol NAME --database SCRATCH.sqlite
Repeat after more captures arrive: the same command indexes new/changed unit.i files only.
Exact body hits are candidates to score, not proof their declarations or objects agree.
"""
import argparse
import hashlib
import json
import re
import sqlite3
from pathlib import Path

TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[A-Za-z_$][\w$]*|0[xX][0-9a-fA-F]+(?:[uUlL]*)|\d+(?:[uUlL]*)|>>=|<<=|->|\+\+|--|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%&|^]=|[^\s]')
COMMENT = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|/\*.*?\*/|//[^\n]*', re.S)

def body_tokens(text, symbol):
    text = COMMENT.sub(lambda m: '' if m[0].startswith(('/*', '//')) else m[0], text)
    text = re.sub(r'^\s*#.*$', '', text, flags=re.M)
    toks = TOKEN.findall(text)
    for i, token in enumerate(toks):
        if token != symbol or i + 1 == len(toks) or toks[i + 1] != '(':
            continue
        depth = 0
        j = i + 1
        while j < len(toks):
            depth += (toks[j] == '(') - (toks[j] == ')')
            j += 1
            if depth == 0:
                break
        if j == len(toks) or toks[j] != '{':
            continue
        start = j
        depth = 0
        while j < len(toks):
            depth += (toks[j] == '{') - (toks[j] == '}')
            j += 1
            if depth == 0:
                return toks[start:j]
    raise ValueError('no function definition for ' + symbol)

def digest(tokens):
    return hashlib.sha256('\0'.join(tokens).encode()).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('captures', type=Path)
    parser.add_argument('render', type=Path)
    parser.add_argument('--symbol', required=True)
    parser.add_argument('--database', type=Path, required=True)
    args = parser.parse_args()
    expected = body_tokens(args.render.read_text(), args.symbol)
    db = sqlite3.connect(args.database)
    db.execute('CREATE TABLE IF NOT EXISTS units (path TEXT PRIMARY KEY, symbol TEXT, size INTEGER, mtime INTEGER, hash TEXT, tokens INTEGER, error TEXT)')
    scanned = indexed = errors = 0
    for path in args.captures.glob('candidate.*/unit.i'):
        scanned += 1
        stat = path.stat()
        key = str(path.resolve())
        cached = db.execute('SELECT symbol,size,mtime FROM units WHERE path=?', (key,)).fetchone()
        if cached == (args.symbol, stat.st_size, stat.st_mtime_ns):
            continue
        indexed += 1
        try:
            tokens = body_tokens(path.read_text(), args.symbol)
            hash_value, count, error = digest(tokens), len(tokens), None
        except (ValueError, UnicodeError) as exc:
            hash_value, count, error = None, None, str(exc)
            errors += 1
        db.execute('INSERT OR REPLACE INTO units VALUES (?,?,?,?,?,?,?)', (key, args.symbol, stat.st_size, stat.st_mtime_ns, hash_value, count, error))
        if indexed % 1000 == 0:
            db.commit()
    db.commit()
    hits = []
    for (path,) in db.execute('SELECT path FROM units WHERE symbol=? AND hash=?', (args.symbol, digest(expected))):
        p = Path(path)
        if p.exists() and body_tokens(p.read_text(), args.symbol) == expected:
            hits.append({'preprocessed': path, 'assembly': str(p.with_suffix('.s')), 'object': str(p.with_suffix('.o'))})
    print(json.dumps({'scanned': scanned, 'indexed': indexed, 'new_errors': errors, 'body_tokens': len(expected), 'exact_body_hits': hits, 'caution': 'Score all distinct objects among hits; declaration differences can change codegen. No hits is inconclusive when preprocessing changes body tokens.'}, indent=2))

if __name__ == '__main__':
    main()
