/**
 * merge.js — 世界书拼合 + 冲突检测（纯函数，无依赖、无 DOM）
 *
 * 「冲突」分三类，只有前两类是结构性的、能确定性判断：
 *   1. 同名条目   comment 相同/极相似           → 很可能是同一个设定的两份版本
 *   2. 触发词重叠 key 有交集                     → 两条会同时被激活，可能互相矛盾
 *   3. 内容近似   content 三元组相似度 ≥ 阈值     → 疑似重复描述（弱信号，默认只提示）
 *
 * 做不到的：判断两段文字「语义上矛盾」（"她是姐姐" vs "她是妹妹"）。
 * 那需要语义模型，插件里不做，也不假装能做。
 */

const MAX_UID = 1e9;

/** 归一化：去空白、小写、去首尾标点 */
function norm(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
        .trim();
}

/** 切成 trigram 集合，用于相似度 */
function trigrams(s) {
    const t = norm(s).replace(/\s+/g, '');
    const out = new Set();
    if (t.length <= 3) {
        if (t) out.add(t);
        return out;
    }
    for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
    return out;
}

/** Jaccard 相似度 0..1 */
function similarity(a, b) {
    const A = trigrams(a);
    const B = trigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}

/** 取条目数组（ST 的 entries 是 {uid: entry}） */
function entryList(book) {
    const entries = book?.entries || {};
    return Object.entries(entries).map(([k, e]) => ({ uid: String(e?.uid ?? k), e }));
}

/** 条目标题：comment 优先，没有就用内容首行 */
function titleOf(entry) {
    const c = String(entry?.comment || '').trim();
    if (c) return c;
    const first = String(entry?.content || '').split('\n').find(Boolean) || '';
    return first.trim().slice(0, 40);
}

/** 触发词归一化成集合 */
function keySet(entry) {
    const raw = entry?.key;
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return new Set(arr.map(norm).filter(Boolean));
}

const DEFAULTS = {
    titleThreshold: 0.85,     // comment 相似度 ≥ 这个值算同名
    contentThreshold: 0.8,    // 正文相似度 ≥ 这个值算疑似重复
    onConflict: 'keep-both',  // keep-both | prefer-a | prefer-b
    renameDuplicates: true,   // keep-both 时给 B 的条目加上 "(B)" 后缀
};

/**
 * 拼合两本世界书。
 * @returns {{ merged: object, conflicts: Array, stats: object }}
 */
function mergeBooks(bookA, bookB, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const A = entryList(bookA);
    const B = entryList(bookB);

    const conflicts = [];
    const dropFromB = new Set();   // B 里要丢掉的 uid
    const renameB = new Map();     // B 里要改名的 uid -> 新标题

    for (const x of A) {
        const ax = x.e;
        const axKeys = keySet(ax);
        const axTitle = titleOf(ax);

        for (const y of B) {
            if (dropFromB.has(y.uid)) continue;
            const by = y.e;
            const byTitle = titleOf(by);
            const byKeys = keySet(by);

            const titleSim = similarity(axTitle, byTitle);
            const sharedKeys = [...axKeys].filter((k) => byKeys.has(k));
            const contentSim = similarity(ax.content, by.content);

            const hit = [];
            if (titleSim >= opts.titleThreshold) hit.push('title');
            if (sharedKeys.length) hit.push('keys');
            if (contentSim >= opts.contentThreshold) hit.push('content');
            if (!hit.length) continue;

            conflicts.push({
                type: hit,
                severity: hit.includes('title') ? 'high' : (hit.includes('keys') ? 'medium' : 'low'),
                a: { uid: x.uid, title: axTitle, keys: [...axKeys] },
                b: { uid: y.uid, title: byTitle, keys: [...byKeys] },
                titleSimilarity: Number(titleSim.toFixed(3)),
                contentSimilarity: Number(contentSim.toFixed(3)),
                sharedKeys,
                resolution: opts.onConflict,
            });

            if (opts.onConflict === 'prefer-a') {
                dropFromB.add(y.uid);
            } else if (opts.onConflict === 'prefer-b') {
                // 保留 B，丢掉 A：这里用相反的策略，交给调用方处理
                conflicts[conflicts.length - 1].resolution = 'prefer-b(未自动应用)';
            } else if (opts.renameDuplicates && hit.includes('title')) {
                renameB.set(y.uid, `${byTitle} (B)`);
            }
        }
    }

    // ---- 组装：A 原样，B 重新编号
    const merged = {
        name: opts.name || `${bookA?.name || 'A'} + ${bookB?.name || 'B'}`,
        entries: {},
        extensions: {
            fridge_merge: {
                sources: [bookA?.name || 'A', bookB?.name || 'B'],
                created: new Date().toISOString(),
                conflicts: conflicts.length,
                mode: opts.onConflict,
            },
        },
    };

    let nextUid = 0;
    for (const { uid, e } of A) {
        const clone = JSON.parse(JSON.stringify(e));
        clone.uid = nextUid++;
        merged.entries[String(clone.uid)] = clone;
    }

    let dropped = 0;
    for (const { uid, e } of B) {
        if (dropFromB.has(uid)) { dropped++; continue; }
        const clone = JSON.parse(JSON.stringify(e));
        clone.uid = nextUid++;
        if (renameB.has(uid)) clone.comment = renameB.get(uid);
        merged.entries[String(clone.uid)] = clone;
    }

    // 防呆：uid 必须唯一且连续
    const uids = Object.values(merged.entries).map((e) => e.uid);
    const unique = new Set(uids);
    if (unique.size !== uids.length) throw new Error('merge produced duplicate uids');

    return {
        merged,
        conflicts,
        stats: {
            aEntries: A.length,
            bEntries: B.length,
            mergedEntries: nextUid,
            droppedFromB: dropped,
            renamed: renameB.size,
            conflictCount: conflicts.length,
            byType: {
                title: conflicts.filter((c) => c.type.includes('title')).length,
                keys: conflicts.filter((c) => c.type.includes('keys')).length,
                content: conflicts.filter((c) => c.type.includes('content')).length,
            },
        },
    };
}

export { mergeBooks, similarity, norm, titleOf, keySet, DEFAULTS };
