// 走查截图生成器(walkthrough prep 工具,非产品代码)
// 驱动 Edge headless(经 CDP)按真实业务流程走一遍发放链:
// 登录→建单→审批→出库→移交→签收(本人/代签/拒代签/离线队列)→完成→审计链验证
// 用法: 先启动服务(cd server && npm start)并灌种子(node seed-drill.js),再 node shoot.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9223;
const BASE = 'http://localhost:8791';
const DIR = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const transcript = [];
function log(step, data) {
  transcript.push({ step, ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 400));
}

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Edge CDP 未就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, name), Buffer.from(r.data, 'base64'));
    console.log('  📷', name);
  }
}

// 在页面上下文里调 API(复用浏览器会话 cookie)
async function api(cdp, url, init = {}) {
  const full = { credentials: 'same-origin', ...init };
  const abs = url.startsWith('/') ? BASE + url : url;
  const expr = `fetch(${JSON.stringify(abs)}, ${JSON.stringify(full)}).then(r=>r.text().then(t=>({status:r.status,body:t})))`;
  const r = await cdp.eval(expr);
  let body; try { body = JSON.parse(r.body); } catch { body = r.body; }
  return { status: r.status, body };
}
const json = o => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

async function uiLogin(cdp, account) {
  await cdp.eval(`(()=>{document.getElementById('login-account').value='${account}';document.getElementById('login-password').value='Aa@123456';document.getElementById('btn-login').click();return 1})()`);
  await sleep(1000);
}
async function uiLogout(cdp) {
  await cdp.eval(`(()=>{var b=document.getElementById('btn-logout'); if(b){b.click(); return 1} return 0})()`);
  await sleep(500);
}

