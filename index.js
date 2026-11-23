/**
 * 批量删除世界书条目 — SillyTavern 扩展
 *
 * 只做一件事：把世界书里的一堆条目一次删掉，并且删之前自动备份。
 * 不依赖 ST 的内部函数（版本差异太大），全部走 HTTP 接口：
 *   POST /api/worldinfo/list   → [{file_id, name, extensions}]
 *   POST /api/worldinfo/get    → { entries: {...}, ... }
 *   POST /api/worldinfo/edit   → 写回整个文件
 *
 * 若当前版本导出了 saveWorldInfo，则优先用它（它会顺手刷新 ST 的缓存、发事件）。
 */

const MODULE = 'batch_worldinfo_delete';

let currentWorld = null;   // 世界书名
let worldData = null;      // 整个 world JSON
let selected = new Set();  // 选中的 uid（字符串）
let filterText = '';

// ---------------------------------------------------------------- 工具

function headers() {
    // ST 把 getRequestHeaders 挂在全局（不同版本导出位置不同，这里做兜底）
    if (typeof window.getRequestHeaders === 'function') {
        return window.getRequestHeaders();
    }
    const h = { 'Content-Type': 'application/json' };
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (token) h['X-CSRF-Token'] = token;
    return h;
}

async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${url} → HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : null;
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

/** 删除前把整本世界书下载下来，出事了还能导回去 */
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
    try {
        const list = await post('/api/worldinfo/list', {});
        if (Array.isArray(list)) return list.map(x => x.file_id || x.name).filter(Boolean);
    } catch (err) {
        console.warn('[batch-wi] list 接口不可用，退回读取下拉框', err);
    }
    // 兜底：ST 自己会把世界书列表填进 #world_info
    return Array.from(document.querySelectorAll('#world_info option'))
        .map(o => o.value).filter(Boolean);
}

async function loadWorld(name) {
    const data = await post('/api/worldinfo/get', { name });
    if (!data || typeof data !== 'object') throw new Error('返回数据为空');
    if (!data.entries) data.entries = {};
    return data;
}

async function saveWorld(name, data) {
    // 优先用 ST 自己的保存函数：它会刷新缓存并发 WORLDINFO_UPDATED 事件
    try {
        const wi = await import('../../../world-info.js');
        if (typeof wi.saveWorldInfo === 'function') {
            await wi.saveWorldInfo(name, data, true);
            return;
        }
    } catch (err) {
        // 老版本没有导出，忽略
    }
    await post('/api/worldinfo/edit', { name, data });
}

// ---------------------------------------------------------------- 渲染

function entriesArray() {
    if (!worldData?.entries) return [];
    return Object.entries(worldData.entries).map(([uid, e]) => ({ uid: String(e.uid ?? uid), e }));
}

function visibleEntries() {
    const all = entriesArray();
    if (!filterText) return all;
    const q = filterText.toLowerCase();
    return all.filter(({ e }) =>
        entryLabel(e).toLowerCase().includes(q) ||
        String(e.content || '').toLowerCase().includes(q) ||
        entryKeys(e).toLowerCase().includes(q)
    );
}

function render() {
    const $root = $('#bwd_root');
    if (!$root.length) return;

    const vis = visibleEntries();
    const total = entriesArray().length;

    $('#bwd_count').text(`共 ${total} 条，当前显示 ${vis.length} 条，已选 ${selected.size} 条`);

    if (!worldData) {
        $('#bwd_table').html('<div class="bwd-empty">先选一本世界书</div>');
        return;
    }
    if (!vis.length) {
        $('#bwd_table').html('<div class="bwd-empty">没有匹配的条目</div>');
        return;
    }

    const rows = vis.map(({ uid, e }) => {
        const checked = selected.has(uid) ? 'checked' : '';
        const flags = [];
        if (e.disable) flags.push('<span class="bwd-tag bwd-off">禁用</span>');
        if (e.constant) flags.push('<span class="bwd-tag bwd-const">常驻</span>');
        const len = String(e.content || '').length;
        const preview = String(e.content || '').replace(/\s+/g, ' ').slice(0, 80);
        return `<tr data-uid="${esc(uid)}">
            <td class="bwd-c"><input type="checkbox" class="bwd-cb" data-uid="${esc(uid)}" ${checked}></td>
            <td class="bwd-name" title="${esc(entryLabel(e))}">${esc(entryLabel(e))} ${flags.join('')}</td>
            <td class="bwd-keys" title="${esc(entryKeys(e))}">${esc(entryKeys(e).slice(0, 30))}</td>
            <td class="bwd-len">${len}</td>
            <td class="bwd-prev" title="${esc(preview)}">${esc(preview)}</td>
        </tr>`;
    }).join('');

    $('#bwd_table').html(`<table class="bwd-tbl">
        <thead><tr>
            <th class="bwd-c"><input type="checkbox" id="bwd_cb_all"></th>
            <th>名称</th><th>触发词</th><th>字数</th><th>内容预览</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`);
}

// ---------------------------------------------------------------- 动作

async function pickWorld(name) {
    currentWorld = name;
    selected.clear();
    const $status = $('#bwd_status');
    if (!name) {
        worldData = null;
        render();
        return;
    }
    $status.text('加载中…');
    try {
        worldData = await loadWorld(name);
        $status.text(`已加载：${name}`);
    } catch (err) {
        worldData = null;
        $status.text('加载失败：' + err.message);
    }
    render();
}

