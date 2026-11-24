import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBooks, similarity, norm } from '../merge.js';

const entry = (uid, comment, keys, content) => ({
    uid, comment, key: keys, content,
    constant: false, disable: false, order: 100, probability: 100,
});

const book = (name, entries) => ({
    name,
    entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])),
});

test('无冲突时条目数相加，uid 不撞', () => {
    const a = book('A', [entry(0, 'Alice', ['alice'], 'Alice 是剑士。'), entry(1, 'Town', ['town'], '小镇常年下雨。')]);
    const b = book('B', [entry(0, 'Bob', ['bob'], 'Bob 是商人。'), entry(1, 'Forest', ['forest'], '森林里住着狼。')]);
    const { merged, conflicts, stats } = mergeBooks(a, b);

    assert.equal(conflicts.length, 0);
    assert.equal(stats.mergedEntries, 4);
    const uids = Object.values(merged.entries).map((e) => e.uid);
    assert.deepEqual(uids, [0, 1, 2, 3], 'uid 必须唯一且连续');
    assert.equal(merged.entries['2'].comment, 'Bob', 'B 的第一条顺延为 uid 2');
});

test('同名条目被标为高严重度冲突', () => {
    const a = book('A', [entry(0, 'Alice', ['alice'], 'Alice 是剑士。')]);
    const b = book('B', [entry(0, 'Alice', ['alice'], 'Alice 是法师。')]);
    const { conflicts, stats } = mergeBooks(a, b);
    assert.equal(conflicts.length, 1);
    assert.ok(conflicts[0].type.includes('title'));
    assert.equal(conflicts[0].severity, 'high');
    assert.ok(conflicts[0].sharedKeys.includes('alice'));
});

test('keep-both 会给 B 的同名条目加 (B) 后缀', () => {
    const a = book('A', [entry(0, 'Alice', ['alice'], 'Alice 是剑士。')]);
    const b = book('B', [entry(0, 'Alice', ['alice'], 'Alice 是法师。')]);
    const { merged, stats } = mergeBooks(a, b, { onConflict: 'keep-both' });
    assert.equal(stats.renamed, 1);
    assert.equal(merged.entries['0'].comment, 'Alice');
    assert.equal(merged.entries['1'].comment, 'Alice (B)');
    assert.equal(stats.mergedEntries, 2, '两份都保留');
});

test('触发词重叠但标题不同，算中等冲突', () => {
    const a = book('A', [entry(0, 'Sword Art', ['sword'], '剑术奥义。')]);
    const b = book('B', [entry(0, 'Blacksmith', ['sword'], '铁匠铺。')]);
    const { conflicts } = mergeBooks(a, b);
    assert.equal(conflicts.length, 1);
    assert.ok(conflicts[0].type.includes('keys'));
    assert.ok(!conflicts[0].type.includes('title'));
    assert.equal(conflicts[0].severity, 'medium');
});

test('正文高度重复也能识别（弱信号）', () => {
    const text = '这座小镇常年被雨水笼罩，居民以打铁为生，夜里从不点灯。';
    const a = book('A', [entry(0, 'Raintown', ['rain'], text)]);
    const b = book('B', [entry(0, 'Rainy Town', ['rainy'], text)]);
    const { conflicts } = mergeBooks(a, b);
    assert.equal(conflicts.length, 1);
    assert.ok(conflicts[0].type.includes('content'));
    assert.ok(conflicts[0].contentSimilarity > 0.9);
});

test('prefer-a 会丢掉 B 的冲突条目', () => {
    const a = book('A', [entry(0, 'Alice', ['alice'], 'Alice 是剑士。')]);
    const b = book('B', [entry(0, 'Alice', ['alice'], 'Alice 是法师。'), entry(1, 'Bob', ['bob'], 'Bob 是商人。')]);
    const { merged, stats } = mergeBooks(a, b, { onConflict: 'prefer-a' });
    assert.equal(stats.droppedFromB, 1);
    assert.equal(stats.mergedEntries, 2);
    const names = Object.values(merged.entries).map((e) => e.comment);
    assert.deepEqual(names, ['Alice', 'Bob']);
});

test('不冲突的条目不受 prefer-a 影响', () => {
    const a = book('A', [entry(0, 'Alice', ['alice'], 'A。')]);
    const b = book('B', [entry(0, 'Bob', ['bob'], 'B。')]);
    const { stats } = mergeBooks(a, b, { onConflict: 'prefer-a' });
    assert.equal(stats.droppedFromB, 0);
    assert.equal(stats.mergedEntries, 2);
});

test('空书不炸', () => {
    const a = book('A', []);
    const b = book('B', [entry(0, 'X', ['x'], 'Y')]);
    const { stats } = mergeBooks(a, b);
    assert.equal(stats.mergedEntries, 1);
});

test('合并结果带来源标记', () => {
    const a = book('甲', [entry(0, 'X', ['x'], '1')]);
    const b = book('乙', [entry(0, 'Y', ['y'], '2')]);
    const { merged } = mergeBooks(a, b, { name: '临时书 C' });
    assert.equal(merged.name, '临时书 C');
    assert.deepEqual(merged.extensions.fridge_merge.sources, ['甲', '乙']);
    assert.ok(merged.extensions.fridge_merge.created);
});

test('相似度函数本身', () => {
    assert.equal(similarity('Alice', 'alice'), 1);
    assert.ok(similarity('Alice', 'Alicia') > 0.2);
    assert.equal(similarity('完全不同的内容', 'another thing'), 0);
    assert.equal(norm('  Alice!  '), 'alice');
});
