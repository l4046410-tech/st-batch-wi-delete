/**
 * 世界书批量删除 — SillyTavern 扩展 v2.0
 *
 * 主功能：多选世界书 → 一键删除整本（可选"全部"），删除前打包备份成一个 JSON。
 * 附赠：删除世界书内部的条目（折叠在下面）。
 *
 * 接口：
 *   POST /api/worldinfo/list   { }                → [{file_id,name}]
 *   POST /api/worldinfo/get    { name }           → world json
 *   POST /api/worldinfo/delete { name }           → 删文件
 *   POST /api/worldinfo/edit   { name, data }     → 写回
 */

const MODULE = 'batch_worldinfo_delete';

/** name -> { data, error } */
const bookCache = new Map();
/** 已勾选的世界书 */
const selectedBooks = new Set();
/** 条目选择：`${book}::${uid}` */
const selectedEntries = new Set();

let bookFilter = '';
let entryFilter = '';
let busy = false;


// ---------------------------------------------------------------- 中英切换

const LANGS = {
    zh: {
        title: '世界书批量删除',
        hint: '勾选一本或多本世界书 → 一键删除整本。删除前会把选中的书打包成一个备份 JSON 下载。',
        sec1: '① 删除整本世界书',
        sec2: '② 只删除书里的某些条目（不删书）',
        searchBooks: '筛选世界书名称…',
        searchEntries: '搜索条目名称 / 触发词 / 内容…',
        refresh: '刷新', selectAll: '全选', clearSel: '清空',
        delSelected: (n) => (n ? `删除选中的 ${n} 本世界书` : '删除选中的世界书'),
        delAll: (n) => (n ? `删除全部 ${n} 本` : '删除全部世界书'),
        selNone: '全不选', selInvert: '反选', selEmpty: '空条目',
        selDisabled: '已禁用', selDupe: '重复内容',
        delEntries: '删除选中条目',
        emptyNoBooks: '没有读到世界书。点「刷新」试试。',
        emptyNoMatchBooks: '没有匹配的世界书',
        emptyNoMatchEntries: '没有匹配的条目',
        tagFailed: '读取失败', tagDisabled: '禁用', tagConstant: '常驻',
        thName: '名称', thKeys: '触发词', thWords: '字数', thPreview: '内容预览',
        grpMeta: (shown, total) => `${shown} / ${total} 条`,
        info: (b, t, s2, e) => `已选 ${b} 本 · 共 ${t} 条 · 显示 ${s2} 条 · 已勾 ${e} 条`,
        needBooks: '上面勾一本或多本世界书',
        loadingBook: (n) => `加载《${n}》…`,
        loadedBook: (n) => `已加载《${n}》`,
        readN: (n) => `读到 ${n} 本世界书`,
        noBookPicked: '没有勾选世界书',
        moreBooks: (n) => `\n…共 ${n} 本`,
        confirmBooks: (n, preview, more) => `将删除 ${n} 本世界书（整本文件，不是其中条目）：\n${preview}${more}\n\n删除前会把这些书打包成一个备份 JSON 下载。\n不可撤销，继续？`,
        backingUp: '备份中…',
        backupAborted: '备份失败，已中止（没有删除任何东西）',
        deletingBook: (n) => `删除《${n}》…`,
        doneSummary: (ok, bad, bf, hint) => `删除完成：成功 ${ok} 本，失败 ${bad} 本。` + (bf ? `（${bf} 本备份时读取失败）` : '') + hint,
        doneHint: ' 若酒馆列表没变，刷新页面即可。',
        listEmpty: '列表是空的',
        confirmAll: (n, word) => `这会删除全部 ${n} 本世界书，且不可撤销。\n删除前会打包下载一个备份 JSON。\n\n确认请输入：${word}`,
        confirmWord: '全部删除',
        badInput: '输入不匹配，已取消',
        noEntryPicked: (b) => `没有勾选任何条目（已选 ${b} 本）`,
        confirmEntries: (n, b) => `将删除 ${n} 条，涉及 ${b} 本世界书（只删条目，不删书）。继续？`,
        bookNotLoaded: (b) => `《${b}》未加载`,
        savingBook: (b) => `保存《${b}》…`,
        entryDeleted: (b, n) => `《${b}》删 ${n} 条`,
        entryFailed: (b, m) => `《${b}》失败：${m}`,
        entryDone: (list) => `完成：${list.join('；')}`,
        statusLoadingN: (n) => `加载 ${n} 本…`,
        selectedN: (n) => `已选 ${n} 本`,
        cleared: '已清空选择',
        csrfHint: '（CSRF token 没带上）',
        backupBooks: (n) => `世界书备份_${n}本`,
        backupEntries: (b) => `条目备份_${b}`,
        entryFallback: (uid) => `(条目 ${uid})`,
        sep: '；',
    },
    en: {
        title: 'World Book Bulk Delete',
        hint: 'Tick one or more world books → delete the whole file in one click. A backup JSON of everything selected is downloaded first.',
        sec1: '① Delete whole world books',
        sec2: '② Delete individual entries (keeps the book)',
        searchBooks: 'Filter world books…',
        searchEntries: 'Search name / keywords / content…',
        refresh: 'Refresh', selectAll: 'Select all', clearSel: 'Clear',
        delSelected: (n) => (n ? `Delete ${n} selected` : 'Delete selected'),
        delAll: (n) => (n ? `Delete all ${n}` : 'Delete all world books'),
        selNone: 'Select none', selInvert: 'Invert', selEmpty: 'Empty',
        selDisabled: 'Disabled', selDupe: 'Duplicates',
        delEntries: 'Delete selected entries',
        emptyNoBooks: 'No world books found. Try Refresh.',
        emptyNoMatchBooks: 'No matching world books',
        emptyNoMatchEntries: 'No matching entries',
        tagFailed: 'failed', tagDisabled: 'off', tagConstant: 'const',
        thName: 'Name', thKeys: 'Keywords', thWords: 'Chars', thPreview: 'Preview',
        grpMeta: (shown, total) => `${shown} / ${total} entries`,
        info: (b, t, s2, e) => `${b} books · ${t} entries · showing ${s2} · ${e} ticked`,
        needBooks: 'Tick one or more world books above',
        loadingBook: (n) => `Loading "${n}"…`,
        loadedBook: (n) => `Loaded "${n}"`,
        readN: (n) => `${n} world books`,
        noBookPicked: 'No world books selected',
        moreBooks: (n) => `\n…${n} books in total`,
        confirmBooks: (n, preview, more) => `Delete ${n} world book(s) — whole files, not entries:\n${preview}${more}\n\nA single backup JSON of these books downloads first.\nThis cannot be undone. Continue?`,
        backingUp: 'Backing up…',
        backupAborted: 'Backup failed — nothing was deleted',
        deletingBook: (n) => `Deleting "${n}"…`,
        doneSummary: (ok, bad, bf, hint) => `Done: ${ok} deleted, ${bad} failed.` + (bf ? ` (${bf} unreadable for backup)` : '') + hint,
        doneHint: ' If the list looks unchanged, refresh the page.',
        listEmpty: 'The list is empty',
        confirmAll: (n, word) => `This deletes all ${n} world books and cannot be undone.\nA backup JSON downloads first.\n\nType to confirm: ${word}`,
        confirmWord: 'DELETE ALL',
        badInput: 'Text did not match — cancelled',
        noEntryPicked: (b) => `No entries ticked (${b} books selected)`,
        confirmEntries: (n, b) => `Delete ${n} entries across ${b} world book(s)? The books themselves stay.`,
        bookNotLoaded: (b) => `"${b}" not loaded`,
        savingBook: (b) => `Saving "${b}"…`,
        entryDeleted: (b, n) => `"${b}": ${n} deleted`,
        entryFailed: (b, m) => `"${b}" failed: ${m}`,
        entryDone: (list) => `Done: ${list.join('; ')}`,
        statusLoadingN: (n) => `Loading ${n}…`,
        selectedN: (n) => `${n} selected`,
        cleared: 'Selection cleared',
        csrfHint: ' (CSRF token missing)',
        backupBooks: (n) => `worldbook_backup_${n}books`,
        backupEntries: (b) => `entries_backup_${b}`,
        entryFallback: (uid) => `(entry ${uid})`,
        sep: '; ',
    },
};

