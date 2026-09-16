// m2c's C++ target names the implicit receiver `this`; a C++ row's own front end reserves the word.
import { describe, expect, test } from 'vitest';

import { m2cCandidates, renameReceiver } from '../src/eval/m2c';

describe('renameReceiver', () => {
  test('renames a receiver this DECLARES as a parameter, everywhere it is read', () => {
    const source = 'void f__5ThingFi(Thing *this, s32 arg0) {\n    this->unk0 = arg0;\n}\n';
    expect(renameReceiver(source, 'f__5ThingFi')).toBe(
      'void f__5ThingFi(Thing *this_, s32 arg0) {\n    this_->unk0 = arg0;\n}\n',
    );
  });

  test('leaves a genuine member definition alone', () => {
    const source = 'void Thing::f(int a) {\n    this->unk0 = a;\n}\n';
    expect(renameReceiver(source, 'f__5ThingFi')).toBe(source);
  });

  test('picks a name the source does not already use', () => {
    const source = 'void g(Thing *this) {\n    s32 this_ = 1;\n    this->unk0 = this_;\n}\n';
    expect(renameReceiver(source, 'g')).toBe(
      'void g(Thing *this__) {\n    s32 this_ = 1;\n    this__->unk0 = this_;\n}\n',
    );
  });
});

describe('m2cCandidates', () => {
  test('scores the source AS EMITTED first, the renamed one only as a retry', () => {
    const source = 'void f__5ThingFi(Thing *this, s32 arg0) {\n    this->unk0 = arg0;\n}\n';
    expect(m2cCandidates(source, 'f__5ThingFi', 'c++')).toEqual([source, renameReceiver(source, 'f__5ThingFi')]);
  });

  test('a C row, and a C++ row with no reserved receiver, are scored once', () => {
    const source = 'void f__5ThingFi(Thing *thing, s32 arg0) {\n    thing->unk0 = arg0;\n}\n';
    expect(m2cCandidates(source, 'f__5ThingFi', 'c++')).toEqual([source]);
    expect(m2cCandidates('void g(int *this) {}\n', 'g', 'c')).toEqual(['void g(int *this) {}\n']);
  });
});
