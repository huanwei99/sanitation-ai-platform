// shoot-console.js — 验证演练控制台(dill-console.html)端到端可用性(走查准备工具)
// 每一步都通过页面的真实按钮/表单完成,响应控制台的输出被写入 transcript。
// 用法: 服务在 :8791 跑着 + 种子已灌 → node docs/walkthrough/shoot-console.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9224;
const BASE = 'http://localhost:8791';
const DIR = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const transcript = [];
function log(step, data) {
  transcript.push({ step, ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 500));
}

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) return page;
    } catch {}
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

async function main() {
  const profileDir = path.join(require('node:os').tmpdir(), 'wt-console-profile');
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--window-size=1400,950', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    const target = await waitForTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Network.clearBrowserCookies');

    // 登录页
    await cdp.send('Page.navigate', { url: `${BASE}/drill-console.html` });
    await sleep(1000);
    await cdp.shot('09-console-login.png');

    // 登录(真实表单)
    await cdp.eval(`(()=>{document.getElementById('login-account').value='DRILL-KEEPER';
      document.getElementById('login-password').value='Aa@123456';
      document.getElementById('btn-login').click();return 1})()`);
    await sleep(1200);
    const who = await cdp.eval(`document.getElementById('user-info').textContent`);
    log('login', { user: who });
    await cdp.shot('10-console-main.png');

    // 填表并创建(申请人=班组长,接收人=班组长+一线)
    await cdp.eval(`(()=>{document.getElementById('f-applicant').value='9003';
      var cbs=document.querySelectorAll('#f-recipients input');
      cbs.forEach(function(c){c.checked=(c.value==='9003'||c.value==='9004')});
      return cbs.length})()`);
    await cdp.eval(`document.getElementById('btn-create').click()`);
    await sleep(1000);
    const docId = await cdp.eval(`document.getElementById('doc-id').value`);
    const docState = await cdp.eval(`document.getElementById('doc-state').textContent`);
    const createLog = await cdp.eval(`document.getElementById('log').textContent.slice(0, 260)`);
    log('create', { docId, docState, consoleHead: createLog });
    await cdp.shot('11-console-created.png');

    // 切换审批人(角色条按钮)
    await cdp.eval(`(()=>{var bs=document.querySelectorAll('.role-btn');
      for(var b of bs){if(b.textContent.indexOf('APPROVER')>=0){b.click();return 'clicked'}}return 'not_found'})()`);
    await sleep(1000);
    await cdp.eval(`document.getElementById('btn-approve').click()`);
    await sleep(800);
    log('approve', { state: await cdp.eval(`document.getElementById('doc-state').textContent`) });

    // 切回库管员 → 出库 + 移交
    await cdp.eval(`(()=>{var bs=document.querySelectorAll('.role-btn');
      for(var b of bs){if(b.textContent.indexOf('KEEPER')>=0){b.click();return 'clicked'}}return 'not_found'})()`);
    await sleep(900);
    await cdp.eval(`document.getElementById('btn-issue').click()`);
    await sleep(900);
    log('issue', { state: await cdp.eval(`document.getElementById('doc-state').textContent`) });
    const t1 = await cdp.eval(`(()=>{var bs=document.querySelectorAll('#transfer-list .btn:not([disabled])');
      if(bs.length){bs[0].click();return bs.length}return 0})()`);
    await sleep(800);
    const t2 = await cdp.eval(`(()=>{var bs=document.querySelectorAll('#transfer-list .btn:not([disabled])');
      if(bs.length){bs[0].click();return bs.length}return 0})()`);
    await sleep(800);
    log('transfer', { remaining: t2 });
    await cdp.shot('12-console-transfer.png');

    // 班组长本人签收
    await cdp.eval(`(()=>{var bs=document.querySelectorAll('.role-btn');
      for(var b of bs){if(b.textContent.indexOf('LEADER')>=0){b.click();return 'clicked'}}return 'not_found'})()`);
    await sleep(900);
    const recv = await cdp.eval(`(()=>{var rows=document.querySelectorAll('#receive-list .recip-row');
      for(var r of rows){if(r.textContent.indexOf('9003')>=0){
        var b=r.querySelector('.btn-primary'); if(b&&!b.disabled){b.click();return 'clicked'} return 'disabled:'+b.textContent}}return 'no_row'})()`);
    await sleep(900);
    log('self-sign', { click: recv, state: await cdp.eval(`document.getElementById('doc-state').textContent`),
      consoleHead: await cdp.eval(`document.getElementById('log').textContent.slice(0, 200)`) });

    // 代签演示:班组长代一线签
    const proxy = await cdp.eval(`(()=>{var rows=document.querySelectorAll('#receive-list .recip-row');
      for(var r of rows){if(r.textContent.indexOf('9004')>=0){
        var b=r.querySelectorAll('button')[1]; if(b&&!b.disabled){b.click();return 'clicked'} return 'disabled'}}return 'no_row'})()`);
    await sleep(900);
    log('proxy-sign', { click: proxy, state: await cdp.eval(`document.getElementById('doc-state').textContent`),
      consoleHead: await cdp.eval(`document.getElementById('log').textContent.slice(0, 200)`) });

    // 推进 2→3→4
    await cdp.eval(`(()=>{var bs=document.querySelectorAll('.role-btn');
      for(var b of bs){if(b.textContent.indexOf('KEEPER')>=0){b.click();return 'clicked'}}return 'not_found'})()`);
    await sleep(900);
    for (const s of [2, 3, 4]) {
      await cdp.eval(`document.getElementById('btn-adv${s}').click()`);
      await sleep(800);
    }
    log('advance', { state: await cdp.eval(`document.getElementById('doc-state').textContent`) });

    // 审计
    await cdp.eval(`document.getElementById('btn-verify-one').click()`);
    await sleep(800);
    await cdp.eval(`document.getElementById('btn-verify-all').click()`);
    await sleep(800);
    const logText = await cdp.eval(`document.getElementById('log').textContent.slice(0, 600)`);
    log('audit', { consoleHead: logText.slice(0, 300) });
    await cdp.shot('13-console-audit.png');

    // 库存快照
    await cdp.eval(`document.getElementById('btn-inventory').click()`);
    await sleep(900);
    await cdp.shot('14-console-inventory.png');

    fs.writeFileSync(path.join(DIR, 'console-transcript.json'), JSON.stringify(transcript, null, 2));
    console.log('\n✅ 控制台验证完成');
  } finally {
    child.kill();
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
