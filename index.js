/**
 * 批量删除世界书条目 — SillyTavern 扩展 v1.1
 *
 * 世界书支持多选：勾几本，条目表按书分组列出，一次跨书批量删除。
 * 删除前每本各自自动下载一份备份 JSON。
 *
 * 全部走 HTTP 接口，不依赖 ST 内部函数（版本差异太大）：
 *   POST /api/worldinfo/list   → [{file_id, name, extensions}]
 *   POST /api/worldinfo/get    → { entries: {...}, ... }
 *   POST /api/worldinfo/edit   → 写回整个文件
 */

const MODULE = 'batch_worldinfo_delete';

/** 世界书数据：name -> { data, error } */
const bookCache = new Map();
/** 已选中的世界书名 */
const selectedBooks = new Set();
/** 已选中的条目：`${book}::${uid}` */
const selectedEntries = new Set();

let bookFilter = '';
let entryFilter = '';
let busy = false;

// ---------------------------------------------------------------- 工具

/**
 * ST 的请求头（含 CSRF token）必须从 script.js 导入，不能靠 window 上猜。
 * 缺了 X-CSRF-Token，服务端一律 403 —— 表现就是「每本世界书都读取失败」。
 */
let getHeadersFn = null;
async function resolveHeaders() {
    if (getHeadersFn) return getHeadersFn();

    // 1) 官方来源
    try {
        const m = await import('../../../../script.js');
        if (typeof m.getRequestHeaders === 'function') {
            getHeadersFn = m.getRequestHeaders;
            return getHeadersFn();
        }
    } catch (err) {
        console.warn('[batch-wi] 无法从 script.js 取 getRequestHeaders', err);
    }

    // 2) 全局兜底
    if (typeof window.getRequestHeaders === 'function') {
        getHeadersFn = () => window.getRequestHeaders();
        return getHeadersFn();
    }

    // 3) 最后：自己拼，至少带上 CSRF
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
        || window.token
        || '';
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
        const hint = res.status === 403 ? '（多半是 CSRF token 没带上）' : '';
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

/** 纯数字的串大概率是下标/序号，不是文件名 */
/** CSS.escape 在老浏览器/嵌入式 webview 里可能没有，做个兜底 */
function cssEscape(v) {
    const str = String(v);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
    return str.replace(/[^a-zA-Z0-9_-]/g, (ch) => String.fromCharCode(92) + ch);
}

function looksNumeric(s) {
    return /^\d+$/.test(String(s || '').trim());
}

/** 从接口返回的一项里挑出「真正的世界书名」 */
function pickName(item) {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';

    const candidates = [
        ['name', item.name],
        ['file_id', item.file_id],
        ['filename', item.filename],
        ['world', item.world],
    ]
        .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : ''])
        .filter(([, v]) => v);

    // 优先非纯数字的；都像数字就只能取第一个
    const nonNumeric = candidates.find(([, v]) => !looksNumeric(v));
    if (nonNumeric) return nonNumeric[1];
    return candidates.length ? candidates[0][1] : '';
}

function entryLabel(e) {
    const name = (e.comment || '').trim();
    if (name) return name;
    const firstLine = String(e.content || '').split(/\r?\n/).find(l => l.trim());
    return firstLine ? firstLine.trim().slice(0, 40) : `(条目 ${e.uid})`;
}

function entryKeys(e) {
    const k = e.key ?? e.keys ?? [];
    return Array.isArray(k) ? k.join(', ') : String(k || '');
}

function backup(name, data) {
    try {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
        console.warn('[batch-wi] 备份失败', err);
    }
}

// ---------------------------------------------------------------- 数据

async function fetchWorldList() {
    // 0) ST 自己维护的名单最可靠
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

    // 1) 退回 list 接口
    try {
        const list = await post('/api/worldinfo/list', {});
        if (Array.isArray(list) && list.length) {
            const names = list.map(pickName).filter(Boolean);
            const uniq = Array.from(new Set(names));
            if (uniq.length) return uniq;
        }
    } catch (err) {
        console.warn('[batch-wi] list 接口不可用，退回读取下拉框', err);
    }

    // 2) 兜底：读 ST 自己的世界书下拉框。
    //    注意有的版本 option 的 value 是下标、文字才是名字，所以优先取文字。
    const fromDom = Array.from(document.querySelectorAll('#world_info option'))
        .map((o) => {
            const text = (o.textContent || '').trim();
            const value = (o.value || '').trim();
            if (text && !looksNumeric(text)) return text;
            if (value && !looksNumeric(value)) return value;
            return text || value;
        })
        .filter(Boolean);
    return Array.from(new Set(fromDom));
}

