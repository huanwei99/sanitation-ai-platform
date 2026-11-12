// ============================================================
// 环卫项目AI管理程序 - 主应用逻辑
// ============================================================

// 全局状态
let currentUser = null;
let currentPage = 'dashboard';

// 菜单配置
const menuConfig = [
  { id: 'dashboard', icon: '&#128202;', label: '工作台', group: '' },
  { id: 'organization', icon: '&#127970;', label: '组织架构', group: '基础管理' },
  { id: 'attendance', icon: '&#128337;', label: '考勤管理', group: '基础管理' },
  { id: 'vehicle', icon: '&#128666;', label: '车辆管理', group: '业务管理' },
  { id: 'manual-work', icon: '&#128100;', label: '人工作业管理', group: '业务管理' },
  { id: 'personnel', icon: '&#128101;', label: '人事管理', group: '业务管理' },
  { id: 'quality', icon: '&#9989;', label: '品质、安全', group: '业务管理' },
  { id: 'workflow', icon: '&#128203;', label: '审批流程', group: '办公管理', badge: 3 },
  { id: 'ai-office', icon: '&#129302;', label: 'AI办公', group: '办公管理' },
  { id: 'personal', icon: '&#128188;', label: '个人工作', group: '办公管理' },
  { id: 'todo', icon: '&#128276;', label: '待办', group: '办公管理', badge: 7 },
  { id: 'ai-academy', icon: '&#127891;', label: 'AI学院', group: '学习中心' },
  { id: 'groups', icon: '&#128172;', label: '工作群组', group: '学习中心' },
];

// ============ 登录/登出 ============
function handleLogin() {
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;
  const port = document.getElementById('loginPort').value;

  if (!username || !password) {
    alert('请输入用户名和密码');
    return;
  }

  // 模拟登录
  currentUser = {
    name: '李明',
    role: '项目经理',
    department: '管理层',
    avatar: '李',
    port: port,
    permissions: ['all']
  };

  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('appLayout').style.display = 'flex';

  // 设置用户信息
  document.getElementById('headerAvatar').textContent = currentUser.avatar;
  document.getElementById('headerUsername').textContent = currentUser.name;
  document.getElementById('headerUserRole').textContent = currentUser.role;

  // 渲染菜单
  renderMenu();
  // 导航到首页
  navigateTo('dashboard');
  // 渲染通知
  renderNotifications();
}

function handleLogout() {
  if (confirm('确定要退出登录吗？')) {
    currentUser = null;
    document.getElementById('appLayout').style.display = 'none';
    document.getElementById('loginPage').style.display = 'flex';
  }
}

// ============ 菜单渲染 ============
function renderMenu() {
  const menuEl = document.getElementById('sidebarMenu');
  let html = '';
  let currentGroup = '';

  menuConfig.forEach(item => {
    if (item.group && item.group !== currentGroup) {
      currentGroup = item.group;
      html += `<div class="menu-group-title">${currentGroup}</div>`;
    }
    const badgeHtml = item.badge ? `<span class="menu-badge">${item.badge}</span>` : '';
    html += `
      <div class="menu-item ${item.id === currentPage ? 'active' : ''}" onclick="navigateTo('${item.id}')" data-page="${item.id}">
        <span class="menu-icon">${item.icon}</span>
        <span>${item.label}</span>
        ${badgeHtml}
      </div>`;
  });

  menuEl.innerHTML = html;
}

