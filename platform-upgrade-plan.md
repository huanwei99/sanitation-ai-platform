# 环卫/清雪 AI 管理平台 —— 十大模块深化设计方案

> 基于现有技术栈（纯 HTML/CSS/JS 单文件、localStorage、无 Node.js/Python、Windows 环境）的约束，以"最容易实现"为原则逐一分析。

---

## 一、数据层：从 localStorage 到可靠持久化

### 现状问题
- localStorage 容量约 5-10MB，语音/图片 dataURL 极易撑爆
- file:// 协议下每个文件是 opaque origin，index.html 和 mobile.html 无法共享数据
- 刷新/清缓存数据全丢，无备份机制

### 最易实现方案：IndexedDB + JSON 导出/导入 + 同源部署

**第一层：IndexedDB 替代 localStorage（容量提升至 500MB+）**

```
数据库名: sanitation_ai_db
Object Stores:
  - employees     (keyPath: 'id')        员工+账号
  - organization  (keyPath: 'id')        机构树节点
  - attendance    (keyPath: 'id')        考勤记录
  - vehicles      (keyPath: 'id')        车辆+GPS
  - tasks         (keyPath: 'id')        作业任务
  - quality       (keyPath: 'id')        品质检查
  - assets        (keyPath: 'id')        资产
  - warehouse     (keyPath: 'id')        库存+出入库
  - workflows     (keyPath: 'id')        审批流
  - materials     (keyPath: 'id')        物资发放
  - chats         (keyPath: 'chatKey')   聊天记录
  - alerts        (keyPath: 'id')        告警
  - emergency     (keyPath: 'id')        应急事件
  - performance   (keyPath: 'id')        绩效考核
  - audit_log     (keyPath: 'id', index: 'time')  操作审计
  - settings      (keyPath: 'key')       系统配置
```

实现方式：封装一个 `DB` 工具层（约 200 行 JS），提供：
- `DB.init()` — 打开/升级数据库
- `DB.get(store, id)` / `DB.getAll(store)` / `DB.put(store, obj)` / `DB.delete(store, id)`
- `DB.query(store, indexName, range)` — 索引查询
- 启动时从 localStorage 迁移旧数据（一次性）
- 每次写入 IndexedDB 同时更新 localStorage 的轻量摘要（供跨 tab 事件通知）

**第二层：JSON 全量导出/导入**

- 导出按钮：遍历所有 store → 合并为一个 JSON → Blob 下载 `sanitation_backup_YYYY-MM-DD.json`
- 导入按钮：FileReader 读取 → 校验格式 → 逐 store 写入 → 刷新页面
- 自动备份：每天首次打开时自动导出一份到 IndexedDB 的 `backups` store（保留最近 7 天）

**第三层：同源部署（解决 file:// 不共享问题）**

