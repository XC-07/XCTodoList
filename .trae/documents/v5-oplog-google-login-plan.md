# 待办清单 v5：操作流水同步 + 谷歌登录（双端并行）实施计划

## Context

v4（整份快照 sync.json.gz + 逐任务 LWW + 墓碑）存在结构性缺陷：双端并发改同一任务会整任务互相覆盖，丢字段级修改；每次全量重写带宽浪费。用户已定稿改用 **op-log（操作流水）**：每条操作一行，回放收敛。同时新增谷歌登录（与华为登录并列、账号各自独立）。桌面版（Project TodoL，Electron）与鸿蒙版（TodoList-HarmonyOS，ArkTS，GLM 实现）**同步并行**开发。

### 已定稿规则（不可推翻）

* 排序键：服务端自增 `seq` 为权威顺序；字段时间语义用 `client_ts`（设备 UTC 毫秒），同毫秒按 `device_id` 字典序打平。

* 回放：update/delete 落在不存在的任务 → 跳过（删除赢）；add 落在不存在的任务 → 插入（唯一复活入口，重导入走这条）；settings 按 modified 比较。

* 存储：弃用 Storage gz，改数据库表；免费层 500MB 足够，配修剪策略。

* 谷歌登录：OAuth 授权码 + PKCE；两端走标准网页流；Google `sub` 经新 Edge Function `google-auth` 派生 Supabase Auth UUID（同构 huawei-auth 链）。

* 账号体系：华为/谷歌各自独立 uid，数据不互通（用户已确认）。

* 鸿蒙谷歌登录回调：深链回跳 + 手动粘贴授权码兜底（用户已确认）。

### 两个关键修正（勘察发现）

1. **桌面谷歌登录不能用内嵌 BrowserWindow**（Google 拒绝 webview，报 disallowed\_useragent）。改为主进程起一次性 `127.0.0.1` loopback HTTP 服务 + `shell.openExternal` 拉系统浏览器（Google 官方 installed-app 推荐流）。
2. **seq 有并发提交空洞**（identity 先取号后提交可见）。拉取需加回看补偿：重连及空闲 60s 按 `seq > cursor - 200` 重拉，用最近 500 条已应用 op\_id 去重。

***

## 1. 总体架构

```
桌面端(Electron)                Supabase                      鸿蒙端(ArkTS)
 saveTasks→记op    ──insert tasks_op(批量,幂等)──►  tasks_op (RLS, append-only)
 outbox(LS/prefs)  ◄──select seq>cursor─────────   sync_cursor (每设备游标)
 replayOps         ──upsert sync_cursor───────►    sync_checkpoint (修剪锚点/掉队重建)
 Realtime/10s轮询── 订阅 sync_state(保留作门铃) ──  触发 pullOps
 google-auth EF: 验 id_token(aud白名单) → sub → 虚拟邮箱 → Auth UUID
```

`sync_state` 表保留为纯门铃：Realtime 订阅与 10s 轮询代码零改动，触发动作从"下载整包"换成"拉流水"。

## 2. DB 层（M1）

### 2.1 tasks\_op（操作流水，append-only）

```sql
create table public.tasks_op (
  seq        bigint generated always as identity primary key,
  uid        uuid not null references auth.users(id) on delete cascade,
  op_id      text not null,               -- 客户端幂等键 crypto.randomUUID
  type       text not null check (type in ('add','update','delete','settings')),
  task_id    text,                        -- settings 时 null
  payload    jsonb not null default '{}', -- add=整条packTask短键; update=仅变更字段; delete={}
  client_ts  bigint not null,
  device_id  text not null,
  server_ts  timestamptz not null default now()
);
create unique index tasks_op_uid_opid on public.tasks_op (uid, op_id);
create index tasks_op_uid_seq on public.tasks_op (uid, seq);
create index tasks_op_uid_server_ts on public.tasks_op (uid, server_ts);
alter table public.tasks_op enable row level security;
create policy tasks_op_select_own on public.tasks_op for select using (auth.uid() = uid);
create policy tasks_op_insert_own on public.tasks_op for insert with check (auth.uid() = uid);
-- 不开 update/delete；修剪走 service_role 定时任务
```

### 2.2 sync\_cursor（每设备游标）