// ============ 导航 ============
function navigateTo(page) {
  currentPage = page;

  // 更新菜单高亮
  document.querySelectorAll('.menu-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // 更新面包屑
  const menuItem = menuConfig.find(m => m.id === page);
  document.getElementById('breadcrumb').innerHTML = `
    <span>${menuItem ? menuItem.group || '首页' : '首页'}</span>
    <span>/</span>
    <span>${menuItem ? menuItem.label : page}</span>`;

  // 渲染页面
  const contentEl = document.getElementById('mainContent');
  contentEl.innerHTML = '<div class="page-content">' + renderPage(page) + '</div>';
}

// ============ 页面路由 ============
function renderPage(page) {
  const renderers = {
    'dashboard': renderDashboard,
    'organization': renderOrganization,
    'attendance': renderAttendance,
    'vehicle': renderVehicle,
    'manual-work': renderManualWork,
    'personnel': renderPersonnel,
    'quality': renderQuality,
    'workflow': renderWorkflow,
    'ai-office': renderAiOffice,
    'personal': renderPersonal,
    'todo': renderTodo,
    'ai-academy': renderAiAcademy,
    'groups': renderGroups,
  };
  return (renderers[page] || renderDashboard)();
}

// ============ 仪表盘 ============
function renderDashboard() {
  const s = dashboardStats;
  return `
    <div class="page-header">
      <h2>工作台</h2>
      <p>欢迎回来，${currentUser.name}！今天是 ${s.todayDate}，以下是项目概况。</p>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue">&#128101;</div>
        <div class="stat-info">
          <div class="stat-label">在岗人员</div>
          <div class="stat-value">${s.presentToday}<span style="font-size:14px;color:var(--text-secondary)"> / ${s.totalEmployees}</span></div>
          <div class="stat-footer">缺勤 ${s.absentToday} 人</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">&#128666;</div>
        <div class="stat-info">
          <div class="stat-label">作业车辆</div>
          <div class="stat-value">${s.vehiclesActive}<span style="font-size:14px;color:var(--text-secondary)"> / ${s.vehiclesTotal}</span></div>
          <div class="stat-footer">维修中 ${s.vehiclesMaintenance} 台</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">&#9989;</div>
        <div class="stat-info">
          <div class="stat-label">今日督查</div>
          <div class="stat-value">${s.inspectionsToday}</div>
          <div class="stat-footer">待整改 ${s.pendingIssues} 件</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red">&#128203;</div>
        <div class="stat-info">
          <div class="stat-label">待审批</div>
          <div class="stat-value">${s.pendingApprovals}</div>
          <div class="stat-footer">加班申请 ${s.overtimeToday} 件</div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <!-- 告警信息 -->
      <div class="card">
        <div class="card-header">
          <h3>&#9888;&#65039; 系统告警</h3>
        </div>
        <div class="card-body">
          ${s.alerts.map(a => `
            <div class="alert alert-${a.type}">
              <span>${a.msg}</span>
              <span style="margin-left:auto;font-size:12px;white-space:nowrap">${a.time}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 今日工作日报 -->
      <div class="card">
        <div class="card-header">
          <h3>&#128196; 今日工作日报</h3>
          <button class="btn btn-text btn-sm" onclick="navigateTo('personal')">查看全部</button>
        </div>
        <div class="card-body">
          ${dailyReports.map(r => `
            <div style="padding:12px 0;border-bottom:1px solid var(--border-light)">
              <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <strong>${r.name} <span style="font-weight:normal;color:var(--text-secondary)">· ${r.role}</span></strong>
                <span style="font-size:12px;color:var(--text-tertiary)">${r.generatedAt}</span>
              </div>
              <p style="font-size:13px;color:var(--text-secondary);line-height:1.6">${r.content}</p>
              <span style="font-size:12px;color:var(--text-tertiary)">附件 ${r.attachments} 个</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <!-- 待办事项 -->
    <div class="card" style="margin-top:24px">
      <div class="card-header">
        <h3>&#128203; 我的待办</h3>
        <button class="btn btn-text btn-sm" onclick="navigateTo('todo')">全部待办</button>
      </div>
      <div class="card-body no-padding">
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>事项</th>
                <th>类型</th>
                <th>来源</th>
                <th>所属模块</th>
                <th>优先级</th>
                <th>截止时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${todoItems.slice(0, 5).map(t => `
                <tr>
                  <td>${t.title}</td>
                  <td><span class="tag ${t.type === '待办' ? 'tag-blue' : 'tag-gray'}">${t.type}</span></td>
                  <td>${t.from}</td>
                  <td>${t.module}</td>
                  <td>${getPriorityTag(t.priority)}</td>
                  <td>${t.deadline}</td>
                  <td><button class="btn btn-primary btn-sm" onclick="handleTodoAction(${t.id})">处理</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function getPriorityTag(priority) {
  const map = { '紧急': 'tag-red', '重要': 'tag-orange', '普通': 'tag-blue' };
  return `<span class="tag ${map[priority] || 'tag-gray'}">${priority}</span>`;
}

function handleTodoAction(id) {
  const item = todoItems.find(t => t.id === id);
  if (!item) return;
  if (item.module === '流程') {
    navigateTo('workflow');
  } else if (item.module === '品质安全') {
    navigateTo('quality');
  } else if (item.module === '车辆管理') {
    navigateTo('vehicle');
  } else if (item.module === '通知') {
    toggleNotificationPanel();
  } else {
    alert('正在处理：' + item.title);
  }
}

// ============ 组织架构 ============
function renderOrganization() {
  return `
    <div class="page-header">
      <h2>组织架构</h2>
      <p>项目岗位设置与组织结构。以上岗位设置不是必选项，根据项目实际需求设置。</p>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="org-tree">
          ${renderOrgNode(organizationData, true)}
        </div>
      </div>
    </div>`;
}

function renderOrgNode(node, isRoot) {
  const iconClass = node.type === 'department' ? 'dept' : 'pos';
  const icon = node.type === 'department' ? '&#127970;' : '&#128100;';
  const countHtml = node.headcount ? `<span class="org-count">${node.headcount}人</span>` : '';
  const descHtml = node.desc ? `<div class="org-desc">${node.desc}</div>` : '';

  let html = `<div class="org-node ${isRoot ? 'org-node-root' : ''}">
    <div class="org-card">
      <div class="org-icon ${iconClass}">${icon}</div>
      <div>
        <div class="org-name">${node.name}</div>
        ${descHtml}
        ${countHtml}
      </div>
    </div>`;

  if (node.children) {
    node.children.forEach(child => {
      html += renderOrgNode(child, false);
    });
  }

  html += '</div>';
  return html;
}

// ============ 考勤管理 ============
function renderAttendance() {
  return `
    <div class="page-header">
      <h2>考勤管理</h2>
      <p>人员打卡记录、加班管理、热力图分析及考勤报表导出。</p>
    </div>

    <div class="tabs" id="attendanceTabs">
      <div class="tab-item active" onclick="switchAttendanceTab('records')">考勤打卡</div>
      <div class="tab-item" onclick="switchAttendanceTab('overtime')">加班管理</div>
      <div class="tab-item" onclick="switchAttendanceTab('heatmap')">热力图</div>
      <div class="tab-item" onclick="switchAttendanceTab('report')">考勤报表</div>
    </div>

    <div id="attendanceContent">
      ${renderAttendanceRecords()}
    </div>`;
}

function switchAttendanceTab(tab) {
  document.querySelectorAll('#attendanceTabs .tab-item').forEach((el, i) => {
    const tabs = ['records', 'overtime', 'heatmap', 'report'];
    el.classList.toggle('active', tabs[i] === tab);
  });

  const contentEl = document.getElementById('attendanceContent');
  switch(tab) {
    case 'records': contentEl.innerHTML = renderAttendanceRecords(); break;
    case 'overtime': contentEl.innerHTML = renderOvertimeRecords(); break;
    case 'heatmap': contentEl.innerHTML = renderHeatmap(); break;
    case 'report': contentEl.innerHTML = renderAttendanceReport(); break;
  }
}

function renderAttendanceRecords() {
  const statusTag = (s) => {
    const map = { '已打卡': 'tag-green', '在岗': 'tag-blue', '未打卡': 'tag-red' };
    return `<span class="tag ${map[s] || 'tag-gray'}">${s}</span>`;
  };
  const typeTag = (t) => {
    const map = { '正常': 'tag-green', '迟到': 'tag-orange', '缺勤': 'tag-red' };
    return `<span class="tag ${map[t] || 'tag-gray'}">${t}</span>`;
  };

  return `
    <div class="toolbar">
      <input type="text" class="search-input" placeholder="搜索员工姓名..." id="attSearchInput">
      <select class="filter-select" id="attDeptFilter">
        <option value="">全部部门</option>
        <option value="机械作业部">机械作业部</option>
        <option value="人工作业部">人工作业部</option>
        <option value="综合管理部">综合管理部</option>
        <option value="管理层">管理层</option>
      </select>
      <select class="filter-select" id="attStatusFilter">
        <option value="">全部状态</option>
        <option value="已打卡">已打卡</option>
        <option value="在岗">在岗</option>
        <option value="未打卡">未打卡</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="exportAttendance()">导出考勤表</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>姓名</th>
                <th>日期</th>
                <th>上班打卡</th>
                <th>下班打卡</th>
                <th>考勤类型</th>
                <th>作业位置</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${attendanceRecords.map(r => `
                <tr>
                  <td><strong>${r.name}</strong></td>
                  <td>${r.date}</td>
                  <td>${r.clockIn || '-'}</td>
                  <td>${r.clockOut || '-'}</td>
                  <td>${typeTag(r.type)}</td>
                  <td>${r.location}</td>
                  <td>${statusTag(r.status)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderOvertimeRecords() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="showOvertimeModal()">申请加班</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>姓名</th>
                <th>日期</th>
                <th>开始时间</th>
                <th>结束时间</th>
                <th>时长</th>
                <th>事由</th>
                <th>审批人</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${overtimeRecords.map(r => `
                <tr>
                  <td><strong>${r.name}</strong></td>
                  <td>${r.date}</td>
                  <td>${r.startTime}</td>
                  <td>${r.endTime || '-'}</td>
                  <td>${r.hours}h</td>
                  <td>${r.reason}</td>
                  <td>${r.approver}</td>
                  <td><span class="tag ${r.status === '已批准' ? 'tag-green' : 'tag-orange'}">${r.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderHeatmap() {
  // 生成模拟热力图数据
  const cells = [];
  const areas = ['城东片区', '城西片区', '城南片区', '城北A区', '城北B区', '机动片区', '主干道', '广场区域', '商业街区', '居民区', '工业区', '公园区域'];
  const timeSlots = ['6:00', '7:00', '8:00', '9:00', '10:00', '11:00', '12:00', '13:00'];

  for (let i = 0; i < 96; i++) {
    const intensity = Math.random();
    let color;
    if (intensity > 0.8) color = '#0958d9';
    else if (intensity > 0.6) color = '#1677ff';
    else if (intensity > 0.4) color = '#4096ff';
    else if (intensity > 0.2) color = '#91caff';
    else color = '#e6f4ff';
    cells.push(`<div class="heatmap-cell" style="background:${color}" title="活跃度: ${Math.round(intensity * 100)}%"></div>`);
  }

  return `
    <div class="card">
      <div class="card-header">
        <h3>作业人员热力图 - ${dashboardStats.todayDate}</h3>
        <span style="font-size:13px;color:var(--text-secondary)">每15-30分钟更新位置信息</span>
      </div>
      <div class="card-body">
        <div class="heatmap-container">
          <div class="heatmap-grid">${cells.join('')}</div>
        </div>
        <div class="heatmap-legend">
          <span>低</span>
          <div class="heatmap-legend-bar"></div>
          <span>高</span>
          <span style="margin-left:24px">每个格子代表一个作业区域在某时段的活动频次</span>
        </div>
      </div>
    </div>`;
}

function renderAttendanceReport() {
  const deptStats = [
    { dept: '机械作业部', total: 5, present: 4, absent: 1, late: 1, rate: '80%' },
    { dept: '人工作业部', total: 8, present: 8, absent: 0, late: 0, rate: '100%' },
    { dept: '综合管理部', total: 2, present: 2, absent: 0, late: 0, rate: '100%' },
    { dept: '财务部', total: 1, present: 1, absent: 0, late: 0, rate: '100%' },
    { dept: '管理层', total: 2, present: 2, absent: 0, late: 0, rate: '100%' },
  ];

  return `
    <div class="toolbar">
      <select class="filter-select">
        <option>2026年11月</option>
        <option>2026年10月</option>
        <option>2026年9月</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="alert('正在导出Excel考勤报表...')">导出Excel</button>
      <button class="btn btn-default btn-sm" onclick="alert('正在生成PDF报表...')">导出PDF</button>
    </div>
    <div class="card">
      <div class="card-header"><h3>部门考勤汇总</h3></div>
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr>
              <th>部门</th>
              <th>应到人数</th>
              <th>实到人数</th>
              <th>缺勤</th>
              <th>迟到</th>
              <th>出勤率</th>
            </tr>
          </thead>
          <tbody>
            ${deptStats.map(d => `
              <tr>
                <td><strong>${d.dept}</strong></td>
                <td>${d.total}</td>
                <td>${d.present}</td>
                <td>${d.absent}</td>
                <td>${d.late}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div class="progress-bar" style="width:80px">
                      <div class="progress-fill ${parseInt(d.rate) >= 90 ? 'green' : 'orange'}" style="width:${d.rate}"></div>
                    </div>
                    <span>${d.rate}</span>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function exportAttendance() {
  alert('正在导出考勤表...');
}

function showOvertimeModal() {
  openModal('加班申请', `
    <div class="form-row">
      <div class="form-item">
        <label>申请人</label>
        <input type="text" class="form-input" value="${currentUser.name}" readonly>
      </div>
      <div class="form-item">
        <label>加班日期</label>
        <input type="date" class="form-input" value="2026-11-03">
      </div>
    </div>
    <div class="form-row">
      <div class="form-item">
        <label>开始时间</label>
        <input type="time" class="form-input" value="17:00">
      </div>
      <div class="form-item">
        <label>结束时间</label>
        <input type="time" class="form-input" value="21:00">
      </div>
    </div>
    <div class="form-item">
      <label>加班事由</label>
      <textarea class="form-input" rows="3" placeholder="请输入加班事由..."></textarea>
    </div>
  `, [
    { text: '取消', class: 'btn-default', action: 'closeModal()' },
    { text: '提交申请', class: 'btn-primary', action: 'submitOvertime()' }
  ]);
}

function submitOvertime() {
  alert('加班申请已提交，等待上级审批。');
  closeModal();
}

// ============ 车辆管理 ============
function renderVehicle() {
  return `
    <div class="page-header">
      <h2>车辆管理</h2>
      <p>车辆基本信息、维保记录、加油记录、责任管理及作业监控。</p>
    </div>

    <div class="tabs" id="vehicleTabs">
      <div class="tab-item active" onclick="switchVehicleTab('info')">车辆信息</div>
      <div class="tab-item" onclick="switchVehicleTab('maintenance')">维保记录</div>
      <div class="tab-item" onclick="switchVehicleTab('fuel')">加油记录</div>
      <div class="tab-item" onclick="switchVehicleTab('monitor')">作业监控</div>
    </div>

    <div id="vehicleContent">
      ${renderVehicleInfo()}
    </div>`;
}

function switchVehicleTab(tab) {
  document.querySelectorAll('#vehicleTabs .tab-item').forEach((el, i) => {
    const tabs = ['info', 'maintenance', 'fuel', 'monitor'];
    el.classList.toggle('active', tabs[i] === tab);
  });

  const contentEl = document.getElementById('vehicleContent');
  switch(tab) {
    case 'info': contentEl.innerHTML = renderVehicleInfo(); break;
    case 'maintenance': contentEl.innerHTML = renderMaintenanceRecords(); break;
    case 'fuel': contentEl.innerHTML = renderFuelRecords(); break;
    case 'monitor': contentEl.innerHTML = renderVehicleMonitor(); break;
  }
}

function renderVehicleInfo() {
  const statusTag = (s) => {
    const map = { '正常作业': 'tag-green', '维修中': 'tag-orange', '停场': 'tag-gray' };
    return `<span class="tag ${map[s] || 'tag-gray'}">${s}</span>`;
  };

  return `
    <div class="toolbar">
      <input type="text" class="search-input" placeholder="搜索车牌号...">
      <select class="filter-select">
        <option value="">全部类型</option>
        <option>大型洗扫车</option>
        <option>压缩垃圾车</option>
        <option>高压冲洗车</option>
        <option>洒水车</option>
        <option>小型扫路机</option>
      </select>
      <select class="filter-select">
        <option value="">全部状态</option>
        <option>正常作业</option>
        <option>维修中</option>
        <option>停场</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="alert('新增车辆功能')">+ 新增车辆</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr>
              <th>车牌号</th>
              <th>车辆类型</th>
              <th>能源类型</th>
              <th>品牌型号</th>
              <th>责任司机</th>
              <th>里程(km)</th>
              <th>审车到期</th>
              <th>保险到期</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${vehicles.map(v => `
              <tr>
                <td><strong>${v.plateNo}</strong></td>
                <td>${v.type}</td>
                <td><span class="tag ${v.fuelType === '新能源' ? 'tag-green' : 'tag-blue'}">${v.fuelType}</span></td>
                <td>${v.brand} ${v.model}</td>
                <td>${v.driver}</td>
                <td>${v.mileage.toLocaleString()}</td>
                <td>${isExpiringSoon(v.inspectionExpiry) ? '<span style="color:var(--danger);font-weight:600">' + v.inspectionExpiry + '</span>' : v.inspectionExpiry}</td>
                <td>${v.insuranceExpiry}</td>
                <td>${statusTag(v.status)}</td>
                <td>
                  <button class="btn btn-text btn-sm" onclick="showVehicleDetail(${v.id})">详情</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function isExpiringSoon(dateStr) {
  const expDate = new Date(dateStr);
  const now = new Date('2026-11-03');
  const diff = (expDate - now) / (1000 * 60 * 60 * 24);
  return diff < 30;
}

function renderMaintenanceRecords() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="alert('录入维修/保养记录')">+ 录入记录</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr>
              <th>车牌号</th>
              <th>类型</th>
              <th>日期</th>
              <th>描述</th>
              <th>费用(元)</th>
              <th>录入人</th>
              <th>状态</th>
              <th>预计完成</th>
            </tr>
          </thead>
          <tbody>
            ${maintenanceRecords.map(r => `
              <tr>
                <td><strong>${r.plateNo}</strong></td>
                <td><span class="tag ${r.type === '维修' ? 'tag-red' : 'tag-blue'}">${r.type}</span></td>
                <td>${r.date}</td>
                <td>${r.desc}</td>
                <td>${r.cost.toLocaleString()}</td>
                <td>${r.reporter}</td>
                <td><span class="tag ${r.status === '已完成' ? 'tag-green' : 'tag-orange'}">${r.status}</span></td>
                <td>${r.estimatedComplete || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderFuelRecords() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="alert('拍照上传加油信息：车头照片、里程照片、加油机金额、油量显示照片，程序自动识别记录。')">+ 记录加油</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr>
              <th>车牌号</th>
              <th>日期</th>
              <th>能源类型</th>
              <th>加油量(L)</th>
              <th>金额(元)</th>
              <th>里程(km)</th>
              <th>加油站</th>
              <th>操作人</th>
            </tr>
          </thead>
          <tbody>
            ${fuelRecords.map(r => `
              <tr>
                <td><strong>${r.plateNo}</strong></td>
                <td>${r.date}</td>
                <td><span class="tag ${r.fuelType === '充电' ? 'tag-green' : 'tag-blue'}">${r.fuelType}</span></td>
                <td>${r.liters || '-'}</td>
                <td>${r.cost}</td>
                <td>${r.mileage.toLocaleString()}</td>
                <td>${r.station}</td>
                <td>${r.reporter}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderVehicleMonitor() {
  return `
    <div class="card" style="margin-bottom:24px">
      <div class="card-header">
        <h3>实时作业监控</h3>
        <div style="display:flex;gap:8px">
          <span class="tag tag-green">&#9679; 在线 4台</span>
          <span class="tag tag-orange">&#9679; 维修 1台</span>
          <span class="tag tag-gray">&#9679; 停场 1台</span>
        </div>
      </div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
          ${vehicles.filter(v => v.status === '正常作业').map(v => `
            <div style="border:1px solid var(--border-light);border-radius:8px;padding:16px;position:relative">
              <div style="display:flex;justify-content:space-between;margin-bottom:12px">
                <strong>${v.plateNo}</strong>
                <span class="tag tag-green">作业中</span>
              </div>
              <div style="font-size:13px;color:var(--text-secondary);line-height:2">
                <div>司机：${v.driver}</div>
                <div>类型：${v.type}</div>
                <div>速度：${Math.floor(Math.random() * 30 + 10)} km/h</div>
                <div>今日里程：${(Math.random() * 30 + 10).toFixed(1)} km</div>
              </div>
              <div style="margin-top:8px">
                <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">作业进度</div>
                <div class="progress-bar">
                  <div class="progress-fill green" style="width:${Math.floor(Math.random() * 40 + 50)}%"></div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:20px;padding:16px;background:var(--primary-bg);border-radius:8px;border:1px solid #91caff">
          <strong style="color:var(--primary)">&#128225; 电子围栏与限速</strong>
          <p style="font-size:13px;color:var(--text-secondary);margin-top:4px">
            已为所有作业车辆设置电子围栏和限速（40km/h）。车辆超出作业范围或超速时，将自动启动车载语音警示，并向车队长、机械作业部经理、运营经理发送报警信息。
          </p>
        </div>
      </div>
    </div>`;
}

function showVehicleDetail(id) {
  const v = vehicles.find(x => x.id === id);
  if (!v) return;
  openModal('车辆详情 - ' + v.plateNo, `
    <div class="desc-list">
      <div class="desc-item"><div class="desc-label">车牌号</div><div class="desc-value">${v.plateNo}</div></div>
      <div class="desc-item"><div class="desc-label">车辆类型</div><div class="desc-value">${v.type}</div></div>
      <div class="desc-item"><div class="desc-label">能源类型</div><div class="desc-value">${v.fuelType}</div></div>
      <div class="desc-item"><div class="desc-label">品牌型号</div><div class="desc-value">${v.brand} ${v.model}</div></div>
      <div class="desc-item"><div class="desc-label">购置日期</div><div class="desc-value">${v.purchaseDate}</div></div>
      <div class="desc-item"><div class="desc-label">登记日期</div><div class="desc-value">${v.registerDate}</div></div>
      <div class="desc-item"><div class="desc-label">审车到期</div><div class="desc-value">${v.inspectionExpiry}</div></div>
      <div class="desc-item"><div class="desc-label">保险到期</div><div class="desc-value">${v.insuranceExpiry}</div></div>
      <div class="desc-item"><div class="desc-label">责任司机</div><div class="desc-value">${v.driver}</div></div>
      <div class="desc-item"><div class="desc-label">当前里程</div><div class="desc-value">${v.mileage.toLocaleString()} km</div></div>
      <div class="desc-item"><div class="desc-label">所属部门</div><div class="desc-value">${v.department}</div></div>
      <div class="desc-item"><div class="desc-label">当前状态</div><div class="desc-value">${v.status}</div></div>
    </div>
  `, [{ text: '关闭', class: 'btn-default', action: 'closeModal()' }]);
}

// ============ 人工作业管理 ============
function renderManualWork() {
  return `
    <div class="page-header">
      <h2>人工作业管理</h2>
      <p>片区划分、作业范围管理、电子地图展示。</p>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><h3>片区划分</h3></div>
        <div class="card-body">
          <table>
            <thead>
              <tr><th>片区名称</th><th>负责人</th><th>班组数</th><th>保洁员数</th><th>面积(km²)</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>城东片区</strong></td><td>马丽</td><td>3</td><td>12</td><td>8.5</td></tr>
              <tr><td><strong>城西片区</strong></td><td>黄勇</td><td>2</td><td>10</td><td>6.2</td></tr>
              <tr><td><strong>城南片区</strong></td><td>马丽(兼)</td><td>2</td><td>8</td><td>5.8</td></tr>
              <tr><td><strong>城北片区</strong></td><td>黄勇(兼)</td><td>3</td><td>15</td><td>9.1</td></tr>
              <tr><td><strong>机动保洁组</strong></td><td>胡明</td><td>1</td><td>6</td><td>-</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h3>作业范围电子地图</h3></div>
        <div class="card-body">
          <div style="height:300px;background:linear-gradient(135deg,#e6f4ff,#f0f5ff);border-radius:8px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--primary);position:relative;overflow:hidden">
            <div style="text-align:center;z-index:1">
              <div style="font-size:48px;margin-bottom:8px">&#128506;</div>
              <p style="color:var(--primary);font-weight:500">电子地图展示区域</p>
              <p style="font-size:12px;color:var(--text-secondary);margin-top:4px">录入保洁员作业范围边界定位信息，生成个人、班组及片区作业电子地图</p>
            </div>
            <!-- 模拟地图标记点 -->
            <div style="position:absolute;top:20%;left:25%;width:12px;height:12px;background:var(--primary);border-radius:50%;opacity:0.6"></div>
            <div style="position:absolute;top:40%;left:55%;width:16px;height:16px;background:var(--success);border-radius:50%;opacity:0.6"></div>
            <div style="position:absolute;top:60%;left:35%;width:10px;height:10px;background:var(--warning);border-radius:50%;opacity:0.6"></div>
            <div style="position:absolute;top:30%;left:70%;width:14px;height:14px;background:var(--primary);border-radius:50%;opacity:0.6"></div>
            <div style="position:absolute;top:70%;left:65%;width:12px;height:12px;background:var(--danger);border-radius:50%;opacity:0.6"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:24px">
      <div class="card-header"><h3>人员编制</h3></div>
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>片区/班组</th><th>岗位</th><th>姓名</th><th>联系电话</th><th>作业范围</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr><td>城东片区一组</td><td>班组长</td><td>林小红</td><td>157****0123</td><td>解放路-建设路段</td><td><span class="tag tag-green">在岗</span></td></tr>
            <tr><td>城东片区一组</td><td>保洁员</td><td>何建国</td><td>156****4567</td><td>解放路沿线</td><td><span class="tag tag-green">在岗</span></td></tr>
            <tr><td>城东片区二组</td><td>保洁员</td><td>罗秀英</td><td>155****8901</td><td>人民路-和平路段</td><td><span class="tag tag-blue">在岗</span></td></tr>
            <tr><td>机动保洁组</td><td>队长</td><td>胡明</td><td>153****2345</td><td>全片区机动</td><td><span class="tag tag-green">在岗</span></td></tr>
          </tbody>
        </table>
      </div>
    </div>`;
}

// ============ 人事管理 ============
function renderPersonnel() {
  return `
    <div class="page-header">
      <h2>人事管理</h2>
      <p>人事档案、员工信息、自动算薪。编辑权限为指定的综合管理员，调阅权限为运营经理以上职级。</p>
    </div>

    <div class="tabs" id="personnelTabs">
      <div class="tab-item active" onclick="switchPersonnelTab('archive')">人事档案</div>
      <div class="tab-item" onclick="switchPersonnelTab('info')">员工信息表</div>
      <div class="tab-item" onclick="switchPersonnelTab('payroll')">薪资核算</div>
    </div>

    <div id="personnelContent">
      ${renderPersonnelArchive()}
    </div>`;
}

function switchPersonnelTab(tab) {
  document.querySelectorAll('#personnelTabs .tab-item').forEach((el, i) => {
    const tabs = ['archive', 'info', 'payroll'];
    el.classList.toggle('active', tabs[i] === tab);
  });

  const contentEl = document.getElementById('personnelContent');
  switch(tab) {
    case 'archive': contentEl.innerHTML = renderPersonnelArchive(); break;
    case 'info': contentEl.innerHTML = renderPersonnelInfo(); break;
    case 'payroll': contentEl.innerHTML = renderPayroll(); break;
  }
}

function renderPersonnelArchive() {
  return `
    <div class="toolbar">
      <input type="text" class="search-input" placeholder="搜索姓名、岗位...">
      <select class="filter-select">
        <option value="">全部部门</option>
        <option>机械作业部</option>
        <option>人工作业部</option>
        <option>综合管理部</option>
        <option>财务部</option>
        <option>管理层</option>
      </select>
      <select class="filter-select">
        <option value="">全部用工类型</option>
        <option>正式</option>
        <option>劳务派遣</option>
      </select>
      <button class="btn btn-primary btn-sm" onclick="alert('新增员工档案')">+ 新增员工</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr>
              <th>工号</th><th>姓名</th><th>性别</th><th>年龄</th><th>岗位</th><th>部门</th><th>学历</th><th>用工类型</th><th>入司时间</th><th>状态</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${employees.map(e => `
              <tr>
                <td>${String(e.id).padStart(4, '0')}</td>
                <td><strong>${e.name}</strong></td>
                <td>${e.gender}</td>
                <td>${e.age}</td>
                <td>${e.position}</td>
                <td>${e.department}</td>
                <td>${e.education}</td>
                <td><span class="tag ${e.type === '正式' ? 'tag-blue' : 'tag-purple'}">${e.type}</span></td>
                <td>${e.joinDate}</td>
                <td><span class="tag tag-green">${e.status}</span></td>
                <td><button class="btn btn-text btn-sm" onclick="showEmployeeDetail(${e.id})">查看</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderPersonnelInfo() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="alert('导出员工信息表Excel')">导出Excel</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>姓名</th><th>岗位</th><th>入司时间</th><th>用工类型</th><th>保险情况</th><th>基本薪资</th><th>本月奖惩</th><th>实发薪资</th></tr>
          </thead>
          <tbody>
            ${employees.slice(0, 10).map(e => {
              const baseSalary = e.position.includes('经理') ? 8000 : e.position.includes('队长') ? 5500 : e.position === '保洁员' ? 3500 : 4500;
              const rp = rewardPunishmentRecords.find(r => r.employeeId === e.id);
              const rpAmount = rp ? rp.amount : 0;
              const actual = baseSalary + rpAmount;
              return `
                <tr>
                  <td><strong>${e.name}</strong></td>
                  <td>${e.position}</td>
                  <td>${e.joinDate}</td>
                  <td>${e.type}</td>
                  <td><span class="tag tag-green">${e.type === '正式' ? '社保' : '雇主责任险'}</span></td>
                  <td>${baseSalary.toLocaleString()}</td>
                  <td style="color:${rpAmount >= 0 ? 'var(--success)' : 'var(--danger)'}">${rpAmount >= 0 ? '+' : ''}${rpAmount}</td>
                  <td><strong>${actual.toLocaleString()}</strong></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderPayroll() {
  return `
    <div class="alert alert-info">
      &#128272; 自动算薪功能：根据每个人薪资构成、考勤、奖惩、社保、所得税等，每月固定时间节点自动生成薪酬数据明细。仅本人和授权管理人可查（授权管理人可设3人）。
    </div>
    <div class="toolbar">
      <select class="filter-select"><option>2026年11月</option><option>2026年10月</option></select>
      <button class="btn btn-primary btn-sm" onclick="alert('正在生成11月薪酬数据...')">生成月薪数据</button>
      <button class="btn btn-default btn-sm" onclick="alert('导出薪资明细')">导出明细</button>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon blue">&#128101;</div>
        <div class="stat-info">
          <div class="stat-label">应发总人数</div>
          <div class="stat-value">${employees.length}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">&#128176;</div>
        <div class="stat-info">
          <div class="stat-label">应发工资总额</div>
          <div class="stat-value">¥${(employees.length * 5200).toLocaleString()}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">&#128200;</div>
        <div class="stat-info">
          <div class="stat-label">社保/保险总额</div>
          <div class="stat-value">¥${(employees.length * 1200).toLocaleString()}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon red">&#128181;</div>
        <div class="stat-info">
          <div class="stat-label">实发工资总额</div>
          <div class="stat-value">¥${(employees.length * 4800).toLocaleString()}</div>
        </div>
      </div>
    </div>`;
}

function showEmployeeDetail(id) {
  const e = employees.find(x => x.id === id);
  if (!e) return;
  openModal('员工档案 - ' + e.name, `
    <div class="desc-list">
      <div class="desc-item"><div class="desc-label">姓名</div><div class="desc-value">${e.name}</div></div>
      <div class="desc-item"><div class="desc-label">性别</div><div class="desc-value">${e.gender}</div></div>
      <div class="desc-item"><div class="desc-label">年龄</div><div class="desc-value">${e.age}</div></div>
      <div class="desc-item"><div class="desc-label">岗位</div><div class="desc-value">${e.position}</div></div>
      <div class="desc-item"><div class="desc-label">部门</div><div class="desc-value">${e.department}</div></div>
      <div class="desc-item"><div class="desc-label">联系电话</div><div class="desc-value">${e.phone}</div></div>
      <div class="desc-item"><div class="desc-label">学历</div><div class="desc-value">${e.education}</div></div>
      <div class="desc-item"><div class="desc-label">用工类型</div><div class="desc-value">${e.type}</div></div>
      <div class="desc-item"><div class="desc-label">入司时间</div><div class="desc-value">${e.joinDate}</div></div>
      <div class="desc-item"><div class="desc-label">状态</div><div class="desc-value">${e.status}</div></div>
    </div>
    <div style="margin-top:16px">
      <h4 style="margin-bottom:8px">奖惩记录</h4>
      ${rewardPunishmentRecords.filter(r => r.employeeId === e.id).map(r => `
        <div style="padding:8px 12px;border:1px solid var(--border-light);border-radius:6px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <span class="tag ${r.type === '奖励' ? 'tag-green' : 'tag-red'}">${r.type}</span>
            <span style="margin-left:8px;font-size:13px">${r.reason}</span>
          </div>
          <strong style="color:${r.amount >= 0 ? 'var(--success)' : 'var(--danger)'}">${r.amount >= 0 ? '+' : ''}${r.amount}元</strong>
        </div>
      `).join('') || '<p style="color:var(--text-secondary);font-size:13px">暂无奖惩记录</p>'}
    </div>
  `, [{ text: '关闭', class: 'btn-default', action: 'closeModal()' }]);
}

// ============ 品质安全 ============
function renderQuality() {
  return `
    <div class="page-header">
      <h2>品质、安全</h2>
      <p>点检督查、通知管理、奖惩记录、例会管理。</p>
    </div>

    <div class="tabs" id="qualityTabs">
      <div class="tab-item active" onclick="switchQualityTab('inspection')">点检督查</div>
      <div class="tab-item" onclick="switchQualityTab('notice')">通知</div>
      <div class="tab-item" onclick="switchQualityTab('reward')">奖惩</div>
      <div class="tab-item" onclick="switchQualityTab('meeting')">例会管理</div>
    </div>

    <div id="qualityContent">
      ${renderInspectionRecords()}
    </div>`;
}

function switchQualityTab(tab) {
  document.querySelectorAll('#qualityTabs .tab-item').forEach((el, i) => {
    const tabs = ['inspection', 'notice', 'reward', 'meeting'];
    el.classList.toggle('active', tabs[i] === tab);
  });

  const contentEl = document.getElementById('qualityContent');
  switch(tab) {
    case 'inspection': contentEl.innerHTML = renderInspectionRecords(); break;
    case 'notice': contentEl.innerHTML = renderNotices(); break;
    case 'reward': contentEl.innerHTML = renderRewards(); break;
    case 'meeting': contentEl.innerHTML = renderMeetings(); break;
  }
}

function renderInspectionRecords() {
  const catTag = (c) => c === '品质' ? 'tag-blue' : 'tag-red';
  const sevTag = (s) => {
    const map = { '轻微': 'tag-gray', '一般': 'tag-orange', '严重': 'tag-red' };
    return `<span class="tag ${map[s] || 'tag-gray'}">${s}</span>`;
  };
  const statusTag = (s) => {
    return `<span class="tag ${s === '已整改' ? 'tag-green' : 'tag-orange'}">${s}</span>`;
  };

  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="showInspectionModal()">+ 上报问题</button>
      <select class="filter-select">
        <option value="">全部类别</option>
        <option>品质</option>
        <option>安全</option>
      </select>
      <select class="filter-select">
        <option value="">全部状态</option>
        <option>整改中</option>
        <option>已整改</option>
      </select>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr>
              <th>检查人</th><th>时间</th><th>位置</th><th>类别</th><th>严重程度</th><th>问题描述</th><th>责任人</th><th>整改期限</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${inspectionRecords.map(r => `
              <tr>
                <td>${r.inspector}<br><span style="font-size:11px;color:var(--text-secondary)">${r.inspectorRole}</span></td>
                <td>${r.date} ${r.time}</td>
                <td style="max-width:150px">${r.location}</td>
                <td><span class="tag ${catTag(r.category)}">${r.category}</span></td>
                <td>${sevTag(r.severity)}</td>
                <td style="max-width:200px">${r.desc}</td>
                <td>${r.targetEmployee}</td>
                <td>${r.deadline}</td>
                <td>${statusTag(r.status)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderNotices() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="alert('发布新通知')">+ 发布通知</button>
    </div>
    ${notifications.map(n => `
      <div class="card" style="margin-bottom:12px;${!n.read ? 'border-left:3px solid var(--primary)' : ''}">
        <div class="card-body" style="padding:16px 24px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <strong style="font-size:15px">${!n.read ? '&#128308; ' : ''}${n.title}</strong>
              <div style="font-size:13px;color:var(--text-secondary);margin-top:4px">
                ${n.sender}（${n.senderRole}）· ${n.date}
              </div>
            </div>
            <span class="tag ${n.priority === '紧急' ? 'tag-red' : n.priority === '重要' ? 'tag-orange' : 'tag-blue'}">${n.priority}</span>
          </div>
          <p style="margin-top:8px;font-size:14px;color:var(--text-primary);line-height:1.6">${n.content}</p>
          <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary)">该信息对所有人可视</div>
        </div>
      </div>
    `).join('')}`;
}

function renderRewards() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="alert('新增奖惩记录')">+ 新增记录</button>
      <button class="btn btn-default btn-sm" onclick="alert('生成奖惩通告')">生成通告</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>姓名</th><th>类型</th><th>日期</th><th>原因</th><th>金额</th><th>审批人</th><th>状态</th></tr>
          </thead>
          <tbody>
            ${rewardPunishmentRecords.map(r => `
              <tr>
                <td><strong>${r.name}</strong></td>
                <td><span class="tag ${r.type === '奖励' ? 'tag-green' : 'tag-red'}">${r.type}</span></td>
                <td>${r.date}</td>
                <td>${r.reason}</td>
                <td style="color:${r.amount >= 0 ? 'var(--success)' : 'var(--danger)'}; font-weight:600">${r.amount >= 0 ? '+' : ''}${r.amount}元</td>
                <td>${r.approver}</td>
                <td><span class="tag ${r.status === '已执行' ? 'tag-green' : 'tag-orange'}">${r.status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="alert alert-info" style="margin-top:16px">
      管理程序根据点检督查问题的整改时效和项目公司奖惩制度自动生成奖励、处罚结果，自动管理人事档案和薪资核算，奖惩通告对所有人可视。
    </div>`;
}

function renderMeetings() {
  const meetings = [
    { id: 1, title: '11月第1周运营例会', type: '主管例会', date: '2026-11-03 14:00', organizer: '刘洋', attendees: 12, status: '已完成', photos: 5 },
    { id: 2, title: '车队安全培训例会', type: '车队例会', date: '2026-11-05 14:00', organizer: '赵强', attendees: 8, status: '待开展', photos: 0 },
    { id: 3, title: '保洁员10月总结例会', type: '保洁员例会', date: '2026-10-31 08:00', organizer: '林小红', attendees: 15, status: '已完成', photos: 8 },
  ];

  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="alert('上传例会照片和工作安排')">+ 记录例会</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>会议名称</th><th>类型</th><th>时间</th><th>组织者</th><th>参会人数</th><th>照片</th><th>状态</th></tr>
          </thead>
          <tbody>
            ${meetings.map(m => `
              <tr>
                <td><strong>${m.title}</strong></td>
                <td><span class="tag tag-blue">${m.type}</span></td>
                <td>${m.date}</td>
                <td>${m.organizer}</td>
                <td>${m.attendees}人</td>
                <td>${m.photos}张</td>
                <td><span class="tag ${m.status === '已完成' ? 'tag-green' : 'tag-orange'}">${m.status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function showInspectionModal() {
  openModal('上报品质/安全问题', `
    <div class="form-row">
      <div class="form-item">
        <label>问题类别</label>
        <select class="form-select">
          <option>品质问题</option>
          <option>安全问题</option>
          <option>其他违规</option>
        </select>
      </div>
      <div class="form-item">
        <label>严重程度</label>
        <select class="form-select">
          <option>轻微</option>
          <option>一般</option>
          <option>严重</option>
        </select>
      </div>
    </div>
    <div class="form-item">
      <label>问题位置</label>
      <input type="text" class="form-input" placeholder="输入或选择定位位置...">
    </div>
    <div class="form-item">
      <label>问题描述</label>
      <textarea class="form-input" rows="3" placeholder="请详细描述发现的问题..."></textarea>
    </div>
    <div class="form-item">
      <label>责任人</label>
      <select class="form-select">
        <option value="">请选择责任人</option>
        ${employees.map(e => `<option value="${e.id}">${e.name} - ${e.position}</option>`).join('')}
      </select>
    </div>
    <div class="form-item">
      <label>拍照上传</label>
      <div style="width:100px;height:100px;border:2px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-tertiary);font-size:24px" onclick="alert('调用相机拍照上传功能')">&#128247;</div>
    </div>
    <div class="form-item">
      <label>整改期限</label>
      <input type="datetime-local" class="form-input" value="2026-11-03T18:00">
    </div>
  `, [
    { text: '取消', class: 'btn-default', action: 'closeModal()' },
    { text: '提交', class: 'btn-primary', action: 'submitInspection()' }
  ]);
}

function submitInspection() {
  alert('问题已上报！管理程序将根据位置信息和问题性质向责任人发送整改通知。该信息对所有人可视。');
  closeModal();
}

// ============ 审批流程 ============
function renderWorkflow() {
  return `
    <div class="page-header">
      <h2>审批流程</h2>
      <p>请假、出差、用印、采购、维修等各类审批流程管理。</p>
    </div>

    <div class="tabs" id="workflowTabs">
      <div class="tab-item active" onclick="switchWorkflowTab('pending')">待我审批</div>
      <div class="tab-item" onclick="switchWorkflowTab('mine')">我的申请</div>
      <div class="tab-item" onclick="switchWorkflowTab('all')">全部流程</div>
    </div>

    <div id="workflowContent">
      ${renderWorkflowPending()}
    </div>`;
}

function switchWorkflowTab(tab) {
  document.querySelectorAll('#workflowTabs .tab-item').forEach((el, i) => {
    const tabs = ['pending', 'mine', 'all'];
    el.classList.toggle('active', tabs[i] === tab);
  });

  const contentEl = document.getElementById('workflowContent');
  switch(tab) {
    case 'pending': contentEl.innerHTML = renderWorkflowPending(); break;
    case 'mine': contentEl.innerHTML = renderWorkflowMine(); break;
    case 'all': contentEl.innerHTML = renderWorkflowAll(); break;
  }
}

function renderWorkflowPending() {
  const pending = workflowRecords.filter(w => w.status === '审批中');
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="showNewWorkflowModal()">+ 发起申请</button>
    </div>
    ${pending.length === 0 ? '<div class="empty-state"><div class="empty-icon">&#9989;</div><p>暂无待审批事项</p></div>' :
    pending.map(w => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-body" style="padding:16px 24px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
            <div>
              <strong style="font-size:15px">${w.type}</strong>
              <span class="tag tag-blue" style="margin-left:8px">${w.id}</span>
            </div>
            <span class="tag tag-orange">审批中 (${w.currentStep}/${w.totalSteps})</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-size:13px;color:var(--text-secondary)">
            <div>申请人：<strong style="color:var(--text-primary)">${w.applicant}</strong></div>
            <div>部门：${w.department}</div>
            <div>申请日期：${w.date}</div>
            <div>当前审批人：${w.approver}</div>
          </div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-success btn-sm" onclick="approveWorkflow('${w.id}')">通过</button>
            <button class="btn btn-danger btn-sm" onclick="rejectWorkflow('${w.id}')">驳回</button>
            <button class="btn btn-default btn-sm" onclick="viewWorkflowDetail('${w.id}')">查看详情</button>
          </div>
        </div>
      </div>
    `).join('')}`;
}

function renderWorkflowMine() {
  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="showNewWorkflowModal()">+ 发起申请</button>
    </div>
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>流程编号</th><th>类型</th><th>申请日期</th><th>审批人</th><th>进度</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${workflowRecords.slice(0, 4).map(w => `
              <tr>
                <td>${w.id}</td>
                <td><span class="tag tag-blue">${w.type}</span></td>
                <td>${w.date}</td>
                <td>${w.approver}</td>
                <td>
                  <div class="progress-bar" style="width:80px;display:inline-block;vertical-align:middle">
                    <div class="progress-fill blue" style="width:${(w.currentStep / w.totalSteps * 100)}%"></div>
                  </div>
                  <span style="font-size:12px;margin-left:4px">${w.currentStep}/${w.totalSteps}</span>
                </td>
                <td><span class="tag ${w.status === '已批准' ? 'tag-green' : 'tag-orange'}">${w.status}</span></td>
                <td><button class="btn btn-text btn-sm" onclick="viewWorkflowDetail('${w.id}')">详情</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderWorkflowAll() {
  return `
    <div class="card">
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>流程编号</th><th>类型</th><th>申请人</th><th>部门</th><th>日期</th><th>审批人</th><th>状态</th></tr>
          </thead>
          <tbody>
            ${workflowRecords.map(w => `
              <tr>
                <td>${w.id}</td>
                <td><span class="tag tag-blue">${w.type}</span></td>
                <td>${w.applicant}</td>
                <td>${w.department}</td>
                <td>${w.date}</td>
                <td>${w.approver}</td>
                <td><span class="tag ${w.status === '已批准' ? 'tag-green' : w.status === '已驳回' ? 'tag-red' : 'tag-orange'}">${w.status}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function showNewWorkflowModal() {
  openModal('发起申请', `
    <div class="form-item">
      <label>申请类型</label>
      <select class="form-select" id="wfType" onchange="updateWorkflowForm()">
        <option value="leave">请假申请</option>
        <option value="travel">出差申请</option>
        <option value="seal">用印申请</option>
        <option value="purchase">采购申请</option>
        <option value="tempPurchase">临时采购申请</option>
        <option value="repair">维修申请</option>
        <option value="material">物资发放/领取</option>
      </select>
    </div>
    <div id="wfFormContent">
      <div class="form-row">
        <div class="form-item">
          <label>请假类型</label>
          <select class="form-select"><option>事假</option><option>病假</option><option>年假</option><option>轮休</option></select>
        </div>
        <div class="form-item">
          <label>审批人</label>
          <select class="form-select"><option>直属上级</option><option>片区经理</option><option>运营经理</option></select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-item"><label>开始时间</label><input type="datetime-local" class="form-input"></div>
        <div class="form-item"><label>结束时间</label><input type="datetime-local" class="form-input"></div>
      </div>
      <div class="form-item"><label>事由说明</label><textarea class="form-input" rows="3" placeholder="请说明请假事由..."></textarea></div>
    </div>
  `, [
    { text: '取消', class: 'btn-default', action: 'closeModal()' },
    { text: '提交申请', class: 'btn-primary', action: 'submitWorkflow()' }
  ]);
}

function updateWorkflowForm() {
  // 简化：实际应根据类型动态渲染不同表单
}

function submitWorkflow() {
  alert('申请已提交，等待审批。');
  closeModal();
}

function approveWorkflow(id) {
  if (confirm('确认通过该审批？')) {
    alert('已通过审批 ' + id);
    navigateTo('workflow');
  }
}

function rejectWorkflow(id) {
  if (confirm('确认驳回该审批？')) {
    alert('已驳回审批 ' + id);
    navigateTo('workflow');
  }
}

function viewWorkflowDetail(id) {
  const w = workflowRecords.find(x => x.id === id);
  if (!w) return;

  let detailHtml = `
    <div style="margin-bottom:16px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span class="tag tag-blue">${w.type}</span>
        <span class="tag ${w.status === '已批准' ? 'tag-green' : 'tag-orange'}">${w.status}</span>
        <span style="font-size:13px;color:var(--text-secondary)">${w.id}</span>
      </div>
      <div style="font-size:13px;color:var(--text-secondary)">
        申请人：${w.applicant} · ${w.department} · ${w.date}
      </div>
    </div>
    <div class="workflow-timeline">
      <div class="workflow-step">
        <div class="step-dot done">&#10003;</div>
        <div class="step-content">
          <div class="step-title">提交申请</div>
          <div class="step-desc">${w.applicant} 于 ${w.date} 提交</div>
        </div>
      </div>`;

  for (let i = 1; i <= w.totalSteps; i++) {
    const isDone = i < w.currentStep || w.status === '已批准';
    const isActive = i === w.currentStep && w.status === '审批中';
    const dotClass = isDone ? 'done' : isActive ? 'active' : 'pending';
    const icon = isDone ? '&#10003;' : i;
    detailHtml += `
      <div class="workflow-step">
        <div class="step-dot ${dotClass}">${icon}</div>
        <div class="step-content">
          <div class="step-title">审批节点 ${i}</div>
          <div class="step-desc">${isDone ? '已审批通过' : isActive ? '等待审批中...' : '待审批'}</div>
        </div>
      </div>`;
  }

  detailHtml += '</div>';

  openModal('流程详情', detailHtml, [{ text: '关闭', class: 'btn-default', action: 'closeModal()' }]);
}

// ============ AI办公 ============
function renderAiOffice() {
  return `
    <div class="page-header">
      <h2>AI办公</h2>
      <p>AI文档处理、AI法务、AI美文、会议纪要等智能办公功能。</p>
    </div>

    <div class="grid-2" style="margin-bottom:24px">
      <div class="card" style="cursor:pointer" onclick="showAiDocModal('document')">
        <div class="card-body" style="padding:24px;text-align:center">
          <div style="font-size:48px;margin-bottom:12px">&#128196;</div>
          <h3 style="margin-bottom:8px">AI文档处理</h3>
          <p style="font-size:13px;color:var(--text-secondary)">根据工作群图片、数据等资料，自动生成所需表格或文案</p>
        </div>
      </div>
      <div class="card" style="cursor:pointer" onclick="showAiDocModal('legal')">
        <div class="card-body" style="padding:24px;text-align:center">
          <div style="font-size:48px;margin-bottom:12px">&#9878;&#65039;</div>
          <h3 style="margin-bottom:8px">AI法务</h3>
          <p style="font-size:13px;color:var(--text-secondary)">自动审核对内对外文件、合同、协议，提出修改意见</p>
        </div>
      </div>
      <div class="card" style="cursor:pointer" onclick="showAiDocModal('article')">
        <div class="card-body" style="padding:24px;text-align:center">
          <div style="font-size:48px;margin-bottom:12px">&#9997;&#65039;</div>
          <h3 style="margin-bottom:8px">AI美文</h3>
          <p style="font-size:13px;color:var(--text-secondary)">根据图片和数据生成宣扬团队精神风貌的文案</p>
        </div>
      </div>
      <div class="card" style="cursor:pointer" onclick="showAiDocModal('minutes')">
        <div class="card-body" style="padding:24px;text-align:center">
          <div style="font-size:48px;margin-bottom:12px">&#127908;&#65039;</div>
          <h3 style="margin-bottom:8px">会议纪要</h3>
          <p style="font-size:13px;color:var(--text-secondary)">会议录音自动生成会议纪要，支持同步电话/视频会议</p>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>AI文档历史</h3>
      </div>
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>标题</th><th>类型</th><th>作者</th><th>日期</th><th>状态</th><th>说明</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${aiDocuments.map(d => `
              <tr>
                <td><strong>${d.title}</strong></td>
                <td><span class="tag tag-purple">${d.type}</span></td>
                <td>${d.author}</td>
                <td>${d.date}</td>
                <td><span class="tag ${d.status === '已定稿' || d.status === '已发布' ? 'tag-green' : d.status === '审核中' ? 'tag-orange' : 'tag-blue'}">${d.status}</span></td>
                <td style="max-width:200px;font-size:13px;color:var(--text-secondary)">${d.desc}</td>
                <td><button class="btn btn-text btn-sm">查看</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function showAiDocModal(type) {
  const titles = { document: 'AI文档处理', legal: 'AI法务审核', article: 'AI美文生成', minutes: '会议纪要生成' };
  const descs = {
    document: '选择工作群，关联图片和数据资料，AI自动生成所需表格或文案。',
    legal: '上传需加盖公章的文件，AI法务自动审核并提出修改建议。',
    article: '上传现场图片或关联工作群数据，AI生成宣扬团队风貌的文案。',
    minutes: '开始录音或关联会议，AI自动生成会议纪要。'
  };

  openModal(titles[type], `
    <div class="alert alert-info">${descs[type]}</div>
    <div class="form-item">
      <label>关联工作群</label>
      <select class="form-select">
        ${workGroups.map(g => `<option>${g.name}</option>`).join('')}
      </select>
    </div>
    <div class="form-item">
      <label>上传资料（图片/文件）</label>
      <div style="width:100%;height:80px;border:2px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-tertiary)" onclick="alert('选择文件或拍照上传')">
        点击或拖拽上传图片、照片、数据文件
      </div>
    </div>
    <div class="form-item">
      <label>补充说明</label>
      <textarea class="form-input" rows="3" placeholder="输入具体要求或补充说明..."></textarea>
    </div>
    <div class="form-item">
      <label>生成要求</label>
      <textarea class="form-input" rows="2" placeholder="描述你希望AI生成什么样的文档..."></textarea>
    </div>
  `, [
    { text: '取消', class: 'btn-default', action: 'closeModal()' },
    { text: 'AI生成', class: 'btn-primary', action: 'generateAiDoc()' }
  ]);
}

function generateAiDoc() {
  alert('AI正在生成文档，请稍候...生成完成后将进入人工审核环节。');
  closeModal();
}

// ============ 个人工作 ============
function renderPersonal() {
  return `
    <div class="page-header">
      <h2>个人工作</h2>
      <p>外联工作记录、个人日报查看与提交。</p>
    </div>

    <div class="tabs" id="personalTabs">
      <div class="tab-item active" onclick="switchPersonalTab('outreach')">外联记录</div>
      <div class="tab-item" onclick="switchPersonalTab('daily')">工作日报</div>
    </div>

    <div id="personalContent">
      ${renderOutreach()}
    </div>`;
}

function switchPersonalTab(tab) {
  document.querySelectorAll('#personalTabs .tab-item').forEach((el, i) {
    const tabs = ['outreach', 'daily'];
    el.classList.toggle('active', tabs[i] === tab);
  });

  const contentEl = document.getElementById('personalContent');
  switch(tab) {
    case 'outreach': contentEl.innerHTML = renderOutreach(); break;
    case 'daily': contentEl.innerHTML = renderDailyReport(); break;
  }
}

function renderOutreach() {
  const outreachRecords = [
    { id: 1, date: '2026-11-03', type: '拜访业主', location: '城东环卫所', desc: '沟通11月份作业计划调整事宜', photos: 3 },
    { id: 2, date: '2026-11-01', type: '联合办公', location: '区城管局', desc: '配合区里创建文明城市检查工作', photos: 5 },
    { id: 3, date: '2026-10-28', type: '参加活动', location: '市环卫协会', desc: '参加环卫行业年度交流会', photos: 2 },
  ];

  return `
    <div class="toolbar">
      <button class="btn btn-primary btn-sm" onclick="showOutreachModal()">+ 记录外联</button>
    </div>
    ${outreachRecords.map(r => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-body" style="padding:16px 24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>${r.type}</strong>
            <span style="font-size:13px;color:var(--text-secondary)">${r.date}</span>
          </div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">&#128205; ${r.location}</div>
          <p style="font-size:14px">${r.desc}</p>
          <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary)">现场照片 ${r.photos} 张</div>
        </div>
      </div>
    `).join('')}`;
}

function renderDailyReport() {
  return `
    <div class="alert alert-info">
      每日21点自动生成工作日报，汇总个人打卡、督查点检、工作群提交信息、外联工作记录等，并上传上级领导查阅。
    </div>
    ${dailyReports.map(r => `
      <div class="card" style="margin-bottom:12px">
        <div class="card-body" style="padding:16px 24px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div>
              <strong>${r.name}</strong>
              <span class="tag tag-blue" style="margin-left:8px">${r.role}</span>
            </div>
            <span style="font-size:13px;color:var(--text-secondary)">${r.date} ${r.generatedAt}</span>
          </div>
          <p style="font-size:14px;line-height:1.8;color:var(--text-primary)">${r.content}</p>
          <div style="margin-top:8px;font-size:12px;color:var(--text-tertiary)">附件 ${r.attachments} 个</div>
        </div>
      </div>
    `).join('')}`;
}

function showOutreachModal() {
  openModal('记录外联工作', `
    <div class="form-item">
      <label>外联类型</label>
      <select class="form-select">
        <option>拜访业主</option>
        <option>联合办公</option>
        <option>办理工商税务</option>
        <option>出差工作</option>
        <option>参加上级公司活动</option>
        <option>其他</option>
      </select>
    </div>
    <div class="form-item">
      <label>工作地点</label>
      <input type="text" class="form-input" placeholder="输入地点或获取当前定位...">
    </div>
    <div class="form-item">
      <label>工作内容</label>
      <textarea class="form-input" rows="3" placeholder="请描述工作内容..."></textarea>
    </div>
    <div class="form-item">
      <label>现场照片</label>
      <div style="width:100px;height:100px;border:2px dashed var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-tertiary);font-size:24px" onclick="alert('拍照上传')">&#128247;</div>
    </div>
  `, [
    { text: '取消', class: 'btn-default', action: 'closeModal()' },
    { text: '提交', class: 'btn-primary', action: 'submitOutreach()' }
  ]);
}

function submitOutreach() {
  alert('外联工作记录已提交！');
  closeModal();
}

// ============ 待办 ============
function renderTodo() {
  const pending = todoItems.filter(t => t.status === 'pending');
  const done = todoItems.filter(t => t.status === 'done');

  return `
    <div class="page-header">
      <h2>待办中心</h2>
      <p>所有到本人节点的待阅、待办事项。</p>
    </div>

    <div class="stats-grid" style="margin-bottom:24px">
      <div class="stat-card">
        <div class="stat-icon red">&#128276;</div>
        <div class="stat-info">
          <div class="stat-label">待办事项</div>
          <div class="stat-value">${pending.filter(t => t.type === '待办').length}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange">&#128064;</div>
        <div class="stat-info">
          <div class="stat-label">待阅事项</div>
          <div class="stat-value">${pending.filter(t => t.type === '待阅').length}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green">&#9989;</div>
        <div class="stat-info">
          <div class="stat-label">已处理</div>
          <div class="stat-value">${done.length}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3>待处理事项</h3>
      </div>
      <div class="card-body no-padding">
        <table>
          <thead>
            <tr><th>事项</th><th>类型</th><th>来源</th><th>模块</th><th>优先级</th><th>截止时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${pending.map(t => `
              <tr>
                <td><strong>${t.title}</strong></td>
                <td><span class="tag ${t.type === '待办' ? 'tag-blue' : 'tag-gray'}">${t.type}</span></td>
                <td>${t.from}</td>
                <td>${t.module}</td>
                <td>${getPriorityTag(t.priority)}</td>
                <td>${t.deadline}</td>
                <td>
                  <button class="btn btn-primary btn-sm" onclick="completeTodo(${t.id})">处理</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function completeTodo(id) {
  const item = todoItems.find(t => t.id === id);
  if (item) {
    item.status = 'done';
    alert('已处理：' + item.title);
    navigateTo('todo');
  }
}

// ============ AI学院 ============
function renderAiAcademy() {
  const articles = [
    { id: 1, title: '环卫车辆冬季保养注意事项', category: '设备维护', source: '环卫在线', date: '2026-11-01', reads: 45 },
    { id: 2, title: '如何提高道路清扫作业效率', category: '作业方法', source: '城市环卫之家', date: '2026-10-28', reads: 67 },
    { id: 3, title: '新能源环卫车操作规范培训', category: '安全管理', source: '环卫科技网', date: '2026-10-25', reads: 89 },
    { id: 4, title: '项目公司绩效考核制度解读', category: '公司制度', source: '公司内部', date: '2026-10-20', reads: 120 },
    { id: 5, title: '秋季落叶清扫作业技巧分享', category: '作业方法', source: '环卫在线', date: '2026-10-18', reads: 56 },
    { id: 6, title: '员工安全培训手册（2026版）', category: '安全管理', source: '公司内部', date: '2026-10-15', reads: 198 },
  ];

  const rules = [
    { id: 1, name: '员工考勤管理制度', date: '2026-01-01', version: 'V3.2' },
    { id: 2, name: '奖惩管理制度', date: '2025-06-01', version: 'V2.1' },
    { id: 3, name: '安全生产管理制度', date: '2026-03-01', version: 'V4.0' },
    { id: 4, name: '车辆设备管理制度', date: '2025-09-01', version: 'V2.5' },
  ];

  return `
    <div class="page-header">
      <h2>AI学院</h2>
      <p>公司规章制度、行业知识学习、员工经验分享。</p>
    </div>

    <div class="tabs" id="academyTabs">
      <div class="tab-item active" onclick="switchAcademyTab('articles')">行业文章</div>
      <div class="tab-item" onclick="switchAcademyTab('rules')">公司制度</div>
      <div class="tab-item" onclick="switchAcademyTab('sharing')">员工发文</div>
    </div>

    <div id="academyContent">
      <div class="toolbar">
        <input type="text" class="search-input" placeholder="搜索文章...">
        <select class="filter-select">
          <option value="">全部分类</option>
          <option>运营管理</option>
          <option>作业方法</option>
          <option>设备维护</option>
          <option>安全管理</option>
        </select>
      </div>
      ${articles.map(a => `
        <div class="card" style="margin-bottom:12px;cursor:pointer" onclick="alert('打开文章：${a.title}')">
          <div class="card-body" style="padding:16px 24px;display:flex;justify-content:space-between;align-items:center">
            <div>
              <strong style="font-size:15px">${a.title}</strong>
              <div style="margin-top:4px;display:flex;gap:8px;align-items:center">
                <span class="tag tag-blue">${a.category}</span>
                <span style="font-size:12px;color:var(--text-secondary)">来源：${a.source}</span>
                <span style="font-size:12px;color:var(--text-tertiary)">${a.date}</span>
              </div>
            </div>
            <div style="text-align:right;font-size:12px;color:var(--text-tertiary)">
              &#128064; ${a.reads} 次阅读
            </div>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function switchAcademyTab(tab) {
  document.querySelectorAll('#academyTabs .tab-item').forEach((el, i) => {
    const tabs = ['articles', 'rules', 'sharing'];
    el.classList.toggle('active', tabs[i] === tab);
  });
  // 简化：实际应切换不同内容
}

// ============ 工作群组 ============
function renderGroups() {
  return `
    <div class="page-header">
      <h2>工作群组</h2>
      <p>根据组织架构自动生成的工作群组。</p>
    </div>

    ${workGroups.map(g => `
      <div class="group-card">
        <div class="group-header">
          <div class="group-avatar">&#128172;</div>
          <div style="flex:1">
            <div class="group-name">${g.name}</div>
            <div class="group-last-msg">${g.lastMessage}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;color:var(--text-tertiary)">${g.lastTime}</div>
            <span class="tag tag-blue">${g.members.length}人</span>
          </div>
        </div>
        <div class="group-meta">
          <span>成员：${g.members.join('、')}</span>
          <span>${g.messageCount} 条消息</span>
        </div>
      </div>
    `).join('')}`;
}

// ============ 通知 ============
function renderNotifications() {
  const listEl = document.getElementById('notificationList');
  listEl.innerHTML = notifications.map(n => `
    <div class="notification-item ${!n.read ? 'unread' : ''}" onclick="readNotification(${n.id})">
      <div class="notif-title">${!n.read ? '&#128308; ' : ''}${n.title}</div>
      <div style="font-size:13px;color:var(--text-primary);margin:4px 0">${n.content}</div>
      <div class="notif-meta">
        <span>${n.sender}（${n.senderRole}）</span>
        <span>${n.date}</span>
        <span class="tag ${n.priority === '紧急' ? 'tag-red' : n.priority === '重要' ? 'tag-orange' : 'tag-blue'}" style="font-size:11px">${n.priority}</span>
      </div>
    </div>
  `).join('');
}

function toggleNotificationPanel() {
  document.getElementById('notificationPanel').classList.toggle('open');
}

function readNotification(id) {
  const n = notifications.find(x => x.id === id);
  if (n) {
    n.read = true;
    const unread = notifications.filter(x => !x.read).length;
    document.getElementById('notifBadge').textContent = unread;
    document.getElementById('notifBadge').style.display = unread > 0 ? 'block' : 'none';
    renderNotifications();
  }
}

// ============ 模态框 ============
function openModal(title, bodyHtml, buttons) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFooter').innerHTML = buttons.map(b =>
    `<button class="btn ${b.class}" onclick="${b.action}">${b.text}</button>`
  ).join('');
  document.getElementById('modalOverlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

function closeModalOutside(event) {
  if (event.target === document.getElementById('modalOverlay')) {
    closeModal();
  }
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', function() {
  // 页面加载完成后显示登录页
  document.getElementById('loginPage').style.display = 'flex';
});

// 键盘事件
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeModal();
    document.getElementById('notificationPanel').classList.remove('open');
  }
  if (e.key === 'Enter' && document.getElementById('loginPage').style.display !== 'none') {
    handleLogin();
  }
});