let wiModule = undefined;
async function getWiModule() {
    if (wiModule !== undefined) return wiModule;
    try {
        wiModule = await import('../../../world-info.js');
    } catch (err) {
        console.warn('[batch-wi] world-info.js 不可导入，改走接口', err);
        wiModule = null;
    }
    return wiModule;
}

async function loadBook(name) {
    const cached = bookCache.get(name);
    if (cached && !cached.error) return cached;

    const rec = { data: null, error: null };
    const errors = [];

    // 1) 首选 ST 自己的加载函数（带缓存、带正确的请求头）
    const wi = await getWiModule();
    for (const fn of ['loadWorldInfo', 'loadWorldInfoData']) {
        if (wi && typeof wi[fn] === 'function') {
            try {
                const data = await wi[fn](name);
                if (data && typeof data === 'object') {
                    if (!data.entries) data.entries = {};
                    rec.data = data;
                    rec.error = null;
                    bookCache.set(name, rec);
                    return rec;
                }
            } catch (err) {
                errors.push(`${fn}: ${err.message}`);
            }
        }
    }

    // 2) 退回直接调接口
    try {
        const data = await post('/api/worldinfo/get', { name });
        rec.data = data && typeof data === 'object' ? data : { entries: {} };
        if (!rec.data.entries) rec.data.entries = {};
        rec.error = null;
    } catch (err) {
        rec.data = null;
        rec.error = err.message;
        errors.push(err.message);
    }

    if (rec.error) console.warn('[batch-wi] 读取失败', name, errors.join(' | '));
    bookCache.set(name, rec);
    return rec;
}

async function saveBook(name, data) {
    try {
        const wi = await import('../../../world-info.js');
        if (typeof wi.saveWorldInfo === 'function') {
            await wi.saveWorldInfo(name, data, true);
            return;
        }
    } catch { /* 老版本没有导出，走接口 */ }
    await post('/api/worldinfo/edit', { name, data });
}

/** 当前选中书目的所有条目，按书分组 */
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

// ---------------------------------------------------------------- 渲染

function renderBooks() {
    const all = window.__bwdBooks || [];
    const shown = bookFilter ? all.filter(n => n.toLowerCase().includes(bookFilter)) : all;
    const $list = $('#bwd_book_list');
    if (!all.length) {
        $list.html('<div class="bwd-empty">没有读到世界书。点「刷新列表」试试。</div>');
        return;
    }
    if (!shown.length) {
        $list.html('<div class="bwd-empty">没有匹配的世界书</div>');
        return;
    }
    $list.html(shown.map((n) => {
        const rec = bookCache.get(n);
        const count = rec?.data ? Object.keys(rec.data.entries).length : null;
        const badge = rec?.error
            ? `<span class="bwd-tag bwd-off" title="${esc(rec.error)}">读取失败</span>`
            : (count === null ? '' : `<span class="bwd-tag bwd-n">${count}</span>`);
        return `<label class="bwd-book-row" title="${esc(n)}">
            <input type="checkbox" class="bwd-book-cb" data-book="${esc(n)}" ${selectedBooks.has(n) ? 'checked' : ''}>
            <span class="bwd-book-name">${esc(n)}</span>${badge}
        </label>`;
    }).join(''));
}

/** 只刷新计数行，不碰表格 DOM（手机上重绘会打断点击手势） */
function updateCount() {
    const groups = groupedEntries();
    const totalEntries = groups.reduce((s, g) => s + g.total, 0);
    const shownEntries = groups.reduce((s, g) => s + g.rows.length, 0);
    $('#bwd_count').text(
        `已选 ${selectedBooks.size} 本 · 共 ${totalEntries} 条 · 显示 ${shownEntries} 条 · 已勾 ${selectedEntries.size} 条`
    );
}