async function doDelete() {
    if (!currentWorld || !worldData) return;
    if (selected.size === 0) {
        $('#bwd_status').text('没有选中任何条目');
        return;
    }

    const chosen = entriesArray().filter(({ uid }) => selected.has(uid));
    const names = chosen.slice(0, 5).map(({ e }) => entryLabel(e)).join('、');
    const more = chosen.length > 5 ? ` 等 ${chosen.length} 条` : '';

    const ok = window.confirm(
        `将从《${currentWorld}》删除 ${chosen.length} 条：\n${names}${more}\n\n` +
        `删除前会自动下载一份备份 JSON。\n此操作不可撤销，继续？`
    );
    if (!ok) return;

    backup(currentWorld, worldData);

    for (const { uid } of chosen) {
        delete worldData.entries[uid];
    }

    $('#bwd_status').text('保存中…');
    try {
        await saveWorld(currentWorld, worldData);
        const removed = selected.size;
        selected.clear();
        worldData = await loadWorld(currentWorld);
        render();
        $('#bwd_status').text(`已删除 ${removed} 条，剩余 ${entriesArray().length} 条。若界面没刷新，切换一次世界书即可。`);
    } catch (err) {
        $('#bwd_status').text('保存失败：' + err.message);
    }
}

// ---------------------------------------------------------------- 安装 UI

function bind() {
    $('#bwd_refresh').off('click').on('click', async () => {
        const list = await fetchWorldList();
        const $sel = $('#bwd_world');
        $sel.empty().append('<option value="">— 选择世界书 —</option>');
        list.sort().forEach(n => $sel.append(`<option value="${esc(n)}">${esc(n)}</option>`));
        $('#bwd_status').text(`世界书 ${list.length} 本`);
    });

    $('#bwd_world').off('change').on('change', async function () {
        await pickWorld($(this).val());
    });

    $('#bwd_search').off('input').on('input', function () {
        filterText = $(this).val() || '';
        render();
    });

    $(document).off('change.bwd', '.bwd-cb').on('change.bwd', '.bwd-cb', function () {
        const uid = $(this).data('uid').toString();
        if (this.checked) selected.add(uid); else selected.delete(uid);
        render();
    });

    $(document).off('change.bwd', '#bwd_cb_all').on('change.bwd', '#bwd_cb_all', function () {
        const on = this.checked;
        visibleEntries().forEach(({ uid }) => on ? selected.add(uid) : selected.delete(uid));
        render();
    });

    $('#bwd_sel_none').off('click').on('click', () => { selected.clear(); render(); });
    $('#bwd_sel_invert').off('click').on('click', () => {
        visibleEntries().forEach(({ uid }) => selected.has(uid) ? selected.delete(uid) : selected.add(uid));
        render();
    });
    $('#bwd_sel_empty').off('click').on('click', () => {
        selected.clear();
        visibleEntries().forEach(({ uid, e }) => {
            if (!String(e.content || '').trim()) selected.add(uid);
        });
        render();
    });
    $('#bwd_sel_disabled').off('click').on('click', () => {
        selected.clear();
        visibleEntries().forEach(({ uid, e }) => { if (e.disable) selected.add(uid); });
        render();
    });
    $('#bwd_sel_dupe').off('click').on('click', () => {
        // 内容完全重复的条目：保留第一条，其余选中
        selected.clear();
        const seen = new Map();
        visibleEntries().forEach(({ uid, e }) => {
            const norm = String(e.content || '').replace(/\s+/g, ' ').trim();
            if (!norm) return;
            if (seen.has(norm)) selected.add(uid); else seen.set(norm, uid);
        });
        render();
    });

    $('#bwd_delete').off('click').on('click', doDelete);
}

jQuery(async () => {
    const html = `
    <div class="bwd-panel" id="bwd_root">
        <div class="bwd-title">批量删除世界书条目</div>
        <div class="bwd-hint">选一本、勾要删的、点删除。删除前会自动下载备份 JSON。</div>

        <div class="bwd-row">
            <select id="bwd_world" class="text_pole"><option value="">— 选择世界书 —</option></select>
            <button id="bwd_refresh" class="menu_button">刷新列表</button>
        </div>

        <div class="bwd-row">
            <input id="bwd_search" class="text_pole" type="text" placeholder="搜索名称 / 触发词 / 内容…">
        </div>

        <div class="bwd-row bwd-tools">
            <button id="bwd_sel_none" class="menu_button">全不选</button>
            <button id="bwd_sel_invert" class="menu_button">反选</button>
            <button id="bwd_sel_empty" class="menu_button">选中空条目</button>
            <button id="bwd_sel_disabled" class="menu_button">选中已禁用</button>
            <button id="bwd_sel_dupe" class="menu_button">选中重复内容</button>
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

    const list = await fetchWorldList();
    const $sel = $('#bwd_world');
    list.sort().forEach(n => $sel.append(`<option value="${esc(n)}">${esc(n)}</option>`));
    $('#bwd_status').text(`世界书 ${list.length} 本`);

    // 如果世界书面板里已经选中了某本，直接跟过去
    const preset = document.querySelector('#world_editor_select')?.selectedOptions?.[0]?.textContent?.trim();
    if (preset && list.includes(preset)) {
        $sel.val(preset);
        await pickWorld(preset);
    }

    console.log(`[${MODULE}] ready`);
});
