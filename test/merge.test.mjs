import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeBooks, similarity, norm } from '../merge.js';

const entry = (uid, comment, keys, content, extra = {}) => ({
    uid, comment, key: keys, content,
    constant: false, disable: false, order: 100, probability: 100,
    ...extra,
});

const book = (name, entries) => ({
    name,
    entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])),
});

const all = (merged) => Object.values(merged.entries);
const byTitlePrefix = (merged, prefix) => all(merged).filter((e) => e.comment.startsWith(prefix));

test('无冲突时条目数相加，uid 不撞', () => {
    const a = book('A', [entry(0, 'Alice', ['alice'], 'Alice 是剑士。'), entry(1, 'Town', ['town'], '小镇常年下雨。')]);
    const b = book('B', [entry(0, 'Bob', ['bob'], 'Bob 是商人。'), entry(1, 'Forest', ['forest'], '森林里住着狼。')]);
    const { merged, conflicts, stats } = mergeBooks(a, b);

    assert.equal(conflicts.length, 0);
    assert.equal(stats.mergedEntries, 4);
    assert.deepEqual(all(merged).map((e) => e.uid), [0, 1, 2, 3]);
    assert.equal(stats.disabledByConflict, 0);
});

test('默认策略：幻想世界 vs 现世世界，两条都禁用', () => {
    const a = book('幻想', [entry(0, '首都', ['城市', '国王'], '这是一座由国王统治的魔法都城。')]);
    const b = book('现世', [entry(0, '首都', ['城市', '市长'], '这是一座由市长管理的现代都市。')]);
    const { merged, stats } = mergeBooks(a, b);

    assert.equal(stats.conflictGroups, 1);
    assert.equal(stats.disabledByConflict, 2, '冲突双方都必须被禁用');

    const [fantasy, modern] = [a, b].map((bk, i) => {
        const src = Object.values(bk.entries)[0];
        return all(merged).find((e) => e.content === src.content);
    });
    assert.equal(fantasy.disable, true);
    assert.equal(modern.disable, true, '用户还没选，两条都不能生效');
});

test('冲突条目被拉到最顶，且两条相邻', () => {
    const a = book('A', [
        entry(0, '普通条目', ['normal'], '无关内容。', { order: 300 }),
        entry(1, '首都', ['城市'], '幻想都城。'),
    ]);
    const b = book('B', [
        entry(0, '首都', ['城市'], '现代都市。'),
    ]);
    const { merged, stats } = mergeBooks(a, b);

    assert.ok(stats.conflictOnTop, '冲突条目必须排在最前');
    const sorted = all(merged).sort((x, y) => y.order - x.order);
    assert.ok(sorted[0].comment.includes('冲突'), `最顶应是冲突条目，实际 ${sorted[0].comment}`);
    assert.ok(sorted[1].comment.includes('冲突'), '第二条也应是冲突条目');
    assert.ok(sorted[0].order > 300, 'order 必须高于原本最高的 300');
    assert.equal(Math.abs(sorted[0].order - sorted[1].order), 1, '同一组的两条应相邻');
});

test('冲突条目带组号，方便界面做成二选一', () => {
    const a = book('幻想', [entry(0, '首都', ['城市'], '幻想都城。')]);
    const b = book('现世', [entry(0, '首都', ['城市'], '现代都市。')]);
    const { merged, groups } = mergeBooks(a, b);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].enabled, 'none', '默认一个都不启用');
    assert.equal(groups[0].a.title, '首都');
    assert.equal(groups[0].b.title, '首都');

    const tagged = byTitlePrefix(merged, '⚠冲突1');
    assert.equal(tagged.length, 2, '两条都要打上同一组号');
    assert.equal(merged.extensions.fridge_merge.groups.length, 1, '来源信息里要留下分组');
});

test('非冲突条目保持原有启用状态和 order', () => {
    const a = book('A', [
        entry(0, '首都', ['城市'], '幻想。'),
        entry(1, '地图', ['地图'], '一张羊皮纸地图。', { order: 250 }),
    ]);
    const b = book('B', [entry(0, '首都', ['城市'], '现代。')]);
    const { merged } = mergeBooks(a, b);

    const map = all(merged).find((e) => e.comment === '地图');
    assert.equal(map.order, 250, '无关条目的 order 不能被改');
    assert.equal(map.disable, false, '无关条目不能被误禁用');
});

