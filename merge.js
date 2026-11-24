/**
 * merge.js — 世界书拼合 + 冲突检测（纯函数，无依赖、无 DOM）
 *
 * 设计前提（来自实际使用场景）：
 *   A 是幻想世界，B 是现世世界。两套设定互斥，同时生效会让模型收到矛盾指令。
 *   所以拼合产物 C 里，**冲突的两条默认都禁用**，并把它们排到列表最顶，
 *   由用户自己决定开哪一条。工具不替用户选世界观。
 *
 * 「冲突」只查结构性重叠：
 *   1. 同名条目   comment 相似度 ≥ 阈值      → 高
 *   2. 触发词重叠 key 有交集                  → 中
 *   3. 内容近似   content 相似度 ≥ 阈值       → 低（仅提示）
 * 语义矛盾（"她是姐姐" vs "她是妹妹"）需要语言模型，本插件不做，也不假装做。
 *
 * ST 的排序规则（读 public/scripts/world-info.js 确认）：
 *   const sortFn = (a, b) => b.order - a.order;   // order 越大越靠上
 */

function norm(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
        .trim();
}

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

function similarity(a, b) {
    const A = trigrams(a);
    const B = trigrams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}

function entryList(book) {
    const entries = book?.entries || {};
    return Object.entries(entries).map(([k, e]) => ({ uid: String(e?.uid ?? k), e }));
}

function titleOf(entry) {
    const c = String(entry?.comment || '').trim();
    if (c) return c;
    const first = String(entry?.content || '').split('\n').find(Boolean) || '';
    return first.trim().slice(0, 40);
}

function keySet(entry) {
    const raw = entry?.key;
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return new Set(arr.map(norm).filter(Boolean));
}

const DEFAULTS = {
    titleThreshold: 0.85,
    contentThreshold: 0.8,
    /**
     * disable-both（默认）：冲突双方都禁用 + 置顶，让用户二选一
     * prefer-a           ：丢弃 B 的冲突条目
     * keep-both          ：都保留且都启用（危险，只在用户明确要求时用）
     */
    onConflict: 'disable-both',
    markPrefix: '⚠冲突',
    // 用户手动指定的冲突对：[[aUid, bUid], ...]
    // 自动检测只能抓到结构性重叠，"魔法学院 vs 写字楼"这种语义互斥抓不到，
    // 必须让用户能自己圈出来。
    manualPairs: [],
};

const DEFAULT_ORDER = 100;