最简单方式：用一个绿色免安装的 HTTP 服务器（如 [Caddy](https://caddyserver.com/) 单文件 exe，或 [miniServer](https://www.xlsql.net/) 等国产绿色 web server）：
```
caddy file-server --root ./sanitation-ai-platform --listen :8080
```
然后浏览器访问 `http://localhost:8080/index.html` 和 `http://localhost:8080/mobile.html`，两者同源，localStorage/IndexedDB 天然共享。

### 工作量估算
- DB 工具层：~200 行 JS
- 迁移逻辑：~100 行
- 导出/导入 UI：~80 行
- 各模块改用 DB.get/put 替代直接操作数组：~300 行改动
- 总计约 700 行新增代码，可分 2-3 次完成

---

## 二、权限体系：RBAC + 层级授权

### 两种应用场景

**场景A：单项目公司**
```
管理员 → 编辑机构/岗位/成员 → 为每个岗位分配权限集
```

**场景B：项目群（总公司→分公司→项目子公司）**
```
总部授权管理员 → 设置总部层级岗位+权限
                → 授权下级公司管理员
                    → 下级管理员设置本公司岗位+权限
                        → 再授权更下级...
```

### 核心设计逻辑

#### 1. 权限模型三要素

```
权限 = 功能模块(menu) × 操作级别(action) × 数据范围(scope)
```

- **功能模块**：通讯录/考勤/车辆/人事/品质/资产/库管/审批/物资/AI办公/应急/绩效...
- **操作级别**：查看(view) / 编辑(edit) / 审批(approve) / 删除(delete) / 导出(export) / 管理(admin)
- **数据范围**：本人(self) / 本班组(team) / 本部门(dept) / 本项目(project) / 本区域(region) / 全集团(group)

#### 2. 岗位分级自动映射（通用岗位权限模板）

```javascript
const POSITION_LEVELS = {
  // ===== 决策层 L1 =====
  '总经理':       { level: 1, scope: 'group',   modules: 'ALL',          actions: 'ALL' },
  '副总经理':     { level: 1, scope: 'group',   modules: 'ALL',          actions: ['view','edit','approve','export'] },
  
  // ===== 管理层 L2 =====
  '项目经理':     { level: 2, scope: 'project', modules: 'ALL',          actions: ['view','edit','approve','export'] },
  '分公司经理':   { level: 2, scope: 'region',  modules: 'ALL',          actions: ['view','edit','approve','export'] },
  
  // ===== 执行管理层 L3 =====
  '运营经理':     { level: 3, scope: 'project', modules: ['contacts','attendance','vehicle','manual-work','quality','material-dist','emergency','performance'], actions: ['view','edit','export'] },
  '机械部经理':   { level: 3, scope: 'dept',    modules: ['vehicle','asset','warehouse','manual-work'],  actions: ['view','edit','export'] },
  '人工作业部经理':{ level: 3, scope: 'dept',   modules: ['manual-work','attendance','quality'],         actions: ['view','edit','export'] },
  '综合管理部主管':{ level: 3, scope: 'project', modules: ['personnel','attendance','workflow','ai-office','performance'], actions: ['view','edit','export'] },
  
  // ===== 基层管理 L4 =====
  '车队长':       { level: 4, scope: 'team',    modules: ['vehicle','attendance','manual-work'],         actions: ['view','edit'] },
  '片区经理':     { level: 4, scope: 'team',    modules: ['manual-work','attendance','quality'],         actions: ['view','edit'] },
  '班组长':       { level: 4, scope: 'team',    modules: ['attendance','manual-work','quality','todo'],   actions: ['view','edit'] },
  
  // ===== 一线岗位 L5 =====
  '司机':         { level: 5, scope: 'self',    modules: ['todo','attendance','vehicle'],                actions: ['view'] },
  '保洁员':       { level: 5, scope: 'self',    modules: ['todo','attendance','manual-work'],            actions: ['view'] },
  '辅助工':       { level: 5, scope: 'self',    modules: ['todo','attendance'],                          actions: ['view'] },
  
  // ===== 职能岗位（职级不高但权限宽） =====
  '系统管理员':   { level: 3, scope: 'group',   modules: 'ALL',          actions: 'ALL', special: true },
  '综合管理岗':   { level: 4, scope: 'project', modules: ['contacts','personnel','attendance','workflow','ai-office','todo','material-dist','quality','performance'], actions: ['view','edit','export'], special: true },
};
```

#### 3. 手动设置（特殊岗位覆盖）

对于"职级不高但权限宽"的岗位（如综合管理岗、系统管理员），逻辑是：
- `special: true` 标记 → 不受 level 自动限制
- 管理员可在通讯录中选中某人 → 点「权限配置」→ 打开权限矩阵面板
- 面板以表格形式展示：行=功能模块，列=操作级别，格子=checkbox
- 数据范围用下拉选择：本人/本班组/本部门/本项目/全集团
- 保存后写入 employee 对象的 `permissions` 字段（覆盖岗位默认）

```javascript
// 员工对象新增字段
employee.permissions = {
  mode: 'auto' | 'manual',     // auto=跟随岗位模板, manual=手动覆盖
  level: 3,                     // 当前权限级别
  scope: 'project',            // 数据范围
  modules: {                    // 每个模块的具体操作权限
    'contacts':  ['view','edit','admin'],
    'attendance':['view','edit','export'],
    'vehicle':   ['view'],
    ...
  },
  grantedBy: '张伟',           // 谁授权的
  grantedAt: '2026-11-11',     // 授权时间
  adminLevel: 2                // 管理员级别(0=非管理员,1=项目管理员,2=区域管理员,3=总部管理员)
};
```

#### 4. 层级授权逻辑（项目群场景）

```
总部管理员(adminLevel=3):
  → 可设置所有人权限
  → 可任命分公司管理员(adminLevel=2)
  
分公司管理员(adminLevel=2):
  → 可设置本公司及下级项目公司人员权限
  → 可任命项目管理员(adminLevel=1)
  → 不可修改总部人员权限
  
项目管理员(adminLevel=1):
  → 可设置本项目人员权限
  → 不可修改上级人员权限
  → 不可任命更高级管理员
```

规则：**只能向下授权，不能向上修改；同级别互不干涉**。

#### 5. 权限校验函数

```javascript
function hasPermission(module, action, targetEmployee) {
  const me = state.currentUser;
  const perm = me.permissions;
  if (!perm) return false;
  
  // 系统管理员直接放行
  if (perm.adminLevel >= 3) return true;
  
  // 模块+操作检查
  if (perm.modules !== 'ALL') {
    if (!perm.modules[module]) return false;
    if (perm.modules[module] !== 'ALL' && !perm.modules[module].includes(action)) return false;
  }
  
  // 数据范围检查
  if (targetEmployee && perm.scope !== 'group') {
    return isWithinScope(me, targetEmployee, perm.scope);
  }
  return true;
}

function isWithinScope(me, target, scope) {
  switch(scope) {
    case 'self':    return me.id === target.id;
    case 'team':    return me.teamId === target.teamId;
    case 'dept':    return me.department === target.department;
    case 'project': return me.projectId === target.projectId;
    case 'region':  return me.regionId === target.regionId;
    case 'group':   return true;
  }
}
```

#### 6. UI 层面的权限体现

- 菜单渲染时过滤：`menuConfig.filter(m => hasPermission(m.id, 'view'))`
- 按钮渲染时检查：`if (hasPermission('contacts','edit')) html += '<button>编辑</button>'`
- 数据查询时过滤：`employees.filter(e => isWithinScope(currentUser, e, scope))`

### 工作量估算
- POSITION_LEVELS 模板：~80 行
- 权限数据结构 + 初始化：~120 行
- hasPermission/isWithinScope：~60 行
- 权限配置 UI 面板（矩阵 checkbox）：~200 行
- 层级授权逻辑：~100 行
- 各模块接入权限校验（菜单/按钮/数据过滤）：~200 行改动
- 总计约 760 行新增 + 200 行改动

---

## 三、实时通信：最易实现方案

### 现状
- 聊天用 auto-reply 模拟
- 跨 tab 用 `window.addEventListener('storage')` 事件
- 无真正的消息推送

### 分层方案（由简到复杂）

**Level 1：BroadcastChannel（同浏览器多 Tab 实时同步）— 0 依赖，立即可做**

```javascript
// 创建频道
const channel = new BroadcastChannel('sanitation_rt');

// 发送消息
channel.postMessage({ type: 'chat', from: currentUser.name, to: targetName, msg: messageObj });
channel.postMessage({ type: 'alert', data: alertObj });
channel.postMessage({ type: 'status', userId: id, online: true });

// 接收消息
channel.onmessage = (e) => {
  const { type, ...data } = e.data;
  switch(type) {
    case 'chat':    handleIncomingChat(data); break;
    case 'alert':   handleIncomingAlert(data); break;
    case 'status':  updateOnlineStatus(data); break;
    case 'refresh': refreshCurrentPage(); break;
  }
};
```

效果：网页端发一条消息，同一浏览器打开的手机端 Tab 立即收到（无需刷新）。

**Level 2：SharedWorker（多 Tab 共享状态 + 心跳）— 0 依赖**

```javascript
// shared-worker.js (内嵌为 Blob URL)
const workerBlob = new Blob([`
  const ports = [];
  const onlineUsers = {};
  onconnect = (e) => {
    const port = e.ports[0];
    ports.push(port);
    port.onmessage = (msg) => {
      // 广播给所有其他 tab
      ports.forEach(p => { if (p !== port) p.postMessage(msg.data); });
    };
  };
`], { type: 'application/javascript' });
const worker = new SharedWorker(URL.createObjectURL(workerBlob));
worker.port.start();
worker.port.postMessage({ type: 'chat', ... });
worker.port.onmessage = (e) => { /* 处理来自其他 tab 的消息 */ };
```

**Level 3：Server-Sent Events（如果有简单 HTTP 服务器）— 需后端**

如果将来部署了 Caddy/Nginx + 一个极简后端（甚至 PHP 单文件），SSE 比 WebSocket 简单得多：
```javascript
// 前端
const es = new EventSource('/api/events?user=' + currentUser.id);
es.onmessage = (e) => { const data = JSON.parse(e.data); handleEvent(data); };

// 后端只需一个长连接 + 广播，10行代码
```

### 推荐实施路径
1. 立即做 Level 1（BroadcastChannel）— 约 100 行代码
2. 聊天模块接入：发送消息时 `channel.postMessage`，接收时更新 UI
3. 在线状态：每个 tab 打开时广播 `{ type:'status', online:true }`，关闭时 `beforeunload` 广播 offline
4. 告警推送：任何模块产生告警时广播，其他 tab 显示 toast 通知

### 工作量估算
- BroadcastChannel 封装：~50 行
- 聊天接入实时：~80 行改动
- 在线状态心跳：~40 行
- 告警广播：~30 行
- 总计约 200 行

---

## 四、地图可视化：最易实现方案

### 方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| 高德地图 JS API | 国内坐标准确、POI丰富、免费额度大 | 需注册key、外网CDN |
| 百度地图 JS API | 国内常用 | 坐标系不同(BD09) |
| Leaflet + 天地图 | 开源轻量、天地图免费 | 天地图需key |
| Leaflet + OSM | 完全免费无key | 国内地图偏移、加载慢 |

### 推荐：高德地图 JS API 2.0（免费额度 30万次/日）

**接入方式：一行 script 标签**
```html
<script src="https://webapi.amap.com/maps?v=2.0&key=YOUR_KEY"></script>
```

**核心功能模块：**

1. **车辆实时位置地图**（车辆管理 tab 新增"地图监控"）
```javascript
function renderVehicleMap() {
  return `<div id="vehicleMap" style="width:100%;height:500px;border-radius:8px"></div>`;
}
function initVehicleMap() {
  const map = new AMap.Map('vehicleMap', { zoom: 12, center: [126.63, 45.75] }); // 哈尔滨
  vehicles.forEach(v => {
    if (v.status === '作业中' || v.status === '行驶中') {
      const marker = new AMap.Marker({
        position: v.currentPos || [126.63 + Math.random()*0.1, 45.75 + Math.random()*0.05],
        title: v.plateNo + ' - ' + v.driver,
        icon: v.type === '清雪车' ? snowTruckIcon : normalTruckIcon
      });
      marker.on('click', () => showVehiclePopup(v, map));
      map.add(marker);
    }
  });
  // 电子围栏
  fences.forEach(f => {
    const polygon = new AMap.Polygon({ path: f.coords, fillColor: '#1976d2', fillOpacity: 0.1, strokeColor: '#1976d2' });
    map.add(polygon);
  });
}
```

2. **历史轨迹回放**
```javascript
function replayTrack(vehicleId, date) {
  const points = gpsHistory.filter(p => p.vehicleId === vehicleId && p.date === date);
  const path = points.map(p => [p.lng, p.lat]);
  const polyline = new AMap.Polyline({ path, strokeColor: '#07c160', strokeWeight: 4 });
  map.add(polyline);
  // 动画回放
  const marker = new AMap.Marker({ position: path[0], autoRotation: true });
  map.add(marker);
  AMap.plugin('AMap.MoveAnimation', () => {
    marker.moveAlong(path, { duration: 500, circlable: false });
  });
}
```

3. **清雪路段着色**（应急指挥模块）
```javascript
function renderSnowMap() {
  const roads = snowRoutes; // [{name, coords, status: '未清'|'进行中'|'已完成'}]
  roads.forEach(r => {
    const color = r.status === '已完成' ? '#4caf50' : r.status === '进行中' ? '#ff9800' : '#f44336';
    const polyline = new AMap.Polyline({ path: r.coords, strokeColor: color, strokeWeight: 6, strokeOpacity: 0.8 });
    map.add(polyline);
  });
}
```

4. **保洁员作业区域热力图**
```javascript
function renderWorkHeatmap() {
  AMap.plugin('AMap.HeatMap', () => {
    const heatmap = new AMap.HeatMap(map, { radius: 30, opacity: [0, 0.8] });
    heatmap.setDataSet({ data: personnelWorkAreas.map(p => ({ lng: p.lng, lat: p.lat, count: p.workload })), max: 100 });
  });
}
```

5. **聊天中发送位置**（通讯录对话）
```javascript
function sendLocation() {
  AMap.plugin('AMap.Geolocation', () => {
    const geo = new AMap.Geolocation({ enableHighAccuracy: true });
    geo.getCurrentPosition((status, result) => {
      if (status === 'complete') {
        const msg = { type: 'location', content: '', meta: { lng: result.position.lng, lat: result.position.lat, address: result.formattedAddress } };
        appendChatMessage(otherName, msg);
      }
    });
  });
}
```

### Mock 数据（无真实GPS时的演示）
```javascript
// 为每辆车生成模拟轨迹
function mockVehicleTrack(vehicleId) {
  const base = [126.63, 45.75]; // 哈尔滨中心
  const points = [];
  for (let i = 0; i < 50; i++) {
    points.push([base[0] + (Math.random()-0.5)*0.08, base[1] + (Math.random()-0.5)*0.04]);
  }
  return points;
}
```

### 工作量估算
- 高德 API 接入 + key 配置：~20 行
- 车辆地图监控 tab：~200 行
- 轨迹回放：~100 行
- 清雪路段着色：~80 行
- 热力图：~60 行
- 位置消息气泡：~60 行
- Mock 数据：~50 行
- 总计约 570 行

---

## 五、AI 能力落地：最易实现方案

### 约束分析
- 纯前端无法直接调用大模型 API（CORS + API Key 暴露问题）
- 无后端服务器
- 但可以：规则引擎 + 模板生成 + 未来接入代理

### 分层方案

**Level 1：规则引擎 + 智能模板（立即可做，0 依赖）**

```javascript
const AI_ENGINE = {
  // 智能排班建议
  suggestSchedule(date, constraints) {
    const onDuty = employees.filter(e => e.status === '在岗');
    const leaveToday = attendance.filter(a => a.date === date && a.status === '请假');
    const areas = personnelWorkAreas.filter(a => !a.assigneeId || leaveToday.some(l => l.empId === a.assigneeId));
    // 规则：找空闲人员填补
    const suggestions = areas.map(area => {
      const candidates = onDuty.filter(e => 
        e.department === area.department && 
        !leaveToday.some(l => l.empId === e.id) &&
        !tasks.some(t => t.date === date && t.assigneeId === e.id)
      );
      return { area: area.name, suggest: candidates[0] || null, reason: '同部门空闲人员' };
    });
    return suggestions;
  },
  
  // 异常检测报告
  detectAnomalies() {
    const anomalies = [];
    // 考勤异常：连续3天迟到
    employees.forEach(e => {
      const lateDays = attendance.filter(a => a.empId === e.id && a.status === '迟到').length;
      if (lateDays >= 3) anomalies.push({ type: '考勤', emp: e.name, desc: `近期迟到${lateDays}次`, level: 'warning' });
    });
    // 车辆异常：油耗突增
    vehicles.forEach(v => {
      if (v.fuelConsumption > v.avgFuel * 1.3) anomalies.push({ type: '车辆', emp: v.plateNo, desc: '油耗异常偏高', level: 'danger' });
    });
    // 品质异常：连续低分
    // ...
    return anomalies;
  },
  
  // 汇报材料自动生成
  generateReport(type, date) {
    const data = { employees, attendance, tasks, quality, vehicles };
    const templates = {
      daily: `【${date}工作日报】\n一、人员出勤：应到${data.employees.length}人，实到${countPresent}人...\n二、作业完成：...`,
      emergency: `【清雪应急进度报告】\n启动时间：...\n投入人员：...\n投入设备：...\n完成路段：...`,
      monthly: `【${month}月度工作总结】\n...`
    };
    return fillTemplate(templates[type], data);
  },
  
  // 自然语言查询解析（简单关键词匹配）
  parseQuery(text) {
    if (/迟到|考勤/.test(text)) return { module: 'attendance', filter: 'late' };
    if (/车辆|油耗|维修/.test(text)) return { module: 'vehicle', filter: null };
    if (/品质|检查|扣分/.test(text)) return { module: 'quality', filter: null };
    // ...
    return { module: 'dashboard', filter: null };
  }
};
```

**Level 2：接入大模型 API（需简单代理或 CORS 友好的服务）**

最简方式：用 Cloudflare Workers 免费额度做代理（无需服务器）：
```javascript
// Cloudflare Worker (免费 10万次/日)
export default {
  async fetch(request) {
    const body = await request.json();
    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-turbo', input: { messages: body.messages } })
    });
    return new Response(resp.body, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }
};
```

前端调用：
```javascript
async function askAI(prompt, context) {
  const resp = await fetch('https://your-worker.workers.dev', {
    method: 'POST',
    body: JSON.stringify({ messages: [
      { role: 'system', content: '你是环卫项目管理AI助手。以下是当前数据：\n' + JSON.stringify(context) },
      { role: 'user', content: prompt }
    ]})
  });
  const data = await resp.json();
  return data.output.text;
}
```

应用场景：
- AI办公模块：输入框 + 对话界面，问任何项目管理问题
- 汇报材料：一键生成，AI 根据真实数据撰写
- 清雪方案：AI 根据气象+路段+资源自动生成最优调度方案
- 品质分析：AI 总结近期检查问题，给出改进建议

**Level 3：本地 AI（未来可选）**

如果用户的 Windows 机器配置较好（16GB+ 内存、有 GPU），可以运行 Ollama 本地大模型：
```
ollama run qwen2.5:7b
```
前端直接调用 `http://localhost:11434/api/generate`，无需外网。

### 推荐实施路径
1. 先做 Level 1 规则引擎（立即见效，约 300 行）
2. AI 办公模块加入"智能问答"输入框 + 规则引擎回答
3. 汇报材料改为基于真实数据的模板填充（而非写死的文案）
4. 有网络条件时接入 Level 2

### 工作量估算
- 规则引擎核心（排班/异常/报告）：~300 行
- 自然语言查询解析：~80 行
- AI办公模块改造：~150 行
- 汇报模板引擎：~100 行
- Level 2 Cloudflare Worker + 前端对接：~80 行
- 总计约 710 行（Level 1 约 630 行可立即做）

---

## 六、报表数据可视化：最易实现方案

### 推荐：Chart.js（单文件 CDN 引入，~60KB gzip）

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
```

如果要求完全离线可用，备选：将 chart.umd.min.js 内容内嵌到 HTML 中（约 200KB 增大文件体积），或者用纯 CSS/SVG 手绘简易图表。

### 报表模块设计

在各现有模块中增加"统计图表" tab 或卡片：

1. **工作台 Dashboard** — 综合仪表盘
   - 今日出勤率环形图（Doughnut）
   - 本周任务完成趋势（Line）
   - 各部门人员分布（Pie）
   - 告警类型统计（Bar）

2. **考勤管理** — 考勤报表 tab
   - 月度出勤/迟到/缺勤趋势（Line，3条线）
   - 部门出勤率对比（Bar，横向）
   - 个人考勤日历热力图（自定义 grid）

3. **车辆管理** — 利用率分析
   - 各车辆月行驶里程（Bar）
   - 油耗趋势（Line）
   - 维修频次统计（Pie）
   - 车辆状态分布（Doughnut: 作业中/空闲/维修/报废）

4. **品质安全** — 质量看板
   - 各区域评分雷达图（Radar）
   - 月度品质趋势（Line）
   - 问题类型分布（Pie）
   - 整改完成率（Gauge/进度环）

5. **物资/库管** — 消耗分析
   - 物资消耗月度趋势（Bar + Line 组合）
   - 库存预警占比（Doughnut）
   - 各品类库存对比（Bar）

6. **项目经理驾驶舱** — 增强可视化
   - 五大片区完成率对比（Radar）
   - 月度KPI仪表盘（4个 Gauge）
   - 成本趋势（Line）
   - 人员效率热力图

7. **绩效考核**（新模块）— 见第十部分

### 通用图表组件封装

```javascript
function createChart(canvasId, type, labels, datasets, options) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;
  return new Chart(ctx, {
    type: type,
    data: { labels, datasets },
    options: Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
      scales: type === 'pie' || type === 'doughnut' || type === 'radar' ? {} : {
        y: { beginAtZero: true, grid: { color: '#f0f0f0' } },
        x: { grid: { display: false } }
      }
    }, options || {})
  });
}

