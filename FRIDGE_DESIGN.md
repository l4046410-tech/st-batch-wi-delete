# 冰箱（Fridge）设计 — 世界书冷藏方案

> 目标：不删除任何东西，但让不用的世界书**从酒馆里消失、不参与任何扫描**，
> 并且**压缩存放**，需要时一键解冻还原。

## 一、先确认「删除为什么会让酒馆变快」

我读了 ST 服务端源码 `src/endpoints/worldinfo.js`，`/list` 的实现是：

```js
const jsonFiles = (await fs.promises.readdir(worlds, { withFileTypes: true }))
    .filter((file) => path.extname(file.name).toLowerCase() === '.json')
for (const file of jsonFiles) {
    const fileContents = await fs.promises.readFile(filePath, 'utf8');   // ← 读整个文件
    const fileContentsParsed = tryParse(fileContents) || {};             // ← 解析
```

**每调一次 `/list`，都会把所有世界书文件全文读一遍再 JSON.parse。**

- 71 本 × 平均 200 KB ≈ **14 MB 的读取 + 解析**
- 每次打开世界书面板、每次刷新列表都会触发
- 酒馆启动时前端也会拉一次

所以「删掉/冷藏」的收益是**真的**，而且不是玄学——是每次列表面板都要付出这个成本。

另外两个收益：
1. 全局世界书（Global World Info）会参与每轮扫描，冷藏后彻底不参与
2. 下拉框不再被 71 个名字淹没

## 二、三种存储方案，我选哪个

冰箱的核心矛盾是：**书从服务器删掉了，压缩包放哪？**

| 方案 | 存哪 | 清浏览器会丢吗 | 换设备能用吗 | 结论 |
|---|---|---|---|---|
| A. 浏览器 IndexedDB | 你的浏览器里 | **会丢** | 不能 | 只能当备份 |
| B. 服务器 `files/` 目录 | ST 服务器上 | 不会 | 能 | **主方案** |
| C. 原地标记（加个字段假装冻结） | 服务器 | 不会 | 能 | 不行，文件还在，`/list` 照样读 |

**选 B。** 依据是源码里的 `/api/files/upload`：

```js
router.post('/upload', async (request, response) => {
    if (!request.body.name)   return response.status(400)...
    if (!request.body.data)   return response.status(400)...
    const validation = validateAssetFileName(request.body.name);
    const pathToUpload = path.join(request.user.directories.files, request.body.name);
    writeFileSyncAtomic(pathToUpload, request.body.data, 'base64');   // ← 写进 files/
    const url = clientRelativePath(request.user.directories.root, pathToUpload);
    return response.send({ path: url });
```

关键点：
- 目标是 **`user/files/`** 目录，不是 worlds/，所以**不会被 `/list` 扫到**
- 数据以 **base64** 传入，正好可以塞 gzip 后的字节
- 返回 `{ path }`，可以直接拿来读回

文件名校验（`src/endpoints/assets.js`）：

```js
if (!/^[a-zA-Z0-9_\-.]+$/.test(inputFilename)) return { error: true, ... }
```

**不允许斜杠，但允许点号** → 所以文件名用 `fridge_<书名>.json.gz`（扁平存放，占位后缀 `.gz`）。

## 三、流程

**冷藏（freeze）**

```
1. POST /api/worldinfo/get  { name }          → 拿到完整 JSON
2. CompressionStream('gzip') 压缩              → 前端原生，无需依赖
3. base64 编码
4. POST /api/files/upload   { name: "fridge_<name>.json.gz", data } → 返回 path
5. 立刻 GET 那个 path，比对字节数               → 验证真的存住了
6. 更新冰箱索引 fridge_index.json（同样走 upload）
7. POST /api/worldinfo/delete { name }         → 此时才删
```

第 5 步是关键：**上传没验证成功就绝不删原书**。宁可失败，不能丢数据。

**解冻（thaw）**

```
1. GET 那个 path → gunzip → JSON
2. POST /api/worldinfo/edit { name, data }     → 书回来了
3. POST /api/files/delete { path: "user/files/fridge_<name>.json.gz" }
4. 更新索引
```

## 四、v0.1 范围（先做什么）

只做四件事，做完就能用：

1. **列表里显示每本书的大小**（现在只有条目数，用户不知道哪本占地方）
2. **「冷藏」按钮**：勾选 → 冷藏，带确认框（写明"会从酒馆删除，压缩包存在服务器 files/ 目录"）
3. **冰箱面板**：列出已冷藏的书（名字 / 原始大小 → 压缩后大小 / 冷藏日期），每行三个按钮：解冻、导出、永久删除
4. **索引文件**：`fridge_index.json` 存在 files/ 里，换设备/换浏览器也能看到冰箱里有什么

暂不做：自动建议冷藏（按"没有任何角色卡引用 + 半年没改"）、批量解冻、压缩率统计报表。

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| 上传失败但已删原书 | **先验证再删**（第 5 步），验证失败直接中止 |
| 解冻时同名书已存在 | 弹出选择：覆盖 / 改名解冻（`书名 (解冻)`） |
| 书被角色卡引用着 | 冷藏前扫 `/api/characters/all`，列出引用它的卡，警告但仍然允许（用户可能就是想清理） |
| 压缩不可用（老浏览器） | `CompressionStream` 不存在时降级为不压缩，文件名用 `.json.b64`，功能不受影响 |
| CSRF | 复用现有插件的 `getRequestHeaders()` 三级兜底 |
| 前端读不回上传的文件 | 上传后立刻验证；失败则把那份 blob 同时存进 IndexedDB 作为兜底 |

## 六、一个还没验证的点

`clientRelativePath()` 返回的路径形如 `/user/files/xxx.gz`，
而 `server-startup.js` 里是 `app.use('/', userDataRouter)` ——
理论上由它提供静态服务，但**我没有活着的酒馆可以实测**。

所以第 5 步的"上传后立刻读回验证"不只是防呆，也是**探测这个能力是否存在**：
- 读得回来 → 冰箱走服务器存储
- 读不回来 → 自动降级成浏览器 IndexedDB 存储，并在界面上明确告诉用户"冰箱存在本浏览器，换设备看不到"

这个降级路径必须做，否则在没验证过的环境下等于埋雷。

## 七、和现有插件的关系

不是替换，是补上另一半：

| 场景 | 用什么 |
|---|---|
| 真的不要了，永久清理 | 现有的「删除整本」 |
| 暂时不用，可能还会捡回来 | **冰箱** |
| 只想清理书里的废条目 | 现有的「删条目」 |

用户旅程变成：**先冷藏 → 几周后发现某本确实没用 → 从冰箱里永久删除**。
比一上来就删更符合直觉，也更容易让人敢用。