function mergeBooks(bookA, bookB, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const A = entryList(bookA);
    const B = entryList(bookB);

    // ---- 1. 找冲突对
    const pairs = [];
    for (const x of A) {
        const axTitle = titleOf(x.e);
        const axKeys = keySet(x.e);
        for (const y of B) {
            const byTitle = titleOf(y.e);
            const byKeys = keySet(y.e);
            const titleSim = similarity(axTitle, byTitle);
            const sharedKeys = [...axKeys].filter((k) => byKeys.has(k));
            const contentSim = similarity(x.e.content, y.e.content);

            const hit = [];
            if (titleSim >= opts.titleThreshold) hit.push('title');
            if (sharedKeys.length) hit.push('keys');
            if (contentSim >= opts.contentThreshold) hit.push('content');
            if (!hit.length) continue;

            pairs.push({
                aUid: x.uid, bUid: y.uid,
                aTitle: axTitle, bTitle: byTitle,
                type: hit,
                severity: hit.includes('title') ? 'high' : (hit.includes('keys') ? 'medium' : 'low'),
                sharedKeys,
                titleSimilarity: Number(titleSim.toFixed(3)),
                contentSimilarity: Number(contentSim.toFixed(3)),
            });
        }
    }

    // 手动配对：不看相似度，用户说冲突就是冲突
    const seenPair = new Set(pairs.map((p) => `${p.aUid}::${p.bUid}`));
    for (const [aUid, bUid] of (opts.manualPairs || [])) {
        const key = `${aUid}::${bUid}`;
        if (seenPair.has(key)) continue;
        const ax = A.find((x) => x.uid === String(aUid));
        const by = B.find((y) => y.uid === String(bUid));
        if (!ax || !by) continue;
        seenPair.add(key);
        pairs.push({
            aUid: ax.uid, bUid: by.uid,
            aTitle: titleOf(ax.e), bTitle: titleOf(by.e),
            type: ['manual'],
            severity: 'high',
            sharedKeys: [...keySet(ax.e)].filter((k) => keySet(by.e).has(k)),
            titleSimilarity: null,
            contentSimilarity: null,
            manual: true,
        });
    }

    // ---- 2. 决定每个条目在产物里的命运
    const maxOrder = Math.max(
        DEFAULT_ORDER,
        ...A.map(({ e }) => Number(e?.order) || DEFAULT_ORDER),
        ...B.map(({ e }) => Number(e?.order) || DEFAULT_ORDER),
    );

    const dropFromB = new Set();
    const orderOverride = new Map();   // `${side}:${uid}` -> newOrder
    const disableOverride = new Map(); // `${side}:${uid}` -> true
    const tag = new Map();             // `${side}:${uid}` -> 前缀说明
    const groups = [];

    // 冲突对按严重度排序，最严重的那个组排在最顶上
    const rank = { high: 0, medium: 1, low: 2 };  // 手动标记的也算 high
    pairs.sort((p, q) => rank[p.severity] - rank[q.severity]);

    const top = maxOrder + pairs.length * 2 + 10;
    pairs.forEach((p, i) => {
        const groupNo = i + 1;
        const groupId = `merge-${groupNo}`;
        p.group = groupNo;
        p.groupId = groupId;

        if (opts.onConflict === 'prefer-a') {
            dropFromB.add(p.bUid);
            p.resolution = 'prefer-a';
            return;
        }

        // 默认（disable-both）与 keep-both 都要置顶；只有 disable-both 改 disable
        const orderA = top - i * 2;
        const orderB = orderA - 1;
        orderOverride.set(`a:${p.aUid}`, orderA);
        orderOverride.set(`b:${p.bUid}`, orderB);
        tag.set(`a:${p.aUid}`, `${opts.markPrefix}${groupNo}`);
        tag.set(`b:${p.bUid}`, `${opts.markPrefix}${groupNo}`);

        if (opts.onConflict !== 'keep-both') {
            disableOverride.set(`a:${p.aUid}`, true);
            disableOverride.set(`b:${p.bUid}`, true);
        }
        p.resolution = opts.onConflict;

        groups.push({
            group: groupNo,
            groupId,
            severity: p.severity,
            a: { uid: p.aUid, title: p.aTitle },
            b: { uid: p.bUid, title: p.bTitle },
            enabled: opts.onConflict === 'keep-both' ? 'both' : 'none',
        });
    });

    // ---- 3. 组装（A 先，B 后，uid 重排）
    const merged = {
        name: opts.name || `${bookA?.name || 'A'} + ${bookB?.name || 'B'}`,
        entries: {},
        extensions: {
            fridge_merge: {
                sources: [bookA?.name || 'A', bookB?.name || 'B'],
                created: new Date().toISOString(),
                mode: opts.onConflict,
                conflictGroups: groups.length,
                // 让界面以后能重建「二选一」控件，而不是让用户自己去找
                groups,
            },
        },
    };

    let nextUid = 0;
    let disabled = 0;

    const place = (side, uid, e) => {
        const clone = JSON.parse(JSON.stringify(e));
        clone.uid = nextUid++;
        const o = orderOverride.get(`${side}:${uid}`);
        if (o !== undefined) clone.order = o;
        if (disableOverride.get(`${side}:${uid}`)) {
            clone.disable = true;
            disabled++;
        }
        const t = tag.get(`${side}:${uid}`);
        if (t) clone.comment = `${t} ${titleOf(e)}`;
        merged.entries[String(clone.uid)] = clone;
    };

    for (const { uid, e } of A) place('a', uid, e);

    let dropped = 0;
    for (const { uid, e } of B) {
        if (dropFromB.has(uid)) { dropped++; continue; }
        place('b', uid, e);
    }

    // ---- 4. 防呆
    const uids = Object.values(merged.entries).map((e) => e.uid);
    if (new Set(uids).size !== uids.length) throw new Error('merge produced duplicate uids');

    const sorted = Object.values(merged.entries).sort((a, b) => b.order - a.order);
    const topOnes = sorted.slice(0, Math.max(1, groups.length * 2));
    const conflictTopOk = groups.every((g) =>
        topOnes.some((e) => e.comment.startsWith(`${opts.markPrefix}${g.group} `)));

    return {
        merged,
        conflicts: pairs,
        groups,
        stats: {
            aEntries: A.length,
            bEntries: B.length,
            mergedEntries: nextUid,
            droppedFromB: dropped,
            disabledByConflict: disabled,
            conflictCount: pairs.length,
            conflictGroups: groups.length,
            conflictOnTop: conflictTopOk,
            byType: {
                title: pairs.filter((c) => c.type.includes('title')).length,
                keys: pairs.filter((c) => c.type.includes('keys')).length,
                content: pairs.filter((c) => c.type.includes('content')).length,
            },
        },
    };
}

export { mergeBooks, similarity, norm, titleOf, keySet, DEFAULTS };