// 便捷函数
function lineChart(id, labels, data, color, label) {
  return createChart(id, 'line', labels, [{ label, data, borderColor: color, backgroundColor: color+'20', fill: true, tension: 0.3 }]);
}
function barChart(id, labels, data, colors, label) {
  return createChart(id, 'bar', labels, [{ label, data, backgroundColor: colors }]);
}
function pieChart(id, labels, data, colors) {
  return createChart(id, 'pie', labels, [{ data, backgroundColor: colors }]);
}
```

### 工作量估算
- Chart.js CDN 引入 + 通用封装：~60 行
- Dashboard 4 图表：~120 行
- 考勤报表图表：~100 行
- 车辆利用率图表：~100 行
- 品质雷达图：~80 行
- 物资消耗图表：~80 行
- PM 驾驶舱增强：~100 行
- 总计约 640 行

---

## 七、审批流程配置器

### 设计目标
轻量可视化流程配置，支持：串行审批、并行会签、条件分支、超时转审

### 数据结构

```javascript
// 流程模板
const workflowTemplates = [
  {
    id: 'wf_leave',
    name: '请假审批',
    category: '人事',
    version: 1,
    nodes: [
      { id: 'start', type: 'start', name: '发起申请', next: 'n1' },
      { id: 'n1', type: 'approve', name: '班组长审批', 
        assignee: { rule: 'directLeader' },  // 规则: directLeader/deptManager/specificPerson/role
        timeout: { hours: 24, action: 'remind' }, // remind/autoApprove/escalate
        next: 'cond1' },
      { id: 'cond1', type: 'condition', name: '天数判断',
        conditions: [
          { expr: 'days <= 3', next: 'end' },
          { expr: 'days > 3', next: 'n2' }
        ]},
      { id: 'n2', type: 'approve', name: '项目经理审批',
        assignee: { rule: 'role', value: '项目经理' },
        timeout: { hours: 48, action: 'escalate' },
        next: 'end' },
      { id: 'end', type: 'end', name: '流程结束' }
    ]
  },
  {
    id: 'wf_purchase',
    name: '采购审批',
    category: '物资',
    nodes: [
      { id: 'start', type: 'start', name: '发起采购', next: 'n1' },
      { id: 'n1', type: 'approve', name: '部门主管', assignee: { rule: 'deptManager' }, next: 'cond1' },
      { id: 'cond1', type: 'condition', name: '金额判断',
        conditions: [
          { expr: 'amount <= 5000', next: 'end' },
          { expr: 'amount > 5000 && amount <= 20000', next: 'n2' },
          { expr: 'amount > 20000', next: 'n3' }
        ]},
      { id: 'n2', type: 'approve', name: '项目经理', assignee: { rule: 'role', value: '项目经理' }, next: 'end' },
      { id: 'n3', type: 'parallel', name: '总经理+财务会签', 
        branches: [
          { assignee: { rule: 'role', value: '总经理' } },
          { assignee: { rule: 'role', value: '财务主管' } }
        ],
        mergeRule: 'all', // all=全部通过, any=任一通过
        next: 'end' },
      { id: 'end', type: 'end', name: '流程结束' }
    ]
  }
];