test('prefer-a：直接丢掉 B 的冲突条目，不做置顶', () => {
    const a = book('A', [entry(0, '首都', ['城市'], '幻想。')]);
    const b = book('B', [
        entry(0, '首都', ['城市'], '现代。'),
        entry(1, 'Bob', ['bob'], '商人。'),
    ]);
    const { merged, stats } = mergeBooks(a, b, { onConflict: 'prefer-a' });
    assert.equal(stats.droppedFromB, 1);
    assert.equal(stats.mergedEntries, 2);
    assert.equal(stats.disabledByConflict, 0);
    assert.ok(!all(merged).some((e) => e.content === '现代。'));
});

test('keep-both：两条都保留并启用（用户明确要求时才用）', () => {
    const a = book('A', [entry(0, '首都', ['城市'], '幻想。')]);
    const b = book('B', [entry(0, '首都', ['城市'], '现代。')]);
    const { merged, stats, groups } = mergeBooks(a, b, { onConflict: 'keep-both' });
    assert.equal(stats.disabledByConflict, 0);
    assert.equal(groups[0].enabled, 'both');
    assert.ok(all(merged).every((e) => e.disable === false));
});

test('严重度高的冲突组排在最顶', () => {
    const a = book('A', [
        entry(0, '配角', ['sword'], '剑术。'),
        entry(1, 'Alice', ['alice'], 'Alice 是剑士。'),
    ]);
    const b = book('B', [
        entry(0, '铁匠', ['sword'], '铁匠铺。'),
        entry(1, 'Alice', ['alice'], 'Alice 是法师。'),
    ]);
    const { merged, stats } = mergeBooks(a, b);
    assert.equal(stats.conflictGroups, 2);
    const sorted = all(merged).sort((x, y) => y.order - x.order);
    assert.ok(sorted[0].comment.includes('冲突1'), `最顶应是第 1 组，实际 ${sorted[0].comment}`);
    assert.ok(sorted[0].comment.includes('Alice'), '第 1 组应该是同名的高严重度冲突');
});

test('手动标记的冲突对：语义互斥也能被做成二选一', () => {
    // 自动检测抓不到这两条（标题和触发词都不重叠）
    const a = book('幻想', [entry(0, '魔法学院', ['学院'], '城中最高处矗立着魔法学院。')]);
    const b = book('现世', [entry(0, '写字楼', ['公司'], '城南是密集的写字楼群。')]);

    const auto = mergeBooks(a, b);
    assert.equal(auto.stats.conflictGroups, 0, '自动检测确实抓不到');

    const manual = mergeBooks(a, b, { manualPairs: [[0, 0]] });
    assert.equal(manual.stats.conflictGroups, 1);
    assert.equal(manual.stats.disabledByConflict, 2);
    assert.equal(manual.conflicts[0].type[0], 'manual');
    assert.ok(manual.stats.conflictOnTop);
});

test('空书不炸', () => {
    const { stats } = mergeBooks(book('A', []), book('B', [entry(0, 'X', ['x'], 'Y')]));
    assert.equal(stats.mergedEntries, 1);
});

test('合并结果带来源标记', () => {
    const { merged } = mergeBooks(
        book('甲', [entry(0, 'X', ['x'], '1')]),
        book('乙', [entry(0, 'Y', ['y'], '2')]),
        { name: '临时书 C' });
    assert.equal(merged.name, '临时书 C');
    assert.deepEqual(merged.extensions.fridge_merge.sources, ['甲', '乙']);
});

test('相似度函数本身', () => {
    assert.equal(similarity('Alice', 'alice'), 1);
    assert.ok(similarity('Alice', 'Alicia') > 0.2);
    assert.equal(similarity('完全不同的内容', 'another thing'), 0);
    assert.equal(norm('  Alice!  '), 'alice');
});
