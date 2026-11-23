/**
 * e2e.mjs — 在 jsdom 里真的跑一遍（v1.1 + 移动端勾选修复）
 *
 * 重点验证：
 *   1. /api/worldinfo/list 的 file_id 是数字、name 才是书名时，界面显示书名
 *   2. 世界书可多选，条目按书分组，跨书批量删除，每本各自备份
 *   3. 勾选复选框不会重绘表格（手机上一重绘就会把这次点击吞掉）
 *   4. 即使内部集合与界面不同步，删除前也会从 DOM 兜底捞回勾选项
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

function mockList() {
  // 故意让 file_id 是数字，模拟用户那台酒馆的行为
  return Object.keys(worlds).map((n, i) => ({ file_id: String(i), name: n, extensions: {} }));
}

function mockFetch(url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push(u);
  const reply = (obj) => Promise.resolve({
    ok: true, status: 200,
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
check('显示书名而不是编号', bookNames.includes('测试书') && bookNames.includes('另一本'), JSON.stringify(bookNames));
check('没有纯数字书名', !bookNames.some((n) => /^\d+$/.test(n)), JSON.stringify(bookNames));

console.log('\n[2] 多选：勾第一本');
await new Promise((r) => { $('.bwd-book-cb[data-book="测试书"]').prop('checked', true).trigger('change'); setTimeout(r, 80); });
check('测试书 6 条已渲染', $('#bwd_table tbody tr').length === 6, `实际 ${$('#bwd_table tbody tr').length}`);
check('计数 已选 1 本', $('#bwd_count').text().includes('已选 1 本'), $('#bwd_count').text());

console.log('\n[3] 多选：再勾第二本');
await new Promise((r) => { $('.bwd-book-cb[data-book="另一本"]').prop('checked', true).trigger('change'); setTimeout(r, 80); });
check('出现两个分组', $('.bwd-group').length === 2, `实际 ${$('.bwd-group').length}`);
check('条目共 8 行', $('#bwd_table tbody tr').length === 8, `实际 ${$('#bwd_table tbody tr').length}`);
check('计数 已选 2 本', $('#bwd_count').text().includes('已选 2 本'), $('#bwd_count').text());

console.log('\n[4] 快捷选择「空条目」跨书生效');
$('#bwd_sel_empty').trigger('click');
await sleep(20);
check('已勾 2 条', $('#bwd_count').text().includes('已勾 2 条'), $('#bwd_count').text());

console.log('\n[5] 勾选行为与重绘');
$('#bwd_entry_search').val('旧的').trigger('input');
await sleep(20);
check('搜索后剩 1 行', $('#bwd_table tbody tr').length === 1, `实际 ${$('#bwd_table tbody tr').length}`);

const box = document.querySelector('#bwd_table .bwd-cb');
box.checked = true;
box.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(20);
check('勾选后已勾 3 条', $('#bwd_count').text().includes('已勾 3 条'), $('#bwd_count').text());
check('勾选没有重绘表格（节点仍在）', document.contains(box) && box.isConnected, '节点被替换了');

console.log('\n[6] 兜底：界面勾上但内部没记录');
// 直接改 DOM 状态、不触发 change —— 模拟手机上事件丢失的那种不同步
const ghostBox = document.querySelector('#bwd_table .bwd-cb');
// 先把搜索清掉，让「保留这条」出现在表里
$('#bwd_entry_search').val('保留').trigger('input');
await sleep(20);
const keepBox = document.querySelector('#bwd_table .bwd-cb');
if (keepBox) keepBox.checked = true;   // 只改界面，不发事件

console.log('\n[7] 跨书删除');
const beforeA = Object.keys(worlds['测试书'].entries).length;
const beforeB = Object.keys(worlds['另一本'].entries).length;
$('#bwd_delete').trigger('click');
await sleep(250);
const afterA = Object.keys(worlds['测试书'].entries).length;
const afterB = Object.keys(worlds['另一本'].entries).length;

check(`测试书 ${beforeA} → ${afterA}（删 3）`, afterA === beforeA - 3, `实际删 ${beforeA - afterA}`);
check(`另一本 ${beforeB} → ${afterB}（删 1）`, afterB === beforeB - 1, `实际删 ${beforeB - afterB}`);
check('测试书保留 uid 0（开场）', '0' in worlds['测试书'].entries);
check('测试书删掉 uid 1（空）', !('1' in worlds['测试书'].entries));
check('测试书删掉 uid 4（旧的）', !('4' in worlds['测试书'].entries));
check('兜底捞回了界面勾选的 uid 5（保留这条）', !('5' in worlds['测试书'].entries));
check('另一本删掉 uid 1（空的）', !('1' in worlds['另一本'].entries));
check('两本各自备份', backups >= 2, `backups=${backups}`);

const pass = results.filter((r) => r.ok).length;
console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