// 流程实例（每次发起审批创建一个）
const workflowInstances = [
  {
    id: 'wfi_001',
    templateId: 'wf_leave',
    initiator: { id: 8, name: '周涛' },
    formData: { type: '事假', days: 2, reason: '家中有事', startDate: '2026-11-12' },
    currentNodeId: 'n1',
    status: 'pending', // pending/approved/rejected/cancelled
    history: [
      { nodeId: 'start', action: 'submit', user: '周涛', time: '2026-11-11 09:00', comment: '' }
    ],
    createdAt: '2026-11-11 09:00',
    completedAt: null
  }
];
```

### 流程配置器 UI

采用**卡片式纵向流程图**（非拖拽，降低复杂度）：

```
┌─────────────────────────────────────────┐
│ 流程名称: [请假审批        ] 分类: [人事▼] │
├─────────────────────────────────────────┤
│                                         │
│  ● 发起申请                             │
│  │                                      │
│  ▼                                      │
│  ┌─────────────────────────────┐        │
│  │ 审批节点: 班组长审批         │        │
│  │ 审批人: [直属上级 ▼]         │        │
│  │ 超时: [24]小时 → [提醒 ▼]   │        │
│  │ 操作: [编辑] [删除] [↓下移]  │        │
│  └─────────────────────────────┘        │
│  │                                      │
│  ▼                                      │
│  ◇ 条件分支: 天数判断                    │
│  ├── 天数≤3 → 结束                      │
│  └── 天数>3 → 项目经理审批              │
│                                         │
│  [+ 添加审批节点] [+ 添加条件分支]       │
│                                         │
│  ○ 流程结束                             │
├─────────────────────────────────────────┤
│ [预览流程] [保存模板] [设为默认]          │
└─────────────────────────────────────────┘
```

### 审批执行逻辑

```javascript
function processApproval(instanceId, action, comment) {
  const inst = workflowInstances.find(i => i.id === instanceId);
  const template = workflowTemplates.find(t => t.id === inst.templateId);
  const currentNode = template.nodes.find(n => n.id === inst.currentNodeId);
  
  // 记录操作
  inst.history.push({ nodeId: currentNode.id, action, user: currentUser.name, time: now(), comment });
  
  if (action === 'reject') {
    inst.status = 'rejected';
    inst.completedAt = now();
    notifyInitiator(inst, 'rejected');
    return;
  }
  
  // 找下一个节点
  let nextId = currentNode.next;
  if (currentNode.type === 'condition') {
    nextId = evaluateCondition(currentNode.conditions, inst.formData);
  }
  
  const nextNode = template.nodes.find(n => n.id === nextId);
  if (!nextNode || nextNode.type === 'end') {
    inst.status = 'approved';
    inst.completedAt = now();
    notifyInitiator(inst, 'approved');
  } else {
    inst.currentNodeId = nextId;
    notifyApprover(inst, nextNode);
  }
}
```

### 工作量估算
- 流程模板数据结构 + 5 个预设模板：~200 行
- 流程实例管理（发起/审批/驳回/撤回）：~200 行
- 配置器 UI（卡片式编辑）：~350 行
- 条件表达式解析：~60 行
- 超时提醒/自动转审：~80 行
- 并行会签合并逻辑：~60 行
- 通知（BroadcastChannel 推送）：~40 行
- 总计约 990 行

---

## 八、移动端交互深化

### 8.1 独立页面路由（History API）

```javascript
// 路由系统
const mobileRoutes = {
  '/': 'home',
  '/work': 'workTab',
  '/alerts': 'alertsTab',
  '/contacts': 'contactsTab',
  '/contacts/:id': 'contactDetail',
  '/chat/:id': 'chatPage',
  '/me': 'meTab',
  '/apps': 'appsCenter',
  '/apps/:moduleId': 'modulePage'
};

