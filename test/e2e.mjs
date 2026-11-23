/**
 * e2e.mjs — 在 jsdom 里真的跑一遍插件
 *
 * 模拟 SillyTavern：提供 #extensions_settings2、jQuery、/api/worldinfo/* 四个接口，
 * 然后把 index.js 当真脚本加载，模拟「选世界书 → 勾条目 → 点删除」，
 * 最后断言磁盘（内存）里的世界书真的少了那些条目、备份也触发了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const EXT = path.resolve('index.js');
const code = fs.readFileSync(EXT, 'utf8');

// ---------------- 模拟的世界书数据
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
  '另一本': { entries: { 0: { uid: 0, comment: 'X', key: ['x'], content: 'x', disable: false } } },
};

let backups = 0;
const calls = [];

// ---------------- 模拟 fetch
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

  if (u.endsWith('/api/worldinfo/list')) {
    return reply(Object.keys(worlds).map((n) => ({ file_id: n, name: n })));
  }
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

// ---------------- jsdom 环境
const dom = new JSDOM(
  `<!doctype html><html><head><meta name="csrf-token" content="tok"></head>
   <body><div id="extensions_settings2"></div><div id="extensions_settings"></div></body></html>`,
  { runScripts: 'outside-only', url: 'http://localhost:8000/' }
);

const { window } = dom;
window.fetch = mockFetch;
window.confirm = () => true;                       // 自动确认删除
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { backups++; };  // 记录备份被触发

// jQuery 必须在 window 存在之后才 require（它会在 import 时检查 window）
global.window = window;
global.document = window.document;
const $ = require('jquery');
window.$ = window.jQuery = $;

// ---------------- 加载插件（它是纯脚本，没有 import）
window.eval(code);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? '✔' : '✘'} ${name}${cond ? '' : ' ' + extra}`);
};

await sleep(60);   // 等 jQuery(async) 跑完

console.log('\n[1] 面板是否挂载');
check('面板出现在 #extensions_settings2', $('#bwd_root').length === 1);
check('世界书下拉已被填充', $('#bwd_world option').length >= 3, `实际 ${$('#bwd_world option').length}`);

console.log('\n[2] 选世界书 + 加载条目');
$('#bwd_world').val('测试书').trigger('change');
await sleep(40);
check('表格渲染出 6 行', $('#bwd_table tbody tr').length === 6, `实际 ${$('#bwd_table tbody tr').length}`);
check('常驻条目标记存在', $('#bwd_table').text().includes('常驻'));
check('禁用条目标记存在', $('#bwd_table').text().includes('禁用'));

console.log('\n[3] 快捷选择：空条目');
$('#bwd_sel_empty').trigger('click');
await sleep(10);
check('选中 1 条空条目', $('#bwd_count').text().includes('已选 1 条'), $('#bwd_count').text());

console.log('\n[4] 快捷选择：重复内容');
$('#bwd_sel_dupe').trigger('click');
await sleep(10);
check('重复内容只选后 1 条（保留第一条）', $('#bwd_count').text().includes('已选 1 条'), $('#bwd_count').text());

console.log('\n[5] 勾选一条 + 删除');
$('#bwd_search').val('旧的').trigger('input');
await sleep(10);
check('搜索过滤到 1 行', $('#bwd_table tbody tr').length === 1, `实际 ${$('#bwd_table tbody tr').length}`);
$('#bwd_table .bwd-cb').prop('checked', true).trigger('change');
await sleep(10);

const before = Object.keys(worlds['测试书'].entries).length;
$('#bwd_delete').trigger('click');
await sleep(80);
const after = Object.keys(worlds['测试书'].entries).length;

check(`世界书条目从 ${before} 减到 ${after}`, after === before - 2, `减少 ${before - after}`);
check('uid 3（重复B）已删除', !('3' in worlds['测试书'].entries));
check('uid 2（重复A，保留第一条）仍在', '2' in worlds['测试书'].entries);
check('uid 1（空条目）未被删——选重复时清空了之前的选择', '1' in worlds['测试书'].entries);
check('uid 4（旧的/禁用）已删除', !('4' in worlds['测试书'].entries));
check('uid 0（开场）保留', '0' in worlds['测试书'].entries);
check('uid 5（保留这条）保留', '5' in worlds['测试书'].entries);
check('删除前触发了备份下载', backups >= 1, `backups=${backups}`);
check('调用了 edit 接口', calls.some((u) => u.endsWith('/api/worldinfo/edit')));

const pass = results.filter((r) => r.ok).length;
console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
