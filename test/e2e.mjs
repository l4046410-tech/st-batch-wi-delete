/**
 * e2e.mjs — 在 jsdom 里真的跑一遍 v1.1（多选世界书）
 *
 * 重点验证两件事：
 *   1. /api/worldinfo/list 里 file_id 是数字、name 才是书名时，界面显示的是书名而不是编号
 *   2. 能同时勾多本世界书，跨书批量删除，每本各自备份
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const code = fs.readFileSync(path.resolve('index.js'), 'utf8');

// ---------------- 模拟世界书
const worlds = {
  '测试书': {
    entries: {
      0: { uid: 0, comment: '开场', key: ['开始'], content: '这是开场内容', disable: false, constant: true },
      1: { uid: 1, comment: '空条目', key: [], content: '', disable: false },
      2: { uid: 2, comment: '重复A', key: ['a'], content: '一样的内容', disable: false },
      3: { uid: 3, comment: '重复B', key: ['b'], content: '一样的内容', disable: false },
      4: { uid: 4, comment: '旧的', key: ['old'], content: '过时设定', disable: true },
      5: { uid: 5, comment: '保留这条', key: ['keep'], content: '重要内容', disable: false },
    },
  },
  '另一本': {
    entries: {
      0: { uid: 0, comment: 'X', key: ['x'], content: 'x', disable: false },
      1: { uid: 1, comment: '空的', key: [], content: '', disable: false },
    },
  },
};

let backups = 0;
const calls = [];

/** 关键：模拟「file_id 是数字、name 才是书名」这种版本 */
function mockList() {
  return Object.keys(worlds).map((n, i) => ({
    file_id: String(i),      // 数字，像下标
    name: n,                 // 真名字
    extensions: {},
  }));
}

function mockFetch(url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push(u);

  const reply = (obj) => Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  });

  if (u.endsWith('/api/worldinfo/list')) return reply(mockList());
  if (u.endsWith('/api/worldinfo/get')) {
    const w = worlds[body.name];
    return reply(w ? structuredClone(w) : { entries: {} });
  }
  if (u.endsWith('/api/worldinfo/edit')) {
    worlds[body.name] = structuredClone(body.data);
    return reply({ ok: true });
  }
  return Promise.reject(new Error('unexpected fetch: ' + u));
}

// ---------------- jsdom
const dom = new JSDOM(
  `<!doctype html><html><head><meta name="csrf-token" content="tok"></head>
   <body><div id="extensions_settings2"></div><div id="extensions_settings"></div></body></html>`,
  { runScripts: 'outside-only', url: 'http://localhost:8000/' }
);

const { window } = dom;
window.fetch = mockFetch;
window.confirm = () => true;
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { backups++; };

global.window = window;
global.document = window.document;
const $ = require('jquery');
window.$ = window.jQuery = $;

window.eval(code);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : ' ' + extra}`);
};

await sleep(80);

console.log('\n[1] 面板与世界书列表');
check('面板挂载', $('#bwd_root').length === 1);
const bookNames = $('#bwd_book_list .bwd-book-name').map((i, el) => $(el).text().trim()).get();
check('列出了 2 本世界书', bookNames.length === 2, JSON.stringify(bookNames));
check('显示的是书名而不是编号', bookNames.includes('测试书') && bookNames.includes('另一本'), JSON.stringify(bookNames));
check('没有出现纯数字书名', !bookNames.some((n) => /^\d+$/.test(n)), JSON.stringify(bookNames));

console.log('\n[2] 多选：勾第一本');
await new Promise((r) => { $('.bwd-book-cb[data-book="测试书"]').prop('checked', true).trigger('change'); setTimeout(r, 80); });
check('测试书 6 条已渲染', $('#bwd_table tbody tr').length === 6, `实际 ${$('#bwd_table tbody tr').length}`);
check('计数显示已选 1 本', $('#bwd_count').text().includes('已选 1 本'), $('#bwd_count').text());

console.log('\n[3] 多选：再勾第二本');
await new Promise((r) => { $('.bwd-book-cb[data-book="另一本"]').prop('checked', true).trigger('change'); setTimeout(r, 80); });
check('两个分组都出现', $('.bwd-group').length === 2, `实际 ${{}.constructor.name ? $('.bwd-group').length : 0}`);
check('条目总数 6+2=8 行', $('#bwd_table tbody tr').length === 8, `实际 ${$('#bwd_table tbody tr').length}`);
check('计数显示已选 2 本', $('#bwd_count').text().includes('已选 2 本'), $('#bwd_count').text());

console.log('\n[4] 快捷选择「空条目」跨书生效');
$('#bwd_sel_empty').trigger('click');
await sleep(20);
check('勾中 2 条空条目（两本各一条）', $('#bwd_count').text().includes('已勾 2 条'), $('#bwd_count').text());

console.log('\n[5] 手工勾一条（旧条目）');
$('#bwd_entry_search').val('旧的').trigger('input');
await sleep(20);
check('搜索后只剩 1 行', $('#bwd_table tbody tr').length === 1, `实际 ${$('#bwd_table tbody tr').length}`);
$('#bwd_table .bwd-cb').prop('checked', true).trigger('change');
await sleep(20);
check('已勾 3 条', $('#bwd_count').text().includes('已勾 3 条'), $('#bwd_count').text());

console.log('\n[6] 跨书删除');
const beforeA = Object.keys(worlds['测试书'].entries).length;
const beforeB = Object.keys(worlds['另一本'].entries).length;
$('#bwd_delete').trigger('click');
await sleep(200);
const afterA = Object.keys(worlds['测试书'].entries).length;
const afterB = Object.keys(worlds['另一本'].entries).length;

check(`测试书 ${beforeA} → ${afterA}（删 2）`, afterA === beforeA - 2, `实际 ${afterA}`);
check(`另一本 ${beforeB} → ${afterB}（删 1）`, afterB === beforeB - 1, `实际 ${afterB}`);
check('测试书保留 uid 0', '0' in worlds['测试书'].entries);
check('测试书删除 uid 1（空）', !('1' in worlds['测试书'].entries));
check('测试书删除 uid 4（旧的）', !('4' in worlds['测试书'].entries));
check('另一本删除 uid 1（空的）', !('1' in worlds['另一本'].entries));
check('删除前两本各自备份', backups >= 2, `backups=${backups}`);
check('edit 接口被调用', calls.filter((u) => u.endsWith('/edit')).length >= 1);

const pass = results.filter((r) => r.ok).length;
console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