function navigateTo(path, params) {
  history.pushState({ path, params }, '', '#' + path);
  renderRoute(path, params);
}

function goBack() {
  history.back(); // 触发 popstate
}

window.addEventListener('popstate', (e) => {
  if (e.state) renderRoute(e.state.path, e.state.params);
  else renderRoute('/');
});

// 手势返回（iOS 边缘右滑 / Android 物理返回键）
document.addEventListener('touchstart', handleTouchStart);
document.addEventListener('touchmove', handleTouchMove);
document.addEventListener('touchend', handleTouchEnd);

let touchStartX = 0;
function handleTouchStart(e) { touchStartX = e.touches[0].clientX; }
function handleTouchEnd(e) {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (touchStartX < 30 && dx > 80) goBack(); // 左边缘右滑 = 返回
}
```

页面切换动画（CSS transform）：
```css
.page-enter { transform: translateX(100%); transition: transform .25s ease; }
.page-enter.active { transform: translateX(0); }
.page-exit { transform: translateX(0); transition: transform .25s ease; }
.page-exit.active { transform: translateX(-30%); opacity: .6; }
```

### 8.2 下拉刷新 + 上拉加载

```javascript
function enablePullRefresh(container, onRefresh) {
  let startY = 0, pulling = false;
  const indicator = document.createElement('div');
  indicator.className = 'pull-indicator';
  indicator.innerHTML = '↓ 下拉刷新';
  container.prepend(indicator);
  
  container.addEventListener('touchstart', e => {
    if (container.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
  });
  container.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && dy < 100) {
      indicator.style.height = dy + 'px';
      indicator.textContent = dy > 60 ? '↑ 释放刷新' : '↓ 下拉刷新';
      e.preventDefault();
    }
  });
  container.addEventListener('touchend', e => {
    if (!pulling) return;
    pulling = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 60) { onRefresh(); indicator.textContent = '⟳ 刷新中...'; }
    indicator.style.height = '0px';
  });
}

function enableInfiniteScroll(container, onLoadMore, hasMore) {
  container.addEventListener('scroll', () => {
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 50) {
      if (hasMore()) onLoadMore();
    }
  });
}
```

### 8.3 推送通知（Notification API）

```javascript
// 请求权限
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// 发送本地通知
function pushNotification(title, body, icon, onclick) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body, icon: icon || '🔔', tag: 'sanitation_' + Date.now() });
    n.onclick = () => { window.focus(); if (onclick) onclick(); n.close(); };
    setTimeout(() => n.close(), 5000);
  }
}

// 接入场景
// 1. 收到新消息 → pushNotification('新消息', `${from}: ${text}`, ..., () => openMobileChat(id))
// 2. 告警 → pushNotification('⚠️ 告警', alertContent, ..., () => switchTab('alerts'))
// 3. 审批待办 → pushNotification('审批提醒', '您有一条待审批', ...)
```

### 8.4 Service Worker 离线缓存

```javascript
// sw.js (注册为 Blob URL 或单独文件)
const swCode = `
const CACHE_NAME = 'sanitation-v1';
const OFFLINE_URLS = ['/', '/index.html', '/mobile.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(OFFLINE_URLS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const clone = resp.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return resp;
    }).catch(() => caches.match('/mobile.html')))
  );
});
`;