function renderEntries() {
    const groups = groupedEntries();
    const $t = $('#bwd_table');

    updateCount();

    if (!selectedBooks.size) {
        $t.html('<div class="bwd-empty">上面勾一本或多本世界书</div>');
        return;
    }

    const parts = [];
    for (const g of groups) {
        if (!g.rows.length) continue;
        const rows = g.rows.map(({ uid, e }) => {
            const key = `${g.book}::${uid}`;
            const checked = selectedEntries.has(key) ? 'checked' : '';
            const flags = [];
            if (e.disable) flags.push('<span class="bwd-tag bwd-off">禁用</span>');
            if (e.constant) flags.push('<span class="bwd-tag bwd-const">常驻</span>');
            const len = String(e.content || '').length;
            const preview = String(e.content || '').replace(/\s+/g, ' ').slice(0, 70);
            return `<tr data-key="${esc(key)}">
                <td class="bwd-c"><input type="checkbox" class="bwd-cb" data-key="${esc(key)}" ${checked}></td>
                <td class="bwd-name" title="${esc(entryLabel(e))}">${esc(entryLabel(e))} ${flags.join('')}</td>
                <td class="bwd-keys" title="${esc(entryKeys(e))}">${esc(entryKeys(e).slice(0, 24))}</td>
                <td class="bwd-len">${len}</td>
                <td class="bwd-prev">${esc(preview)}</td>
            </tr>`;
        }).join('');

        parts.push(`<div class="bwd-group">
            <div class="bwd-group-head">
                <label><input type="checkbox" class="bwd-group-cb" data-book="${esc(g.book)}"> <b>${esc(g.book)}</b></label>
                <span class="bwd-group-meta">${g.rows.length} / ${g.total} 条</span>
            </div>
            <table class="bwd-tbl">
                <thead><tr><th class="bwd-c"></th><th>名称</th><th>触发词</th><th>字数</th><th>内容预览</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`);
    }

    $t.html(parts.length ? parts.join('') : '<div class="bwd-empty">没有匹配的条目</div>');
}

function renderAll() {
    renderBooks();
    renderEntries();
}

// ---------------------------------------------------------------- 动作

async function toggleBook(name, on) {
    if (on) selectedBooks.add(name); else selectedBooks.delete(name);
    if (on) {
        $('#bwd_status').text(`加载《${name}》…`);
        await loadBook(name);
        $('#bwd_status').text(`已加载《${name}》`);
    } else {
        // 取消这本书时，把它名下的选中条目一起清掉
        for (const key of Array.from(selectedEntries)) {
            if (key.startsWith(`${name}::`)) selectedEntries.delete(key);
        }
    }
    renderAll();
}

async function refreshList() {
    const list = await fetchWorldList();
    window.__bwdBooks = list.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
    $('#bwd_status').text(`读到 ${list.length} 本世界书`);
    renderBooks();
}

/** 以 DOM 里实际的勾选状态兜底对齐一次，防止集合与界面不同步 */
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

async function doDelete() {
    if (busy) return;
    harvestFromDom();
    if (!selectedEntries.size) {
        const boxes = document.querySelectorAll('#bwd_table .bwd-cb').length;
        $('#bwd_status').text(
            `没有勾选任何条目（表格里有 ${boxes} 个复选框，已选 ${selectedBooks.size} 本）。` +
            `请先勾选要删除的条目。`
        );
        return;
    }

    // 按书分组
    const byBook = new Map();
    for (const key of selectedEntries) {
        const idx = key.lastIndexOf('::');
        const book = key.slice(0, idx);
        const uid = key.slice(idx + 2);
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(uid);
    }

    const preview = Array.from(byBook.entries())
        .slice(0, 6)
        .map(([b, uids]) => `《${b}》${uids.length} 条`)
        .join('\n');
    const more = byBook.size > 6 ? `\n…共 ${byBook.size} 本` : '';

    const ok = window.confirm(
        `将删除 ${selectedEntries.size} 条，涉及 ${byBook.size} 本世界书：\n${preview}${more}\n\n` +
        `每本删除前会自动下载一份备份 JSON。\n此操作不可撤销，继续？`
    );
    if (!ok) return;

    busy = true;
    $('#bwd_delete').prop('disabled', true);
    const results = [];

    try {
        for (const [book, uids] of byBook) {
            const rec = bookCache.get(book);
            if (!rec?.data) { results.push(`《${book}》未加载，跳过`); continue; }

            backup(book, rec.data);
            for (const uid of uids) delete rec.data.entries[uid];

            $('#bwd_status').text(`保存《${book}》…`);
            try {
                await saveBook(book, rec.data);
                results.push(`《${book}》删 ${uids.length} 条`);
            } catch (err) {
                results.push(`《${book}》保存失败：${err.message}`);
            }
            // 重新读一次，拿到服务端真实状态
            bookCache.delete(book);
            await loadBook(book);
        }

        selectedEntries.clear();
        renderAll();
        $('#bwd_status').text(`完成：${results.join('；')}。若列表没刷新，切换一次世界书或刷新页面。`);
    } finally {
        busy = false;
        $('#bwd_delete').prop('disabled', false);
    }
}