let LANG = 'zh';
try { LANG = window.localStorage?.getItem('bwd_lang') || 'zh'; } catch { /* 隐私模式 */ }
const L = () => LANGS[LANG] || LANGS.zh;

/** 把当前语言的文案刷到所有静态控件上，再重绘动态区域 */
function applyLang() {
    const l = L();
    $('#bwd_root .bwd-title').text(l.title);
    $('#bwd_root .bwd-hint').text(l.hint);
    $('#bwd_drawer_books .bwd-drawer-title').text(l.sec1);
    $('#bwd_drawer_entries .bwd-drawer-title').text(l.sec2);
    $('#bwd_book_search').attr('placeholder', l.searchBooks);
    $('#bwd_entry_search').attr('placeholder', l.searchEntries);
    $('#bwd_refresh').text(l.refresh);
    $('#bwd_book_all').text(l.selectAll);
    $('#bwd_book_none').text(l.clearSel);
    $('#bwd_sel_none').text(l.selNone);
    $('#bwd_sel_invert').text(l.selInvert);
    $('#bwd_sel_empty').text(l.selEmpty);
    $('#bwd_sel_disabled').text(l.selDisabled);
    $('#bwd_sel_dupe').text(l.selDupe);
    $('#bwd_delete').text(l.delEntries);
    $('#bwd_lang').text(LANG === 'zh' ? 'EN' : '中');
    updateBookButtons();
    renderAll();
}