// 注册（需同源 HTTP，file:// 不支持 SW）
if ('serviceWorker' in navigator && location.protocol === 'http:') {
  const blob = new Blob([swCode], { type: 'application/javascript' });
  navigator.serviceWorker.register(URL.createObjectURL(blob));
}
```

**注意**：Service Worker 需要 HTTP 协议（localhost 即可），file:// 下无法注册。这进一步说明第三部分的"同源部署"方案是多个功能的基础前提。

### 工作量估算
- 页面路由 + 手势返回：~150 行
- 页面切换动画 CSS：~30 行
- 下拉刷新组件：~60 行
- 上拉加载组件：~40 行
- 推送通知：~50 行
- Service Worker：~80 行
- 各模块接入：~100 行改动
- 总计约 510 行

---

## 九、通用应急指挥系统

### 设计理念

将"清雪应急指挥"泛化为**通用应急指挥平台**，覆盖：暴雪/清雪、暴雨/内涝、火灾、安全事故、设备故障、突发公共卫生事件等。

### 核心模型：事件驱动 + 四阶段响应

```
预警 → 启动 → 执行 → 总结
(Alert)  (Activate)  (Execute)  (Review)
```

### 数据结构

```javascript
// 应急预案模板
const emergencyPlans = [
  {
    id: 'plan_snow',
    name: '暴雪清雪应急预案',
    category: 'snow',        // snow/flood/fire/accident/equipment/health
    icon: '❄️',
    triggerConditions: [
      { metric: 'snowfall', operator: '>=', value: 10, unit: 'mm/24h', desc: '24h降雪量≥10mm' },
      { metric: 'temperature', operator: '<=', value: -15, unit: '℃', desc: '气温≤-15℃' }
    ],
    levels: [
      { level: 'IV级(蓝色)', threshold: 'snowfall >= 5 && snowfall < 10', response: '值班人员关注，准备物资' },
      { level: 'III级(黄色)', threshold: 'snowfall >= 10 && snowfall < 20', response: '启动清雪，全员待命' },
      { level: 'II级(橙色)', threshold: 'snowfall >= 20 && snowfall < 30', response: '全员上岗，设备全开' },
      { level: 'I级(红色)', threshold: 'snowfall >= 30', response: '请求外部支援，24h连续作业' }
    ],
    resources: {
      personnel: ['机械作业部全员', '人工作业部全员'],
      vehicles: ['清雪车', '撒布机', '装载机'],
      materials: ['融雪剂', '防滑砂'],
      routes: 'snowRoutes'  // 关联路段数据
    },
    procedures: [
      { step: 1, name: '预警发布', action: '通知全员+上报总公司', responsible: '值班经理' },
      { step: 2, name: '物资出库', action: '融雪剂/防滑砂装车', responsible: '库管员' },
      { step: 3, name: '车辆调度', action: '按路段分配清雪车', responsible: '车队长' },
      { step: 4, name: '人员部署', action: '各片区人员到位', responsible: '片区经理' },
      { step: 5, name: '作业执行', action: '机械化+人工配合清雪', responsible: '全体' },
      { step: 6, name: '进度汇报', action: '每小时上报完成情况', responsible: '项目经理' },
      { step: 7, name: '验收总结', action: '路段验收+总结报告', responsible: '品质部' }
    ]
  },
  {
    id: 'plan_flood',
    name: '暴雨内涝应急预案',
    category: 'flood',
    icon: '🌊',
    triggerConditions: [
      { metric: 'rainfall', operator: '>=', value: 50, unit: 'mm/24h', desc: '24h降雨量≥50mm' }
    ],
    levels: [...],
    resources: { personnel: [...], vehicles: ['排水车', '吸污车'], materials: ['沙袋', '抽水泵'] },
    procedures: [...]
  },
  {
    id: 'plan_fire',
    name: '火灾应急预案',
    category: 'fire',
    icon: '🔥',
    triggerConditions: [{ metric: 'manual', desc: '人工报告火情' }],
    levels: [...],
    resources: { personnel: [...], vehicles: ['消防车(119)'], materials: ['灭火器'] },
    procedures: [
      { step: 1, name: '报警', action: '拨打119+通知全员撤离', responsible: '发现人' },
      { step: 2, name: '疏散', action: '引导人员撤离至安全点', responsible: '安全员' },
      { step: 3, name: '初期扑救', action: '使用灭火器控制火势', responsible: '义务消防队' },
      { step: 4, name: '配合救援', action: '引导消防车+提供信息', responsible: '项目经理' },
      { step: 5, name: '善后处理', action: '人员伤亡统计+财产损失评估', responsible: '综合管理' }
    ]
  },
  {
    id: 'plan_accident',
    name: '安全事故应急预案',
    category: 'accident',
    icon: '⚠️',
    // 交通事故、工伤事故、设备伤人等
  }
];

