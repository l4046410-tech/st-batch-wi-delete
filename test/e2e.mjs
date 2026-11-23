/**
 * e2e.mjs — v2.2：ST 原生折叠面板 + 删整本世界书
 *
 * 覆盖：
 *   0. 外层是 ST 的 inline-drawer（右侧箭头），内层两个自绘分区可折叠
 *   1. 列表显示书名（接口 file_id 是数字时也不能显示成编号）
 *   2. 多选 → 一键删除整本，服务端文件真的没了
 *   3. 删除前打包下载一个备份 JSON
 *   4. 「删除全部」需要输入确认词
 *   5. 进阶区：只删条目，书还在
 *   6. 没有 CSRF token 的 POST 会被 403 —— 插件必须带上
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const code = fs.readFileSync(path.resolve('index.js'), 'utf8');

// ---------------- 模拟数据
let worlds = {
  '甲书': { entries: { 0: { uid: 0, comment: 'A1', key: ['a'], content: '内容A1' }, 1: { uid: 1, comment: 'A2', key: ['b'], content: '' } } },
  '乙书': { entries: { 0: { uid: 0, comment: 'B1', key: ['c'], content: '内容B1' } } },
  '丙书': { entries: { 0: { uid: 0, comment: 'C1', key: ['d'], content: '内容C1' } } },
};

let downloads = 0;
let downloadNames = [];
let forbidden = 0;
const deleted = [];
const edited = [];
let promptAnswer = '全部删除';

function mockList() {
  return Object.keys(worlds).map((n, i) => ({ file_id: String(i), name: n, extensions: {} }));
}

function mockFetch(url, opts = {}) {
  const u = String(url);
  const body = opts.body ? JSON.parse(opts.body) : {};

  const h = opts.headers || {};
  if ((opts.method || 'GET').toUpperCase() === 'POST' && h['X-CSRF-Token'] !== 'tok') {
    forbidden++;
    return Promise.resolve({
      ok: false, status: 403,
      headers: { get: () => 'text/plain' },
      text: () => Promise.resolve('Forbidden'),
      json: () => Promise.reject(new Error('403')),
    });
  }

  const reply = (obj) => Promise.resolve({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
  });

  if (u.endsWith('/api/worldinfo/list')) return reply(mockList());
  if (u.endsWith('/api/worldinfo/get')) return reply(worlds[body.name] ? structuredClone(worlds[body.name]) : { entries: {} });
  if (u.endsWith('/api/worldinfo/delete')) {
    if (!worlds[body.name]) {
      return Promise.resolve({
        ok: false, status: 400,
        headers: { get: () => 'text/plain' },
        text: () => Promise.resolve('missing'),
        json: () => Promise.reject(new Error('400')),
      });
    }
    delete worlds[body.name];
    deleted.push(body.name);
    return reply({ ok: true });
  }
  if (u.endsWith('/api/worldinfo/edit')) {
    worlds[body.name] = structuredClone(body.data);
    edited.push(body.name);
    return reply({ ok: true });
  }
  return Promise.reject(new Error('unexpected fetch: ' + u));
}

// ---------------- jsdom
const dom = new JSDOM(
  `<!doctype html><html><head><meta name="csrf-token" content="tok"></head>
   <body><div id="extensions_settings2"></div></body></html>`,
  { runScripts: 'outside-only', url: 'http://localhost:8000/' }
);

const { window } = dom;
window.fetch = mockFetch;
window.confirm = () => true;
window.prompt = () => promptAnswer;
window.URL.createObjectURL = () => { downloads++; return 'blob:fake'; };
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloadNames.push(this.download); };

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
const bookNames = () => $('#bwd_book_list .bwd-book-name').map((i, el) => $(el).text().trim()).get();

await sleep(120);

console.log('\n[0] 折叠面板');
check('外层是 ST 的 inline-drawer', $('#bwd_root > .inline-drawer').length === 1);
check('标题栏有右侧箭头图标', $('#bwd_root .inline-drawer-toggle .inline-drawer-icon').length === 1);
check('内层两个分区', $('.bwd-drawer').length === 2, `实际 ${$('.bwd-drawer').length}`);
check('① 删除整本 默认展开', $('#bwd_drawer_books').hasClass('bwd-open'));
check('② 删条目 默认收起', !$('#bwd_drawer_entries').hasClass('bwd-open'));
check('收起时内容隐藏', $('#bwd_drawer_entries > .bwd-drawer-body').css('display') === 'none');

$('#bwd_drawer_entries > .bwd-drawer-head').trigger('click');
await sleep(30);
check('点标题后展开', $('#bwd_drawer_entries').hasClass('bwd-open'));
check('展开后内容可见', $('#bwd_drawer_entries > .bwd-drawer-body').css('display') !== 'none');
check('状态写进 localStorage', window.localStorage.getItem('bwd_open_entries') === '1');

const $content = $('#bwd_root > .inline-drawer > .inline-drawer-content');
const beforeDisplay = $content.css('display');
$('#bwd_root .inline-drawer-toggle').trigger('click');
await sleep(80);
check('外层可折叠（ST 没绑时自己兜底）', beforeDisplay !== $content.css('display'), `${beforeDisplay} -> ${$content.css('display')}`);

console.log('\n[1] 列表');
check('面板挂载', $('#bwd_root').length === 1);
check('列出 3 本', bookNames().length === 3, JSON.stringify(bookNames()));
check('显示书名不是编号', bookNames().includes('甲书') && !bookNames().some((n) => /^\d+$/.test(n)), JSON.stringify(bookNames()));

console.log('\n[2] 多选两本');
$('.bwd-book-cb[data-book="甲书"]').prop('checked', true).trigger('change');
$('.bwd-book-cb[data-book="乙书"]').prop('checked', true).trigger('change');
await sleep(150);
check('按钮显示「2 本」', $('#bwd_del_books').text().includes('2 本'), $('#bwd_del_books').text());

console.log('\n[3] 删除选中的整本');
$('#bwd_del_books').trigger('click');
await sleep(350);
check('甲书 文件已删除', !('甲书' in worlds));
check('乙书 文件已删除', !('乙书' in worlds));
check('丙书 未受影响', '丙书' in worlds);
check('下载了一次备份', downloads === 1, `downloads=${downloads}`);
check('备份名带「世界书备份」', String(downloadNames[0] || '').includes('世界书备份'), String(downloadNames[0]));
check('列表只剩 1 本', bookNames().length === 1, JSON.stringify(bookNames()));

console.log('\n[4] 删除全部（需确认词）');
promptAnswer = '随便输的';
$('#bwd_del_all').trigger('click');
await sleep(220);
check('确认词不对不删除', '丙书' in worlds);

promptAnswer = '全部删除';
$('#bwd_del_all').trigger('click');
await sleep(350);
check('确认后全部删除', Object.keys(worlds).length === 0, JSON.stringify(Object.keys(worlds)));
check('共删 3 本', deleted.length === 3, deleted.join(','));
check('下载 2 次备份', downloads === 2, `downloads=${downloads}`);

console.log('\n[5] 进阶：只删条目，不删书');
worlds = { '丁书': { entries: { 0: { uid: 0, comment: 'D1', key: ['x'], content: 'D1' }, 1: { uid: 1, comment: 'D2', key: ['y'], content: 'D2' } } } };
$('#bwd_refresh').trigger('click');
await sleep(180);
$('.bwd-book-cb[data-book="丁书"]').prop('checked', true).trigger('change');
await sleep(180);
$('#bwd_table .bwd-cb').first().prop('checked', true).trigger('change');
await sleep(30);
$('#bwd_delete').trigger('click');
await sleep(300);
check('删条目后书还在', '丁书' in worlds);
check('条目减到 1 条', Object.keys(worlds['丁书'].entries).length === 1, JSON.stringify(Object.keys(worlds['丁书'].entries)));
check('走的是 edit 接口', edited.includes('丁书'));

console.log('\n[6] 请求头');
check('没有 POST 被 403', forbidden === 0, `forbidden=${forbidden}`);

const pass = results.filter((r) => r.ok).length;
console.log(`\n结果：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