```sql
create table public.sync_cursor (
  uid uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (uid, device_id)
);
-- RLS owner-only（select/insert/update）
```

### 2.3 sync\_checkpoint（修剪锚点 + 掉队设备重建点）

```sql
create table public.sync_checkpoint (
  uid uuid primary key references auth.users(id) on delete cascade,
  seq bigint not null,
  snapshot jsonb not null,   -- 与 v4 信封同构：tasks(短键)+settings
  created_at timestamptz not null default now()
);
-- RLS owner-only
```

客户端约定：成功拉取后若"距上次 checkpoint 已应用 >500 条"或"checkpoint 超 14 天"，把本地全量打包 upsert（seq=当前游标）。

### 2.4 修剪（pg\_cron 每日，两条件同时满足才删）

```sql
delete from public.tasks_op t
using public.sync_checkpoint c
where t.uid = c.uid
  and t.seq <= c.seq
  and t.server_ts < now() - interval '14 days';
```

* 无 checkpoint 的账号永不修剪；掉队设备（本地 cursor < 服务端 min(seq)）走"读 checkpoint 快照整包替换 + 从 checkpoint.seq 续拉"。

* 容量：单条 op ≈200B，重度 50 op/天 ≈3.6MB/年，表长期 MB 级。

### 2.5 settings 入流水

`type='settings'`、`task_id=null`、payload=变更字段子集+modified。回放复用现有 settings modified 比较逻辑。改动频率极低，不值得保留第二通道。

## 3. 同步协议（两端共同遵守）

* **op 生成**：op\_id=UUID 生成即入本地 outbox，重试沿用同一 op\_id（服务端唯一约束兜底）；device\_id 安装时生成持久化。payload 用现有短键编解码（两端 packTask/unpackTask 已对齐）。

* **回放（按 seq 升序）**：add→不存在插入/已存在字段覆盖（幂等）；update→不存在跳过；delete→移除/幂等；settings→modified 更大才应用。应用期间置 `applyingRemote=true`，整批完成一次 render/保存。每应用一条推进 last\_seq；回看重复用 op\_id 去重集合跳过。

* **推送**：`POST /rest/v1/tasks_op`，`Prefer: resolution=ignore-duplicates`，批量 ≤100；成功清 outbox + 写 sync\_state 门铃 + upsert sync\_cursor；失败保留 outbox 指数退避。

* **拉取**：`GET .../tasks_op?uid=eq.&seq=gt.{cursor}&order=seq.asc&limit=500` 翻页 + §0.2 回看补偿；cursor 掉队走 checkpoint 重建。

* **首迁（v4→v5，每设备一次性）**：①先自动导出本地备份 + 存 5 版历史快照；②最后一次 v4 pull+mergeRemote 得基线；③每条任务生成 add op（client\_ts=任务 updatedAt）、settings 一条，批量写入；④墓碑不迁移；⑤置 `syncV5Migrated` 标志，游标推到自身最后 op 的 seq。双端各自迁移产生重复 add 由幂等覆盖收敛。

## 4. 桌面端改动（Project TodoL）

### app.js（v4 代码整体保留在灰度开关后）

* 新增 LS 键：`todolist.deviceId.v1`、`todolist.ops.outbox.v1`、`todolist.ops.cursor.v1`、`todolist.ops.applied.v1`（去重环 500）、`todolist.sync.v`（4/5，默认 4）。