// 应急事件实例
const emergencyEvents = [
  {
    id: 'evt_001',
    planId: 'plan_snow',
    title: '2026-11-10 暴雪清雪应急',
    level: 'II级(橙色)',
    status: 'executing',    // alert/activated/executing/resolved/reviewed
    startTime: '2026-11-10 06:00',
    endTime: null,
    commander: '李明',       // 总指挥
    deputyCommander: '赵强', // 副总指挥
    
    // 实时态势
    situation: {
      snowfall: 22,          // mm
      temperature: -18,      // ℃
      windSpeed: 15,         // km/h
      affectedRoads: 12,     // 受影响路段数
      clearedRoads: 7        // 已清理路段数
    },
    
    // 资源调度
    deployment: {
      personnel: [
        { empId: 7, name: '孙磊', role: '车队长', status: '执行中', area: '解放路片区' },
        { empId: 8, name: '周涛', role: '司机', status: '执行中', vehicleId: 1 },
        // ...
      ],
      vehicles: [
        { id: 1, plateNo: '黑A·12345', type: '清雪车', status: '作业中', route: '解放路→人民路', progress: 65 },
        // ...
      ],
      materials: [
        { name: '融雪剂', used: 5, unit: '吨', remaining: 15 },
        { name: '防滑砂', used: 2, unit: '吨', remaining: 8 }
      ]
    },
    
    // 进度追踪
    progressLog: [
      { time: '06:00', action: '预警发布', user: '系统', detail: '气象台发布暴雪橙色预警' },
      { time: '06:15', action: '启动预案', user: '李明', detail: '启动II级响应，全员到岗' },
      { time: '06:30', action: '物资出库', user: '库管员', detail: '融雪剂10吨、防滑砂5吨装车' },
      { time: '07:00', action: '车辆出发', user: '孙磊', detail: '6台清雪车分3组出发' },
      { time: '08:00', action: '进度汇报', user: '李明', detail: '已完成5/12路段，进度42%' },
      // ...
    ],
    
    // 总结报告（结束后填写）
    summary: null
  }
];
```

### 应急指挥 UI 设计

```
┌─────────────────────────────────────────────────────────┐
│ ❄️ 暴雪清雪应急指挥  II级(橙色)  ⏱ 已持续 4h32m       │
│ 总指挥: 李明  副指挥: 赵强  [升级响应▼] [结束事件]      │
├────────────┬────────────────────────────────────────────┤
│            │  实时态势                                   │
│  地 图     │  降雪量 22mm | 气温 -18℃ | 风力 15km/h    │
│  (路段着色  │  受影响 12 条 | 已清理 7 条 | 完成率 58%   │
│   车辆标注  │  ━━━━━━━━━━━━━━━━░░░░░░░░░░ 58%           │
│   人员位置) │                                            │
│            │  资源投入                                   │
│            │  人员: 15/18 在岗  车辆: 6/8 作业中         │
│            │  融雪剂: 已用5吨/余15吨  防滑砂: 已用2吨/余8吨│
├────────────┴────────────────────────────────────────────┤
│  Tabs: [进度日志] [路段明细] [人员部署] [车辆调度] [汇报] │
│                                                         │
│  06:00  预警发布 - 气象台发布暴雪橙色预警                │
│  06:15  启动预案 - 李明启动II级响应                      │
│  06:30  物资出库 - 融雪剂10吨装车                        │
│  07:00  车辆出发 - 6台清雪车分3组                        │
│  08:00  进度汇报 - 完成5/12路段 42%                      │
│  ...                                                    │
│  [+ 添加进度] [一键汇报] [AI生成总结]                    │
└─────────────────────────────────────────────────────────┘
```

### 通用化设计要点

1. **预案模板可自定义**：管理员可新建预案类型（如"管道爆裂"、"停电"等），定义触发条件、响应等级、处置步骤
2. **资源关联真实数据**：人员从 employees 读取、车辆从 vehicles 读取、物资从 warehouse 读取
3. **进度日志自动+手动**：系统自动记录（出库/车辆出发/GPS到位），人工补充（特殊情况）
4. **一键升级/降级**：根据实时态势调整响应等级，自动通知相关人员
5. **事后总结模板**：事件结束后 AI 根据 progressLog 自动生成总结报告
6. **历史事件库**：可查阅过往应急事件的完整记录，用于培训和改进

### 与清雪模块的关系

现有 `snow-command` 模块改造为通用应急指挥的一个"视图入口"：
- 菜单改为「应急指挥」（图标 🚨）
- 首页显示所有预案类型卡片 + 当前活跃事件
- 点击进入具体事件的指挥面板
- 保留清雪相关的专用数据（路段、进度）作为 snow 类型预案的子视图

### 工作量估算
- 预案模板数据结构 + 4 种预案：~250 行
- 事件实例管理（创建/升级/结束）：~200 行
- 指挥面板 UI（态势+资源+进度）：~400 行
- 地图集成（路段着色+车辆标注）：~150 行（依赖第四部分）
- 进度日志（自动+手动）：~100 行
- 一键汇报/AI总结：~80 行
- 历史事件查阅：~60 行
- 总计约 1240 行

---

## 十、考核与绩效模块

### 考核逻辑设计

#### 1. 考核维度（五维模型）

```
绩效总分 = 出勤维度(20%) + 作业质量(30%) + 任务完成(25%) + 安全合规(15%) + 协作贡献(10%)
```

| 维度 | 权重 | 数据来源 | 评分规则 |
|------|------|----------|----------|
| 出勤 | 20% | attendance 模块 | 全勤100分，迟到-5/次，早退-5/次，缺勤-20/天，请假-10/天(年假不扣) |
| 作业质量 | 30% | quality 模块 | 检查得分直接映射，无检查记录默认80分 |
| 任务完成 | 25% | tasks 模块 | 按时完成率×100，超时-10/次，未完成-30/项 |
| 安全合规 | 15% | quality(安全类)+奖惩 | 无违规100分，轻微违规-15/次，严重违规-40/次，获奖+10/次 |
| 协作贡献 | 10% | 聊天/审批/互助记录 | 基础70分，主动协助+10/次，带教新人+15，提出改进建议+5 |

#### 2. 岗位差异化权重

不同岗位的维度权重不同：

```javascript
const WEIGHT_PROFILES = {
  '管理层': { attendance: 15, quality: 25, task: 30, safety: 15, collaboration: 15 },
  '司机':   { attendance: 20, quality: 20, task: 30, safety: 25, collaboration: 5 },
  '保洁员': { attendance: 25, quality: 35, task: 25, safety: 10, collaboration: 5 },
  '班组长': { attendance: 20, quality: 25, task: 25, safety: 15, collaboration: 15 },
  '办公人员': { attendance: 20, quality: 15, task: 30, safety: 10, collaboration: 25 }
};
```

#### 3. 考核周期

- **月度考核**：每月1日自动计算上月得分
- **季度考核**：3个月加权平均（最近月权重更高：40%/35%/25%）
- **年度考核**：12个月平均 + 重大奖惩调整

#### 4. 等级划分

```
S级(卓越): 95-100分  → 奖金系数1.5 + 优先晋升
A级(优秀): 85-94分   → 奖金系数1.2
B级(良好): 75-84分   → 奖金系数1.0
C级(合格): 60-74分   → 奖金系数0.8 + 约谈提醒
D级(不合格): <60分   → 奖金系数0.5 + 限期整改 + 连续2月D级考虑调岗
```

#### 5. 数据结构

```javascript
// 考核记录
const performanceRecords = [
  {
    id: 'perf_001',
    empId: 8,
    empName: '周涛',
    position: '司机',
    department: '机械作业部',
    period: '2026-10',          // 考核月份
    periodType: 'monthly',      // monthly/quarterly/yearly
    
    // 五维得分
    scores: {
      attendance: { score: 90, detail: { fullDays: 22, late: 1, absent: 0, leave: 1 } },
      quality:    { score: 85, detail: { inspections: 4, avgScore: 85, deductions: [] } },
      task:       { score: 92, detail: { assigned: 12, completed: 11, onTime: 11, overdue: 1 } },
      safety:     { score: 100, detail: { violations: 0, awards: 0 } },
      collaboration: { score: 75, detail: { assists: 1, suggestions: 0 } }
    },
    
    // 加权总分
    weights: { attendance: 20, quality: 20, task: 30, safety: 25, collaboration: 5 },
    totalScore: 90.2,
    grade: 'A',
    rank: 3,           // 部门内排名
    totalInDept: 8,    // 部门总人数
    
    // 评语
    comment: '本月表现优秀，出勤率高，任务完成及时。建议加强团队协作。',
    commentBy: '赵强',  // 评价人(直属上级)
    
    // 状态
    status: 'confirmed',  // draft/pending_review/confirmed/appealed
    createdAt: '2026-11-01',
    confirmedAt: '2026-11-03'
  }
];