// ---------------------------------------------------------------- 绑定

function bind() {
    $('#bwd_refresh').off('click').on('click', refreshList);

    $('#bwd_book_search').off('input').on('input', function () {
        bookFilter = ($(this).val() || '').toLowerCase();
        renderBooks();
    });

    $(document).off('change.bwd', '.bwd-book-cb').on('change.bwd', '.bwd-book-cb', function () {
        const name = $(this).data('book').toString();
        toggleBook(name, this.checked);
    });

    $('#bwd_book_all').off('click').on('click', async () => {
        const shown = (window.__bwdBooks || []).filter(n => !bookFilter || n.toLowerCase().includes(bookFilter));
        for (const n of shown) if (!selectedBooks.has(n)) selectedBooks.add(n);
        $('#bwd_status').text(`加载 ${shown.length} 本…`);
        await Promise.all(shown.map(loadBook));
        $('#bwd_status').text(`已选 ${selectedBooks.size} 本`);
        renderAll();
    });

    $('#bwd_book_none').off('click').on('click', () => {
        selectedBooks.clear();
        selectedEntries.clear();
        renderAll();
    });

    $('#bwd_entry_search').off('input').on('input', function () {
        entryFilter = ($(this).val() || '').toLowerCase();
        renderEntries();
    });

    // 勾选只更新集合与计数，绝不重绘表格 —— 重绘会让手机上的这次点击落到已销毁的节点上，
    // 浏览器随后补发一次 change(checked=false)，一加一减就变成"什么都没选"。
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
            $(`.bwd-cb[data-key="${cssEscape(key)}"]`).prop('checked', on);
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
        // 每本书内部做去重：内容相同的保留第一条，其余勾上
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

    $('#bwd_delete').off('click').on('click', doDelete);
}

// ---------------------------------------------------------------- 安装

jQuery(async () => {
    const html = `
    <div class="bwd-panel" id="bwd_root">
        <div class="bwd-title">批量删除世界书条目</div>
        <div class="bwd-hint">勾选一本或多本世界书 → 勾要删的条目 → 删除。每本删除前都会自动下载备份 JSON。</div>

        <div class="bwd-sec-title">1. 选世界书（可多选）</div>
        <div class="bwd-row">
            <input id="bwd_book_search" class="text_pole" type="text" placeholder="筛选世界书名称…">
            <button id="bwd_refresh" class="menu_button">刷新</button>
        </div>
        <div class="bwd-row bwd-tools">
            <button id="bwd_book_all" class="menu_button">全选</button>
            <button id="bwd_book_none" class="menu_button">清空</button>
        </div>
        <div id="bwd_book_list" class="bwd-book-list"></div>

        <div class="bwd-sec-title">2. 勾要删除的条目</div>
        <div class="bwd-row">
            <input id="bwd_entry_search" class="text_pole" type="text" placeholder="搜索名称 / 触发词 / 内容…">
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
            <span id="bwd_status" class="bwd-status"></span>
        </div>
    </div>`;

    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $target.append(html);
    bind();

    await refreshList();

    // 若世界书面板正开着某本，自动勾上它
    const current = document.querySelector('#world_editor_select')?.selectedOptions?.[0]?.textContent?.trim();
    const books = window.__bwdBooks || [];
    if (current && books.includes(current)) {
        await toggleBook(current, true);
    }

    console.log(`[${MODULE}] ready`);
});