* 改 \[saveTasks()]\(file:///c:/Users/HUAWEI Matebook 14/Desktop/Project TodoL/app.js#L74-L91)：沿用现有签名比对，diff 循环顺手产出 op（新 id→add 整条；签名变→update 仅差异字段；消失→delete）。所有现存改动点零侵入。saveSettings() 变更产 settings op。

* 新增 `pushOps()/pullOps()/replayOps()/writeCheckpoint()/migrateV4ToV5()`；`sbExchange()` 泛化按 provider 路由 huawei-auth/google-auth；`canSync()` 白名单加 `"google"`。

* 调度层外壳不动：`scheduleCloudPush()` 2s 防抖保留，`doAutoPush()` v5 分支调 pushOps；`autoSync()` v5 = pushOps 后 pullOps；Realtime（L2364）与轮询（L2342）零改动。

* 首迁在登录成功且未迁移且开关=5 时执行；`cloudPush/cloudPull/mergeRemote/applyCloudSettings` 保留供迁移读取与 v4 回滚路径。

* UI：\[index.html]\(file:///c:/Users/HUAWEI Matebook 14/Desktop/Project TodoL/index.html#L343-L378) 账号区加"谷歌账号登录"按钮（复用 .hw-login-btn 样式改品牌色）；仿 L1887-1938 加谷歌登录处理器（`ELECTRON.googleLogin()`，账户 key=`"ggl:"+sub`，provider=`"google"`）；已登录区加 v4/v5 徽标。

### electron/main.js（新增谷歌登录）

* `googleLogin()`：`http.createServer` 监听 `127.0.0.1:随机端口/callback`；state + PKCE（S256）；`shell.openExternal(authorizeUrl)`；回调验 state → `POST oauth2.googleapis.com/token`（code+code\_verifier，Desktop client 无需 secret）→ 得 id\_token + refresh\_token。

* client\_id 从 `config.json` 的 `googleClientId` 读（同 hwClientSecret 模式，不入库）；`ipcMain.handle("google-login")`；preload.js 加桥；调试写 `gg-debug.log`。

* **人工项**：Google Cloud Console 建 Desktop 类型 OAuth 应用并**发布为生产状态**（否则 refresh token 7 天过期）。

* 退役项：日常路径停写 deletions 墓碑（灰度期双写，v4 退役后删除）。

## 5. 鸿蒙端改动（产出实现文档交 GLM）

* **PreferencesRepository.ets**：新增 5 个键（同桌面），outbox 用 preferences JSON 数组（不引入 relationalStore；积压 >1000 再升级，接口预留）。

* **CloudSyncService.ets**：`push()`（L61-116）→`pushOps()`；`pull()`（L118-179）→`pullOps()+replayOps()`；`mergeRemote()`（L291-423）退役保留供回滚；10s 轮询零改动；TaskViewModel 变更入口显式记 op；首迁流程同桌面。

* **SupabaseService.ets**：仿 upsertSyncState（L176-207）新增 `insertOps/getOpsSince/upsertCursor/getCheckpoint/upsertCheckpoint`。

* **AuthService.ets**：`signInWithGoogle()` 用系统浏览器（startAbility 拉浏览器）→ 托管回调页 `https://xc-07.github.io/XCTodoList/g-callback` 拿到 code → 尝试 `todolist://g-callback?code=...` 深链回 App（module.json5 注册 scheme）→ 失败则页面展示授权码手动粘贴（兜底）；`exchangeGoogleTokenForSb()` 同构 exchangeHuaweiTokenForSb（L201-296）打 `/functions/v1/google-auth`；refresh\_token 存 preferences，复用 refreshSbToken 续期模式。

* UI：登录页加谷歌按钮 + v4/v5 徽标。

## 6. Edge Function google-auth

新函数 `supabase/functions/google-auth/index.ts`（源码放鸿蒙仓，与 huawei-auth 并列），复刻 huawei-auth 派生链：

| 环节      | 差异                                                                                     |
| ------- | -------------------------------------------------------------------------------------- |
| 验签      | JWKS `https://www.googleapis.com/oauth2/v3/certs`，同套 RSA 代码                            |
| iss     | `accounts.google.com` / `https://accounts.google.com` 都接受                              |
| **aud** | **必须校验**，白名单=环境变量 `GOOGLE_CLIENT_IDS`（桌面/鸿蒙各一，逗号分隔）——Google id\_token 随处可得，不验 aud 等于开门 |
| sub 映射  | `ggl_<sub前16>@todolist.internal`，metadata.google\_sub                                  |
| 其余      | 昵称头像取 name/picture；profile/first\_at、派生密码→updateUserById→signInWithPassword 全复用        |
| 请求体     | `{idToken, firstTaskAt}`，不设任何 ALLOW 旁路                                                 |

部署：`supabase functions deploy google-auth`，secrets 配 `GOOGLE_CLIENT_IDS`。

## 7. 里程碑与并行排期

```
M0 准备(人工)──►M1 DB层──►M2 桌面v5同步层──────────►M6 联调/灰度切换
        └─►M3 鸿蒙v5同步文档─►(GLM实现)─────────────►┤
M0后并行 ─►M4 google-auth EF + 桌面谷歌登录 ─────────►┤
        └─►M5 鸿蒙谷歌登录文档─►(GLM实现)────────────►┘
```

* **M0**：全量本地备份导出；Supabase 全库导出；Google Cloud Console 建两个 OAuth client（Desktop + Web，均发布生产状态）；配回调页；两端建 v5 分支；config.json 加 googleClientId。

* **M1**：§2 全部 SQL（纯增量）+ pg\_cron 修剪；手工 SQL 验证 RLS/唯一约束/分页。

* **M2**：§4.1 桌面同步层，灰度开关默认 4。

* **M3**（与 M2 并行）：鸿蒙 v5 同步实现文档交 GLM 评审。

* **M4**（M0 后即可开工）：google-auth EF + 桌面谷歌登录 + UI。

* **M5**（与 M4 并行）：鸿蒙谷歌登录文档交 GLM。

* **M6**：双端联调矩阵（§9.2）；灰度推进（§8）；稳定 1 周后默认 v5；v4 存档只读保留 ≥90 天。

谷歌登录线与同步层零耦合，完全并行；鸿蒙实现均由 GLM 承担，本侧出文档+评审。

## 8. 灰度与回滚（数据安全优先）

1. 灰度开关 `todo.sync.v`=4|5，默认 4；v4/v5 双路径共存。
2. **双写浸泡期**：开关拨 5 后写双路（v4 gz 推送照常 + v5 op 并行），**读仍走 v4**——v5 bug 不影响真实数据。
3. 切读：逐设备拨读路径到 5，观察 3 天，异常拨回 4，v4 存档因双写始终最新，**回滚零损失**。
4. 双端稳定 1 周停 v4 写；Storage 存档只读 ≥90 天。
5. 首迁第一步强制自动备份；M0 手工导出全库。
6. DB 全部增量 DDL，回滚=drop 新表，不碰既有对象。

## 9. 验证

### 9.1 分层验证

* SQL：手工模拟双设备 op、重复 op\_id → 唯一约束/RLS/分页顺序正确。

* EF：curl 打 google-auth（伪造 aud/过期/错 iss/正常）→ 前三 401，正常返回 session+profile。

* 桌面：双 userData 目录两实例互同步 → 增删改/拖拽/设置收敛；断网积压恢复后无重复。

* 时钟异常：系统时间拨快/拨慢 1 天 → 按 client\_ts+device\_id 收敛，server\_ts 可审计。

* seq 空洞：注入延迟提交 → 回看补偿 60s 内自愈。

* 修剪：构造 checkpoint+旧流水跑 cron → 只删"已覆盖且超期"；掉队设备 checkpoint 重建成功。

* 首迁：生产形态数据（含墓碑/周期任务）→ 迁移后双端与 v4 合并结果逐字段一致，v4 存档未改动。

### 9.2 双端联调矩阵（M6）

桌面↔鸿蒙交叉：新增/改不同字段/改同一字段/删除后另一端编辑（跳过）/删除后重添加（复活）/离线 24h 突发/双端同时首迁（幂等收敛）/谷歌与华为登录数据隔离。

## 10. 关键文件

* 桌面：\[app.js]\(file:///c:/Users/HUAWEI Matebook 14/Desktop/Project TodoL/app.js)（L74-91 记 op、L1942-2405 同步层、L1887-1938 登录）、\[electron/main.js]\(file:///c:/Users/HUAWEI Matebook 14/Desktop/Project TodoL/electron/main.js)（L169-327 huaweiLogin 参考，新增 googleLogin）、\[index.html]\(file:///c:/Users/HUAWEI Matebook 14/Desktop/Project TodoL/index.html#L343-L378)

* 鸿蒙（文档对象）：`entry/src/main/ets/data/CloudSyncService.ets`、`SupabaseService.ets`、`AuthService.ets`、`PreferencesRepository.ets`、`viewmodel/TaskViewModel.ets`

* EF 蓝本：`TodoList-HarmonyOS/supabase/functions/huawei-auth/index.ts`（复刻为 google-auth）