// 奖惩记录（影响绩效）
const rewardsPenalties = [
  { id: 1, empId: 8, type: 'reward', reason: '暴雨天主动加班排水', score: 10, date: '2026-10-15', approvedBy: '赵强' },
  { id: 2, empId: 12, type: 'penalty', reason: '作业区域检查不合格', score: -15, date: '2026-10-20', approvedBy: '郑华' }
];
```

#### 6. 自动计算引擎

```javascript
function calculatePerformance(empId, period) {
  const emp = getEmp(empId);
  const year = period.split('-')[0], month = period.split('-')[1];
  
  // 1. 出勤维度
  const attRecords = attendance.filter(a => a.empId === empId && a.date.startsWith(period));
  const lateCount = attRecords.filter(a => a.status === '迟到').length;
  const absentCount = attRecords.filter(a => a.status === '缺勤').length;
  const leaveCount = attRecords.filter(a => a.status === '请假').length;
  const attScore = Math.max(0, 100 - lateCount*5 - absentCount*20 - leaveCount*10);
  
  // 2. 作业质量维度
  const inspections = qualityChecks.filter(q => q.inspectedId === empId && q.date.startsWith(period));
  const qualScore = inspections.length ? 
    inspections.reduce((s,q) => s + q.score, 0) / inspections.length : 80;
  
  // 3. 任务完成维度
  const myTasks = tasks.filter(t => t.assigneeId === empId && t.dueDate && t.dueDate.startsWith(period));
  const completed = myTasks.filter(t => t.status === '已完成').length;
  const onTime = myTasks.filter(t => t.status === '已完成' && t.completedDate <= t.dueDate).length;
  const taskScore = myTasks.length ? Math.round((onTime / myTasks.length) * 100) : 80;
  
  // 4. 安全合规维度
  const violations = rewardsPenalties.filter(r => r.empId === empId && r.type === 'penalty' && r.date.startsWith(period));
  const awards = rewardsPenalties.filter(r => r.empId === empId && r.type === 'reward' && r.date.startsWith(period));
  const safetyScore = Math.max(0, Math.min(120, 100 + awards.reduce((s,a)=>s+a.score,0) + violations.reduce((s,v)=>s+v.score,0)));
  
  // 5. 协作贡献（简化：基础分+奖惩中的协作类）
  const collabScore = 70 + awards.filter(a => /协助|带教|建议/.test(a.reason)).length * 10;
  
  // 加权
  const weights = WEIGHT_PROFILES[getWeightProfile(emp.position)] || WEIGHT_PROFILES['保洁员'];
  const total = (attScore * weights.attendance + qualScore * weights.quality + 
                 taskScore * weights.task + safetyScore * weights.safety + 
                 collabScore * weights.collaboration) / 100;
  
  return {
    scores: { attendance: attScore, quality: qualScore, task: taskScore, safety: safetyScore, collaboration: collabScore },
    totalScore: Math.round(total * 10) / 10,
    grade: total >= 95 ? 'S' : total >= 85 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : 'D'
  };
}
```

#### 7. 绩效模块 UI

```
┌─────────────────────────────────────────────────────┐
│ 📊 绩效考核管理                    2026年10月 ▼     │
├─────────────────────────────────────────────────────┤
│ 统计卡片:                                           │
│ [S级 2人] [A级 5人] [B级 8人] [C级 2人] [D级 1人]  │
│ 平均分: 82.3  最高: 96.5(张伟)  最低: 55(罗秀英)   │
├─────────────────────────────────────────────────────┤
│ Tabs: [个人绩效] [部门对比] [趋势分析] [奖惩管理]   │
│       [考核配置] [导出报表]                          │
├─────────────────────────────────────────────────────┤
│ 个人绩效 tab:                                       │
│ ┌─────────────────────────────────────────────────┐ │
│ │ 周涛 | 司机 | 机械作业部 | 总分: 90.2 | A级    │ │
│ │                                                 │ │
│ │    出勤(90)                                     │ │
│ │      ╱╲                                         │ │
│ │ 协作    质量    ← 雷达图                        │ │
│ │ (75)    (85)                                    │ │
│ │      ╲╱                                         │ │
│ │    安全(100)  任务(92)                           │ │
│ │                                                 │ │
│ │ 部门排名: 3/8  较上月: ↑2位                     │ │
│ │ 评语: 本月表现优秀...                           │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ 部门对比 tab:                                       │
│ [柱状图: 机械部82.5 vs 人工部78.3 vs 综合部85.1]    │
│                                                     │
│ 趋势分析 tab:                                       │
│ [折线图: 近6个月个人/部门绩效趋势]                   │
│                                                     │
│ 考核配置 tab:                                       │
│ - 维度权重调整（滑块）                               │
│ - 岗位权重模板选择                                   │
│ - 等级划分阈值设置                                   │
│ - 自动计算规则开关                                   │
└─────────────────────────────────────────────────────┘
```

#### 8. 考核流程

```
每月1日 → 系统自动计算上月各维度得分(draft)
       → 直属上级审阅+填写评语(pending_review)
       → 上级确认/调整(confirmed)
       → 员工可查看自己的绩效
       → 如有异议可申诉(appealed) → HR复核
```

### 工作量估算
- 数据结构 + Mock 数据：~150 行
- 自动计算引擎：~120 行
- 岗位权重模板：~50 行
- 绩效看板 UI（统计卡+表格+详情）：~350 行
- 雷达图（依赖 Chart.js）：~80 行
- 部门对比/趋势图表：~100 行
- 考核配置面板：~120 行
- 奖惩管理子模块：~100 行
- 考核流程（确认/申诉）：~80 行
- 导出绩效报表(CSV)：~50 行
- 总计约 1200 行

---

## 实施优先级建议

| 优先级 | 模块 | 理由 | 预计代码量 |
|--------|------|------|-----------|
| P0 | 二、权限体系 | 所有模块的基础，决定谁能看/做什么 | ~760行 |
| P1 | 一、数据层 | IndexedDB 解决容量瓶颈，为后续模块打基础 | ~700行 |
| P1 | 六、报表可视化 | Chart.js 一行引入，立竿见影提升观感 | ~640行 |
| P2 | 十、绩效考核 | 独立模块，依赖考勤/品质/任务数据（已有） | ~1200行 |
| P2 | 七、审批配置器 | 替换现有简单审批，提升管理规范化 | ~990行 |
| P2 | 九、通用应急指挥 | 改造现有清雪模块，扩展覆盖面 | ~1240行 |
| P3 | 三、实时通信 | BroadcastChannel 立即可做，效果明显 | ~200行 |
| P3 | 四、地图可视化 | 需高德API key，但视觉冲击力最强 | ~570行 |
| P3 | 八、移动端深化 | 需同源部署(HTTP)才能发挥全部能力 | ~510行 |
| P4 | 五、AI能力 | Level 1 规则引擎可立即做，Level 2 需外部服务 | ~630行 |

**总计新增代码约 7440 行**，建议分 5-8 个会话逐步实施。

---

## 实施依赖关系图

```
数据层(P1) ──┬──→ 权限体系(P0) ──→ 绩效考核(P2)
             │                    ↗
             ├──→ 审批配置器(P2) ─┘
             │
             ├──→ 报表可视化(P1) ←── Chart.js CDN
             │
             ├──→ 应急指挥(P2) ←── 地图可视化(P3)
             │
             └──→ 实时通信(P3) ←── BroadcastChannel
                                  
同源部署(HTTP) ──→ Service Worker(P3) + 地图(P3) + AI API(P4)
```

建议实施顺序：**权限 → 数据层 → 报表 → 实时通信 → 绩效 → 审批 → 应急 → 地图 → 移动端 → AI**