// ---------------------------------------------------------------- 基础

let getHeadersFn = null;
async function resolveHeaders() {
    if (getHeadersFn) return getHeadersFn();

    try {
        const m = await import('../../../../script.js');
        if (typeof m.getRequestHeaders === 'function') {
            getHeadersFn = m.getRequestHeaders;
            return getHeadersFn();
        }
    } catch (err) {
        console.warn('[batch-wi] 无法从 script.js 取 getRequestHeaders', err);
    }

    if (typeof window.getRequestHeaders === 'function') {
        getHeadersFn = () => window.getRequestHeaders();
        return getHeadersFn();
    }

    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || window.token || '';
    getHeadersFn = () => {
        const h = { 'Content-Type': 'application/json' };
        if (token) h['X-CSRF-Token'] = token;
        return h;
    };
    return getHeadersFn();
}

async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: await resolveHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const hint = res.status === 403 ? L().csrfHint : '';
        throw new Error(`HTTP ${res.status}${hint} ${text.slice(0, 120)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : null;
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function looksNumeric(s) {
    return /^\d+$/.test(String(s || '').trim());
}

function pickName(item) {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    const candidates = [item.name, item.file_id, item.filename, item.world]
        .map(v => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean);
    const nonNumeric = candidates.find(v => !looksNumeric(v));
    return nonNumeric || candidates[0] || '';
}

function entryLabel(e) {
    const name = (e.comment || '').trim();
    if (name) return name;
    const firstLine = String(e.content || '').split(/\r?\n/).find(l => l.trim());
    return firstLine ? firstLine.trim().slice(0, 40) : L().entryFallback(e.uid);
}

function entryKeys(e) {
    const k = e.key ?? e.keys ?? [];
    return Array.isArray(k) ? k.join(', ') : String(k || '');
}

/** 一次下载一个文件，把多本世界书打包进去（避免浏览器拦截批量下载） */
function downloadBackup(payload, label) {
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${label}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        return true;
    } catch (err) {
        console.warn('[batch-wi] 备份失败', err);
        return false;
    }
}

// ---------------------------------------------------------------- 数据

let wiModule = undefined;
async function getWiModule() {
    if (wiModule !== undefined) return wiModule;
    try {
        wiModule = await import('../../../world-info.js');
    } catch (err) {
        console.warn('[batch-wi] world-info.js 不可导入', err);
        wiModule = null;
    }
    return wiModule;
}

async function fetchWorldList() {
    try {
        const wi = await getWiModule();
        if (wi && Array.isArray(wi.world_names) && wi.world_names.length) {
            return Array.from(new Set(wi.world_names.filter(Boolean)));
        }
        if (wi && typeof wi.getWorldInfoList === 'function') {
            const list = await wi.getWorldInfoList();
            if (Array.isArray(list) && list.length) {
                return Array.from(new Set(list.map(pickName).filter(Boolean)));
            }
        }
    } catch (err) {
        console.warn('[batch-wi] 读 world_names 失败', err);
    }

    try {
        const list = await post('/api/worldinfo/list', {});
        if (Array.isArray(list) && list.length) {
            const uniq = Array.from(new Set(list.map(pickName).filter(Boolean)));
            if (uniq.length) return uniq;
        }
    } catch (err) {
        console.warn('[batch-wi] list 接口不可用，退回读下拉框', err);
    }

    return Array.from(new Set(
        Array.from(document.querySelectorAll('#world_info option'))
            .map((o) => {
                const text = (o.textContent || '').trim();
                const value = (o.value || '').trim();
                if (text && !looksNumeric(text)) return text;
                if (value && !looksNumeric(value)) return value;
                return text || value;
            })
            .filter(Boolean)
    ));
}

async function loadBook(name) {
    const cached = bookCache.get(name);
    if (cached && !cached.error) return cached;

    const rec = { data: null, error: null };
    const wi = await getWiModule();

    for (const fn of ['loadWorldInfo', 'loadWorldInfoData']) {
        if (wi && typeof wi[fn] === 'function') {
            try {
                const data = await wi[fn](name);
                if (data && typeof data === 'object') {
                    if (!data.entries) data.entries = {};
                    rec.data = data;
                    bookCache.set(name, rec);
                    return rec;
                }
            } catch (err) { /* 试下一个 */ }
        }
    }

    try {
        const data = await post('/api/worldinfo/get', { name });
        rec.data = data && typeof data === 'object' ? data : { entries: {} };
        if (!rec.data.entries) rec.data.entries = {};
    } catch (err) {
        rec.error = err.message;
        console.warn('[batch-wi] 读取失败', name, err.message);
    }
    bookCache.set(name, rec);
    return rec;
}

async function deleteBookFile(name) {
    try {
        const wi = await getWiModule();
        if (wi && typeof wi.deleteWorldInfo === 'function') {
            const ok = await wi.deleteWorldInfo(name);
            if (ok !== false) return;
        }
    } catch (err) { /* 走接口 */ }
    await post('/api/worldinfo/delete', { name });
}

async function saveBook(name, data) {
    try {
        const wi = await getWiModule();
        if (wi && typeof wi.saveWorldInfo === 'function') {
            await wi.saveWorldInfo(name, data, true);
            return;
        }
    } catch { /* 走接口 */ }
    await post('/api/worldinfo/edit', { name, data });
}

// ---------------------------------------------------------------- 渲染：世界书列表

function renderBooks() {
    const all = window.__bwdBooks || [];
    const shown = bookFilter ? all.filter(n => n.toLowerCase().includes(bookFilter)) : all;
    const $list = $('#bwd_book_list');

    if (!all.length) {
        $list.html(`<div class="bwd-empty">${L().emptyNoBooks}</div>`);
        return;
    }
    if (!shown.length) {
        $list.html(`<div class="bwd-empty">${L().emptyNoMatchBooks}</div>`);
        return;
    }

    $list.html(shown.map((n) => {
        const rec = bookCache.get(n);
        const count = rec?.data ? Object.keys(rec.data.entries).length : null;
        const badge = rec?.error
            ? `<span class="bwd-tag bwd-off" title="${esc(rec.error)}">${L().tagFailed}</span>`
            : (count === null ? '' : `<span class="bwd-tag bwd-n">${count}</span>`);
        return `<label class="bwd-book-row" title="${esc(n)}">
            <input type="checkbox" class="bwd-book-cb" data-book="${esc(n)}" ${selectedBooks.has(n) ? 'checked' : ''}>
            <span class="bwd-book-name">${esc(n)}</span>${badge}
        </label>`;
    }).join(''));

    updateBookButtons();
}

function updateBookButtons() {
    const n = selectedBooks.size;
    $('#bwd_del_books').text(L().delSelected(n));
    const total = (window.__bwdBooks || []).length;
    $('#bwd_del_all').text(L().delAll(total));
}

// ---------------------------------------------------------------- 渲染：条目

function groupedEntries() {
    const groups = [];
    for (const book of Array.from(selectedBooks).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))) {
        const rec = bookCache.get(book);
        if (!rec || rec.error || !rec.data) continue;
        const rows = Object.entries(rec.data.entries).map(([uid, e]) => ({ uid: String(e.uid ?? uid), e }));
        const filtered = entryFilter
            ? rows.filter(({ e }) =>
                entryLabel(e).toLowerCase().includes(entryFilter) ||
                String(e.content || '').toLowerCase().includes(entryFilter) ||
                entryKeys(e).toLowerCase().includes(entryFilter))
            : rows;
        groups.push({ book, rows: filtered, total: rows.length });
    }
    return groups;
}

function updateCount() {
    const groups = groupedEntries();
    const totalEntries = groups.reduce((s, g) => s + g.total, 0);
    const shownEntries = groups.reduce((s, g) => s + g.rows.length, 0);
    $('#bwd_count').text(L().info(selectedBooks.size, totalEntries, shownEntries, selectedEntries.size));
}

function renderEntries() {
    const groups = groupedEntries();
    const $t = $('#bwd_table');
    updateCount();

    if (!selectedBooks.size) {
        $t.html(`<div class="bwd-empty">${L().needBooks}</div>`);
        return;
    }

    const parts = [];
    for (const g of groups) {
        if (!g.rows.length) continue;
        const rows = g.rows.map(({ uid, e }) => {
            const key = `${g.book}::${uid}`;
            const checked = selectedEntries.has(key) ? 'checked' : '';
            const flags = [];
            if (e.disable) flags.push(`<span class="bwd-tag bwd-off">${L().tagDisabled}</span>`);
            if (e.constant) flags.push(`<span class="bwd-tag bwd-const">${L().tagConstant}</span>`);
            return `<tr>
                <td class="bwd-c"><input type="checkbox" class="bwd-cb" data-key="${esc(key)}" ${checked}></td>
                <td class="bwd-name" title="${esc(entryLabel(e))}">${esc(entryLabel(e))} ${flags.join('')}</td>
                <td class="bwd-keys">${esc(entryKeys(e).slice(0, 24))}</td>
                <td class="bwd-len">${String(e.content || '').length}</td>
                <td class="bwd-prev">${esc(String(e.content || '').replace(/\s+/g, ' ').slice(0, 70))}</td>
            </tr>`;
        }).join('');

        parts.push(`<div class="bwd-group">
            <div class="bwd-group-head">
                <label><input type="checkbox" class="bwd-group-cb" data-book="${esc(g.book)}"> <b>${esc(g.book)}</b></label>
                <span class="bwd-group-meta">${L().grpMeta(g.rows.length, g.total)}</span>
            </div>
            <table class="bwd-tbl">
                <thead><tr><th class="bwd-c"></th><th>${L().thName}</th><th>${L().thKeys}</th><th>${L().thWords}</th><th>${L().thPreview}</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`);
    }

    $t.html(parts.length ? parts.join('') : `<div class="bwd-empty">${L().emptyNoMatchEntries}</div>`);
}

function renderAll() {
    renderBooks();
    renderEntries();
}

// ---------------------------------------------------------------- 动作

async function toggleBook(name, on) {
    if (on) {
        selectedBooks.add(name);
        $('#bwd_status').text(L().loadingBook(name));
        await loadBook(name);
        $('#bwd_status').text(L().loadedBook(name));
    } else {
        selectedBooks.delete(name);
        for (const key of Array.from(selectedEntries)) {
            if (key.startsWith(`${name}::`)) selectedEntries.delete(key);
        }
    }
    renderAll();
}

async function refreshList() {
    const list = await fetchWorldList();
    window.__bwdBooks = list.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
    $('#bwd_status').text(L().readN(list.length));
    renderBooks();
}

/** 打包备份：把这些书的完整 JSON 塞进一个文件 */
async function backupBooks(names) {
    const payload = {};
    const failed = [];
    for (const n of names) {
        const rec = bookCache.get(n) || (await loadBook(n));
        if (rec?.data) payload[n] = rec.data;
        else failed.push(n);
    }
    if (!Object.keys(payload).length) {
        return { ok: false, failed };
    }
    const ok = downloadBackup(payload, L().backupBooks(names.length));
    return { ok, failed };
}

async function deleteBooks(names, { skipConfirm = false } = {}) {
    if (busy) return;
    if (!names.length) {
        $('#bwd_status').text(L().noBookPicked);
        return;
    }

    if (!skipConfirm) {
        const preview = names.slice(0, 8).join('\n');
        const more = names.length > 8 ? L().moreBooks(names.length) : '';
        const ok = window.confirm(L().confirmBooks(names.length, preview, more));
        if (!ok) return;
    }

    busy = true;
    $('#bwd_del_books, #bwd_del_all').prop('disabled', true);

    try {
        $('#bwd_status').text(L().backingUp);
        const backup = await backupBooks(names);
        if (!backup.ok) {
            $('#bwd_status').text(L().backupAborted);
            return;
        }

        const results = [];
        for (const name of names) {
            $('#bwd_status').text(L().deletingBook(name));
            try {
                await deleteBookFile(name);
                results.push(`✔ ${name}`);
                bookCache.delete(name);
                selectedBooks.delete(name);
                for (const key of Array.from(selectedEntries)) {
                    if (key.startsWith(`${name}::`)) selectedEntries.delete(key);
                }
            } catch (err) {
                results.push(`✘ ${name}：${err.message}`);
            }
        }

        // 刷新列表
        const list = await fetchWorldList();
        window.__bwdBooks = list.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
        renderAll();

        const okCount = results.filter(r => r.startsWith('✔')).length;
        const bad = results.filter(r => r.startsWith('✘'));
        const badText = bad.length ? ' ' + bad.slice(0, 3).join(L().sep) : '';
        $('#bwd_status').text(L().doneSummary(okCount, bad.length, backup.failed.length, badText + L().doneHint));
    } finally {
        busy = false;
        $('#bwd_del_books, #bwd_del_all').prop('disabled', false);
        updateBookButtons();
    }
}

async function deleteAllBooks() {
    const all = window.__bwdBooks || [];
    if (!all.length) {
        $('#bwd_status').text(L().listEmpty);
        return;
    }
    const typed = window.prompt(L().confirmAll(all.length, L().confirmWord), '');
    if (typed === null) return;
    if (typed.trim() !== L().confirmWord) {
        $('#bwd_status').text(L().badInput);
        return;
    }
    await deleteBooks(all.slice(), { skipConfirm: true });
}

/** 以 DOM 实际勾选状态兜底 */
function harvestFromDom() {
    const boxes = document.querySelectorAll('#bwd_table .bwd-cb');
    if (!boxes.length) return;
    let added = 0;
    boxes.forEach((b) => {
        const key = b.getAttribute('data-key');
        if (!key) return;
        if (b.checked && !selectedEntries.has(key)) { selectedEntries.add(key); added++; }
        if (!b.checked) selectedEntries.delete(key);
    });
    if (added) console.log('[batch-wi] 从界面补回', added, '条勾选');
}

async function deleteEntries() {
    if (busy) return;
    harvestFromDom();
    if (!selectedEntries.size) {
        $('#bwd_status').text(L().noEntryPicked(selectedBooks.size));
        return;
    }

    const byBook = new Map();
    for (const key of selectedEntries) {
        const idx = key.lastIndexOf('::');
        const book = key.slice(0, idx);
        const uid = key.slice(idx + 2);
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(uid);
    }

    const ok = window.confirm(L().confirmEntries(selectedEntries.size, byBook.size));
    if (!ok) return;

    busy = true;
    try {
        const done = [];
        for (const [book, uids] of byBook) {
            const rec = bookCache.get(book);
            if (!rec?.data) { done.push(L().bookNotLoaded(book)); continue; }
            downloadBackup({ [book]: rec.data }, L().backupEntries(book));
            for (const uid of uids) delete rec.data.entries[uid];
            $('#bwd_status').text(L().savingBook(book));
            try {
                await saveBook(book, rec.data);
                done.push(L().entryDeleted(book, uids.length));
            } catch (err) {
                done.push(L().entryFailed(book, err.message));
            }
            bookCache.delete(book);
            await loadBook(book);
        }
        selectedEntries.clear();
        renderAll();
        $('#bwd_status').text(L().entryDone(done));
    } finally {
        busy = false;
    }
}

// ---------------------------------------------------------------- 绑定

function bind() {
    $('#bwd_refresh').off('click').on('click', refreshList);

    // 语言按钮在折叠标题行里，点它会冒泡到 inline-drawer-toggle，所以必须拦住
    $('#bwd_lang').off('click.bwdLang').on('click.bwdLang', function (e) {
        e.preventDefault();
        e.stopPropagation();
        LANG = LANG === 'zh' ? 'en' : 'zh';
        try { window.localStorage?.setItem('bwd_lang', LANG); } catch { /* 隐私模式 */ }
        applyLang();
    });

    $('#bwd_book_search').off('input').on('input', function () {
        bookFilter = ($(this).val() || '').toLowerCase();
        renderBooks();
    });

    $(document).off('change.bwd', '.bwd-book-cb').on('change.bwd', '.bwd-book-cb', function () {
        toggleBook($(this).attr('data-book'), this.checked);
    });

    $('#bwd_book_all').off('click').on('click', async () => {
        const shown = (window.__bwdBooks || []).filter(n => !bookFilter || n.toLowerCase().includes(bookFilter));
        shown.forEach(n => selectedBooks.add(n));
        updateBookButtons();
        renderBooks();
        $('#bwd_status').text(L().statusLoadingN(shown.length));
        await Promise.all(shown.map(loadBook));
        $('#bwd_status').text(L().selectedN(selectedBooks.size));
        renderEntries();
    });

    $('#bwd_book_none').off('click').on('click', () => {
        selectedBooks.clear();
        selectedEntries.clear();
        renderAll();
        $('#bwd_status').text(L().cleared);
    });

    $('#bwd_del_books').off('click').on('click', () => deleteBooks(Array.from(selectedBooks)));
    $('#bwd_del_all').off('click').on('click', deleteAllBooks);

    $('#bwd_entry_search').off('input').on('input', function () {
        entryFilter = ($(this).val() || '').toLowerCase();
        renderEntries();
    });

    // 勾选不重绘表格：手机上重绘会吞掉这次点击
    $(document).off('change.bwd', '.bwd-cb').on('change.bwd', '.bwd-cb', function () {
        const key = $(this).attr('data-key');
        if (!key) return;
        if (this.checked) selectedEntries.add(key); else selectedEntries.delete(key);
        updateCount();
    });

    $(document).off('change.bwd', '.bwd-group-cb').on('change.bwd', '.bwd-group-cb', function () {
        const book = $(this).attr('data-book');
        if (!book) return;
        const on = this.checked;
        const g = groupedEntries().find(x => x.book === book);
        if (!g) return;
        g.rows.forEach(({ uid }) => {
            const key = `${book}::${uid}`;
            if (on) selectedEntries.add(key); else selectedEntries.delete(key);
            $(`.bwd-cb[data-key="${esc(key)}"]`).prop('checked', on);
        });
        updateCount();
    });

    $('#bwd_sel_none').off('click').on('click', () => { selectedEntries.clear(); renderEntries(); });
    $('#bwd_sel_invert').off('click').on('click', () => {
        groupedEntries().forEach(g => g.rows.forEach(({ uid }) => {
            const key = `${g.book}::${uid}`;
            selectedEntries.has(key) ? selectedEntries.delete(key) : selectedEntries.add(key);
        }));
        renderEntries();
    });
    $('#bwd_sel_empty').off('click').on('click', () => {
        selectedEntries.clear();
        groupedEntries().forEach(g => g.rows.forEach(({ uid, e }) => {
            if (!String(e.content || '').trim()) selectedEntries.add(`${g.book}::${uid}`);
        }));
        renderEntries();
    });
    $('#bwd_sel_disabled').off('click').on('click', () => {
        selectedEntries.clear();
        groupedEntries().forEach(g => g.rows.forEach(({ uid, e }) => {
            if (e.disable) selectedEntries.add(`${g.book}::${uid}`);
        }));
        renderEntries();
    });
    $('#bwd_sel_dupe').off('click').on('click', () => {
        selectedEntries.clear();
        groupedEntries().forEach(g => {
            const seen = new Set();
            g.rows.forEach(({ uid, e }) => {
                const norm = String(e.content || '').replace(/\s+/g, ' ').trim();
                if (!norm) return;
                if (seen.has(norm)) selectedEntries.add(`${g.book}::${uid}`);
                else seen.add(norm);
            });
        });
        renderEntries();
    });

    $('#bwd_delete').off('click').on('click', deleteEntries);
}

// ---------------------------------------------------------------- 折叠

const DRAWER_KEYS = {
    root: 'bwd_open_root',
    books: 'bwd_open_books',
    entries: 'bwd_open_entries',
};

function loadDrawerState(key, fallback) {
    try {
        const v = window.localStorage?.getItem(key);
        if (v === null || v === undefined) return fallback;
        return v === '1';
    } catch {
        return fallback;
    }
}

function saveDrawerState(key, open) {
    try { window.localStorage?.setItem(key, open ? '1' : '0'); } catch { /* 隐私模式 */ }
}

function setDrawer($drawer, open, key) {
    $drawer.toggleClass('bwd-open', open);
    $drawer.find('> .bwd-drawer-body').toggle(open);
    $drawer.find('> .bwd-drawer-head .bwd-caret').text(open ? '▾' : '▸');
    if (key) saveDrawerState(key, open);
}

function setupDrawers() {
    // 内层两个分区用自己实现的折叠（标题在左、箭头在右，跟 ST 面板一个样子）
    setDrawer($('#bwd_drawer_books'), loadDrawerState(DRAWER_KEYS.books, true));
    setDrawer($('#bwd_drawer_entries'), loadDrawerState(DRAWER_KEYS.entries, false));

    $(document).off('click.bwdDrawer', '#bwd_root .bwd-drawer-head')
        .on('click.bwdDrawer', '#bwd_root .bwd-drawer-head', function (e) {
            if ($(e.target).closest('button, input, select, a, label').length) return;
            const $d = $(this).closest('.bwd-drawer');
            const key = DRAWER_KEYS[$d.attr('data-key')] || null;
            setDrawer($d, !$d.hasClass('bwd-open'), key);
        });

    // 外层用 ST 自己的 inline-drawer —— 但万一 ST 没有绑（老版本 / 面板被重建），
    // 兜底自己切一次。判断方式：点完 30ms 后 display 有没有变化。
    $(document).off('click.bwdRoot', '#bwd_root .inline-drawer-toggle')
        .on('click.bwdRoot', '#bwd_root .inline-drawer-toggle', function () {
            const $content = $('#bwd_root > .inline-drawer > .inline-drawer-content');
            const $icon = $(this).find('.inline-drawer-icon');
            const before = $content.css('display');
            setTimeout(() => {
                if ($content.css('display') === before) {
                    const willShow = before === 'none';
                    $content.css('display', willShow ? '' : 'none');
                    $icon.toggleClass('down', willShow).toggleClass('up', !willShow);
                }
            }, 30);
        });
}

// ---------------------------------------------------------------- 安装

jQuery(async () => {
    const html = `
    <div class="bwd-panel" id="bwd_root">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b class="bwd-title">世界书批量删除</b>
                <button id="bwd_lang" class="menu_button bwd-lang" title="Switch language / 切换语言">EN</button>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down ui-draggable-handle down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="bwd-hint">勾选一本或多本世界书 → 一键删除整本。删除前会把选中的书打包成一个备份 JSON 下载。</div>

                <div class="bwd-drawer bwd-drawer-sub bwd-open" id="bwd_drawer_books" data-key="books">
                    <div class="bwd-drawer-head">
                        <span class="bwd-drawer-title">① 删除整本世界书</span>
                        <span class="bwd-caret">▾</span>
                    </div>
                    <div class="bwd-drawer-body">
                        <div class="bwd-row">
                            <input id="bwd_book_search" class="text_pole" type="text" placeholder="筛选世界书名称…">
                            <button id="bwd_refresh" class="menu_button">刷新</button>
                        </div>
                        <div class="bwd-row bwd-tools">
                            <button id="bwd_book_all" class="menu_button">全选</button>
                            <button id="bwd_book_none" class="menu_button">清空</button>
                        </div>
                        <div id="bwd_book_list" class="bwd-book-list"></div>
                        <div class="bwd-row bwd-footer">
                            <button id="bwd_del_books" class="menu_button bwd-danger">删除选中的世界书</button>
                            <button id="bwd_del_all" class="menu_button bwd-danger">删除全部世界书</button>
                        </div>
                        <div id="bwd_status" class="bwd-status"></div>
                    </div>
                </div>

                <div class="bwd-drawer bwd-drawer-sub" id="bwd_drawer_entries" data-key="entries">
                    <div class="bwd-drawer-head">
                        <span class="bwd-drawer-title">② 只删除书里的某些条目（不删书）</span>
                        <span class="bwd-caret">▸</span>
                    </div>
                    <div class="bwd-drawer-body">
                        <div class="bwd-row" style="margin-top:6px">
                            <input id="bwd_entry_search" class="text_pole" type="text" placeholder="搜索条目名称 / 触发词 / 内容…">
                        </div>
                        <div class="bwd-row bwd-tools">
                            <button id="bwd_sel_none" class="menu_button">全不选</button>
                            <button id="bwd_sel_invert" class="menu_button">反选</button>
                            <button id="bwd_sel_empty" class="menu_button">空条目</button>
                            <button id="bwd_sel_disabled" class="menu_button">已禁用</button>
                            <button id="bwd_sel_dupe" class="menu_button">重复内容</button>
                        </div>
                        <div id="bwd_count" class="bwd-count"></div>
                        <div id="bwd_table" class="bwd-table-wrap"></div>
                        <div class="bwd-row bwd-footer">
                            <button id="bwd_delete" class="menu_button bwd-danger">删除选中条目</button>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>`;

    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $target.append(html);
    bind();
    setupDrawers();

    applyLang();

    await refreshList();
    renderEntries();

    console.log(`[${MODULE}] ready`);
});