async function main() {
  const profileDir = path.join(require('node:os').tmpdir(), 'wt-edge-profile');
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=390,820', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    const target = await waitForTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    // 手机视口
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 2, mobile: true });

    // ---- 0. 健康检查 ----
    await cdp.send('Page.navigate', { url: `${BASE}/mobile-sign.html` });
    await sleep(900);
    const hz = await api(cdp, '/healthz');
    log('healthz', hz.body);

    // ---- 1. 登录页 ----
    await cdp.shot('01-login.png');

    // ---- 2. 库管员登录(真实 UI 输入)→ 空待办 ----
    await uiLogin(cdp, 'DRILL-KEEPER');
    await cdp.shot('02-pending-empty.png');

    // ---- 3. 工号映射 ----
    const ids = {};
    for (const acc of ['DRILL-KEEPER', 'DRILL-APPROVER', 'DRILL-LEADER', 'DRILL-WORKER']) {
      const r = await api(cdp, '/auth/login', json({ account: acc, password: 'Aa@123456' }));
      ids[acc] = r.body.employee_id;
    }
    log('accounts', ids);
    const K = ids['DRILL-KEEPER'], AP = ids['DRILL-APPROVER'], L = ids['DRILL-LEADER'], W = ids['DRILL-WORKER'];

    // ---- 4. 建单 A(班组长 + 一线各 1 包口罩) ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    const keyA = await cdp.eval('crypto.randomUUID()');
    const createA = await api(cdp, '/distribution/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyA },
      body: JSON.stringify({ applicant_id: L, total_people: 2, depot_id: 'DP-001',
        items: [{ item_id: 'INV-001', per_person_qty: 1 }],
        recipients: [{ employee_id: L, units: 'A班', people_count: 1 }, { employee_id: W, units: 'B班', people_count: 1 }] })
    });
    const idA = createA.body.id;
    log('create-A', { status: createA.status, id: idA, status_text: createA.body.status });

    // ---- 5. 审批 ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-APPROVER', password: 'Aa@123456' }));
    log('approve-A', await api(cdp, `/distribution/${idA}/approve`, { method: 'POST' }));

    // ---- 6. 出库 + 双人移交 ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    log('issue-A', await api(cdp, `/distribution/${idA}/issue`, { method: 'POST' }));
    log('transfer-A1', await api(cdp, `/distribution/${idA}/transfer`, json({ recipient_id: L })));
    log('transfer-A2', await api(cdp, `/distribution/${idA}/transfer`, json({ recipient_id: W })));

    // ---- 7. 班组长登录看到待签收 ----
    await uiLogout(cdp);
    await uiLogin(cdp, 'DRILL-LEADER');
    await cdp.shot('03-pending-leader.png');

    // ---- 8. 班组长本人签收(真实按钮点击) ----
    const click = await cdp.eval(`(()=>{var cs=document.querySelectorAll('#pending-list .card');
      for(var i=0;i<cs.length;i++){if(cs[i].querySelector('.title').textContent.indexOf('${idA}')>=0){
      var b=cs[i].querySelector('.btn-receive'); if(b&&!b.disabled){b.click();return 'clicked'} return 'disabled|'+b.textContent}}
      return 'not_found|'+cs.length})()`);
    await sleep(1200);
    await cdp.shot('04-sign-success.png');
    log('leader-self-sign', { click });

    // ---- 9. 越权代签被拒(库管员不在白名单) ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    log('proxy-denied-keeper', await api(cdp, `/distribution/${idA}/receive`, json({ recipient_id: W })));

    // ---- 10. 白名单代签成功(班组长代一线) ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-LEADER', password: 'Aa@123456' }));
    log('proxy-ok-leader', await api(cdp, `/distribution/${idA}/receive`, json({ recipient_id: W })));

    // ---- 11. 建单 B(一线 1 瓶消毒液)→ 全链 ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    const keyB = await cdp.eval('crypto.randomUUID()');
    const createB = await api(cdp, '/distribution/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyB },
      body: JSON.stringify({ applicant_id: W, total_people: 1, depot_id: 'DP-001',
        items: [{ item_id: 'INV-002', per_person_qty: 1 }],
        recipients: [{ employee_id: W, units: 'B班', people_count: 1 }] })
    });
    const idB = createB.body.id;
    log('create-B', { status: createB.status, id: idB, status_text: createB.body.status });
    await api(cdp, '/auth/login', json({ account: 'DRILL-APPROVER', password: 'Aa@123456' }));
    log('approve-B', await api(cdp, `/distribution/${idB}/approve`, { method: 'POST' }));
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    log('issue-B', await api(cdp, `/distribution/${idB}/issue`, { method: 'POST' }));
    log('transfer-B', await api(cdp, `/distribution/${idB}/transfer`, json({ recipient_id: W })));

    // ---- 12. 一线登录看到待签收 ----
    await uiLogout(cdp);
    await uiLogin(cdp, 'DRILL-WORKER');
    await cdp.shot('05-pending-worker.png');

    // ---- 13. 断网 → 签收入队 ----
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await sleep(400);
    const clickB = await cdp.eval(`(()=>{var cs=document.querySelectorAll('#pending-list .card');
      for(var i=0;i<cs.length;i++){if(cs[i].querySelector('.title').textContent.indexOf('${idB}')>=0){
      var b=cs[i].querySelector('.btn-receive'); if(b&&!b.disabled){b.click();return 'clicked'} return 'disabled|'+b.textContent}}
      return 'not_found|'+cs.length})()`);
    await sleep(900);
    await cdp.shot('06-offline-queue.png');
    log('offline-enqueue', { click: clickB });

    // ---- 14. 恢复网络 → 自动重放 ----
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(300);
    await cdp.eval(`window.dispatchEvent(new Event('online'))`);
    await sleep(2200);
    await cdp.shot('07-replay-done.png');

    // ---- 15. 台台账推完 ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    for (const [tag, id] of [['A', idA], ['B', idB]]) {
      for (const step of [2, 3, 4]) {
        const r = await api(cdp, `/distribution/${id}/advance`, json({ step }));
        if (step === 4) log(`advance-${tag}-done`, { status: r.status, status_text: r.body.status || r.body.error });
      }
    }

    // ---- 16. 审计链 ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-APPROVER', password: 'Aa@123456' }));
    log('audit-verify-all', await api(cdp, '/audit/verify-all'));
    log('audit-chain-A', await api(cdp, `/audit/chain?ref_type=distribution&ref_id=${idA}`));

    // ---- 17. 报表(库管员有库存查看权) ----
    await api(cdp, '/auth/login', json({ account: 'DRILL-KEEPER', password: 'Aa@123456' }));
    log('stock-movements', await api(cdp, '/reports/stock-movements?limit=10'));
    log('low-stock', await api(cdp, '/reports/low-stock'));

    // ---- 18. 策略面板(桌面视口) ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `${BASE}/config.html` });
    await sleep(800);
    await cdp.eval(`(()=>{document.getElementById('acct').value='DRILL-APPROVER';document.getElementById('pwd').value='Aa@123456';document.getElementById('login').click();return 1})()`);
    await sleep(1000);
    await cdp.shot('08-config-panel.png');

    fs.writeFileSync(path.join(DIR, 'flow-transcript.json'), JSON.stringify(transcript, null, 2));
    console.log('\n✅ 完成,transcript 已写 flow-transcript.json');
  } finally {
    child.kill();
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
