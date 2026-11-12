/**
 * 门户前端状态机测试：用最小 DOM/窗口桩在 vm 中运行真实的 portal.js，
 * 验证绑定、固定 origin、来源窗口、世代失效与迟到结果丢弃等安全语义。
 *
 * 运行：node tests/run_frontend_tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORTAL_ORIGIN = 'http://localhost:8080';
const VENDOR_ORIGIN = 'http://localhost:8081';
const ROGUE_ORIGIN = 'http://localhost:8082';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

function makeEl(id) {
  const listeners = {};
  const el = {
    id,
    children: [],
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    src: 'about:blank',
    classList: { add() {}, remove() {} },
    style: {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
    append(...kids) {
      for (const k of kids) this.children.push(k);
    },
    prepend(kid) {
      this.children.unshift(kid);
    },
    querySelector() {
      return makeEl(`${id}-q`);
    },
    remove() {},
  };
  return el;
}

function makeWindow() {
  const listeners = {};
  const posted = [];
  return {
    listeners,
    posted,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
    dispatchMessage(event) {
      for (const fn of listeners.message || []) fn(event);
    },
    open() {},
  };
}

function makeFrame() {
  const listeners = {};
  const frame = {
    src: 'about:blank',
    dataset: {},
    contentWindow: {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    },
  };
  return frame;
}

/** 构造一个完整沙箱并加载真实 portal.js；返回操控句柄。 */
async function boot() {
  const frame = makeFrame();
  const win = makeWindow();
  const els = {};
  const byId = new Map();
  for (const id of [
    'portal-origin', 'vendor-origin', 'device-select', 'delay-input', 'vendor-frame',
    'frame-status', 'btn-reload', 'btn-load-rogue', 'btn-open-probe', 'requests', 'event-log',
  ]) {
    const el = id === 'vendor-frame' ? frame : makeEl(id);
    els[id] = el;
    byId.set(id, el);
  }
  els['device-select'].value = 'dev-gw-01';
  els['delay-input'].value = '0';

  const fetchLog = [];
  const pendingApproves = [];
  const pendingLogs = [];
  let tokenSeq = 0;

  async function fakeFetch(url, opts) {
    fetchLog.push({ url, opts });
    if (url.endsWith('/api/config')) {
      return {
        ok: true,
        json: async () => ({
          role: 'portal', selfOrigin: PORTAL_ORIGIN,
          portalOrigin: PORTAL_ORIGIN, vendorOrigin: VENDOR_ORIGIN,
          rogueOrigin: ROGUE_ORIGIN,
        }),
      };
    }
    if (url.endsWith('/api/devices')) {
      return {
        ok: true,
        json: async () => ({
          devices: [
            { id: 'dev-gw-01', name: '网关 GW-01', model: 'X100' },
            { id: 'dev-pump-02', name: '泵房 PUMP-02', model: 'P2000' },
          ],
        }),
      };
    }
    if (url.endsWith('/api/approve')) {
      return new Promise((resolve) => {
        pendingApproves.push({
          resolve,
          token: `tok-${++tokenSeq}`,
        });
      });
    }
    if (url.includes('/api/logs')) {
      return new Promise((resolve, reject) => {
        pendingLogs.push({ url, resolve, reject });
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }

  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => byId.get(id),
      createElement: () => makeEl('created'),
    },
    fetch: fakeFetch,
    setInterval: () => 0, // 关闭待确认兜底定时器，由测试显式控制节奏
    clearInterval: () => {},
    setTimeout: (fn) => {
      try { fn(); } catch { /* 40s 提示类计时器不影响状态机 */ }
      return 0;
    },
    clearTimeout: () => {},
    console,
    crypto: { randomUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}` },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const code = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'static', 'portal', 'portal.js'),
    'utf8',
  );
  vm.runInContext(code, sandbox, { filename: 'portal.js' });

  // init() 内含多层 await（config→json→devices→json），用若干个 macrotask
  // 周期确保全部微任务链排空。
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }

  const state = vm.runInContext('state', sandbox);

  function hello(sourceWindow, origin, docId, href = '/') {
    win.dispatchMessage({
      origin,
      source: sourceWindow,
      data: { type: 'vendor:hello', docId, href },
    });
  }

  function request(sourceWindow, origin, docId, requestId) {
    win.dispatchMessage({
      origin,
      source: sourceWindow,
      data: { type: 'log:request', requestId, docId },
    });
  }

  return {
    sandbox, state, win, frame, els,
    fetchLog, pendingApproves, pendingLogs, hello, request,
    flush: () => new Promise((r) => setImmediate(r)),
  };
}

function makeSource() {
  const posted = [];
  return { posted, postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); } };
}

async function main() {
  console.log('[A] 固定 origin 与来源窗口校验');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-1');
    check('合法厂商文档完成绑定', h.state.binding?.docId === 'doc-1' && h.state.epoch === 1);

    // A1 未获准 origin
    const rogueSource = makeSource();
    h.request(rogueSource, ROGUE_ORIGIN, 'doc-evil', 'req-rogue');
    check('未获准 origin 的申请被拒（不建申请单）', h.state.requests.size === 0);
    check('拒绝原因指向白名单', rogueSource.posted.some((p) => p.message.reason?.includes('白名单')));

    // A2 同源旁窗（portal origin）——先死在 origin 白名单
    const portalSource = makeSource();
    h.request(portalSource, PORTAL_ORIGIN, 'doc-portal', 'req-portal');
    check('门户同源旁窗被 origin 白名单拒绝', h.state.requests.size === 0);

    // A3 同厂商 origin 但来源窗口不是 iframe
    const sideSource = makeSource();
    h.request(sideSource, VENDOR_ORIGIN, 'doc-1', 'req-sidewin');
    check('同 origin 旁窗被来源窗口校验拒绝', h.state.requests.size === 0);
    check('拒绝原因指向来源窗口', sideSource.posted.some((p) => p.message.reason?.includes('来源窗口')));

    // A4 iframe 窗口但伪造 docId
    h.request(frameWin, VENDOR_ORIGIN, 'doc-fake', 'req-fakedoc');
    check('文档标识不符的申请被拒', h.state.requests.size === 0);

    // A5 合法申请建单
    h.request(frameWin, VENDOR_ORIGIN, 'doc-1', 'req-ok');
    check('合法申请进入队列且为 pending', h.state.requests.get('req-ok')?.status === 'pending');
  }

  console.log('[B] 批准-取数-只回传发起文档，且仅一次');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-1');
    h.request(frameWin, VENDOR_ORIGIN, 'doc-1', 'req-1');

    // 触发批准（找到卡片按钮回调）
    const req = h.state.requests.get('req-1');
    vm.runInContext('approveRequest("req-1")', h.sandbox);
    await h.flush();
    check('批准后调用 /api/approve', h.pendingApproves.length === 1);

    // 批准接口返回令牌
    h.pendingApproves.shift().resolve({
      ok: true,
      json: async () => ({ token: 'tok-real' }),
    });
    await h.flush();
    check('拿到令牌后调用 /api/logs', h.pendingLogs.length === 1);
    check('取数 URL 带一次性令牌与设备', h.pendingLogs[0].url.includes('token=tok-real') &&
      h.pendingLogs[0].url.includes('deviceId=dev-gw-01'));

    // 取数返回
    h.pendingLogs.shift().resolve({
      ok: true,
      json: async () => ({ deviceId: 'dev-gw-01', count: 20, entries: ['line1', 'line2'] }),
    });
    await h.flush();
    check('申请状态变为 delivered', req.status === 'delivered');
    const delivery = frameWin.posted.find((p) => p.message.type === 'log:result' && p.message.ok);
    check('结果只 postMessage 给绑定窗口且 targetOrigin 固定',
      Boolean(delivery) && delivery.targetOrigin === VENDOR_ORIGIN);
    check('回传 20 条结果', delivery.message.data.count === 20);

    // 再次尝试批准同一申请（按钮虽已消失，但直接调函数也要被拦）
    const before = h.state.epoch;
    vm.runInContext('approveRequest("req-1")', h.sandbox);
    check('重复批准被拦截、世代不变', h.state.epoch === before);
  }

  console.log('[C] 取数期间刷新/导航：迟到结果不得交给新文档');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-old');
    h.request(frameWin, VENDOR_ORIGIN, 'doc-old', 'req-late');
    const oldReq = h.state.requests.get('req-late');

    vm.runInContext('approveRequest("req-late")', h.sandbox);
    await h.flush();
    h.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-x' }) });
    await h.flush();
    check('取数在途', h.pendingLogs.length === 1 && oldReq.status === 'approved');

    // iframe 重新加载：新 docId 握手 → 世代推进、旧申请作废
    const frameWin2 = makeSource();
    h.frame.contentWindow = frameWin2;
    h.frame.dispatch('load', {});
    h.hello(frameWin2, VENDOR_ORIGIN, 'doc-new');
    check('新文档握手后世代推进', h.state.epoch === 2);
    check('旧申请被标记 invalidated', oldReq.status === 'invalidated');
    check('当前绑定是新文档', h.state.binding.docId === 'doc-new');

    // 迟到的取数结果返回：新文档窗口在此期间不应收到任何 log:result
    const postedBefore = frameWin2.posted.filter((p) => p.message.type === 'log:result').length;
    h.pendingLogs.shift().resolve({
      ok: true,
      json: async () => ({ deviceId: 'dev-gw-01', count: 20, entries: ['stale'] }),
    });
    await h.flush();
    const postedAfter = frameWin2.posted.filter((p) => p.message.type === 'log:result').length;
    check('迟到结果被丢弃，新文档收不到 log:result', postedAfter === postedBefore);
  }

  console.log('[D] 批准等待期间导航：令牌不发给任何文档并被销毁');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-a');
    h.request(frameWin, VENDOR_ORIGIN, 'doc-a', 'req-nav');
    const req = h.state.requests.get('req-nav');

    vm.runInContext('approveRequest("req-nav")', h.sandbox);
    await h.flush();
    check('批准请求在途', h.pendingApproves.length === 1);

    // 导航换代
    const frameWin2 = makeSource();
    h.frame.contentWindow = frameWin2;
    h.hello(frameWin2, VENDOR_ORIGIN, 'doc-b');
    check('导航后世代推进、申请失效', h.state.epoch === 2 && req.status === 'invalidated');

    // 批准接口迟到返回令牌
    h.pendingApproves.shift().resolve({ ok: true, json: async () => ({ token: 'tok-late' }) });
    await h.flush();
    const burnCall = h.fetchLog.find((f) => f.url.includes('/api/logs') && f.url.includes('tok-late'));
    check('迟到令牌被主动调 /api/logs 销毁', Boolean(burnCall));
    check('没有任何窗口收到令牌', !h.win.posted.some((p) => JSON.stringify(p).includes('tok-late')));
  }

  console.log('[E] 切换设备：旧设备在途申请失效，绑定文档保留');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-1');
    h.request(frameWin, VENDOR_ORIGIN, 'doc-1', 'req-dev');
    const req = h.state.requests.get('req-dev');
    const bindingDoc = h.state.binding.docId;

    h.els['device-select'].value = 'dev-pump-02';
    h.els['device-select'].dispatch('change', {});
    check('切设备推进世代但保留文档绑定', h.state.epoch === 2 && h.state.binding?.docId === bindingDoc);
    check('旧设备申请失效', req.status === 'invalidated');
    check('当前设备已更新', h.state.currentDeviceId === 'dev-pump-02');

    // 新设备的新申请可以正常建单
    h.request(frameWin, VENDOR_ORIGIN, 'doc-1', 'req-dev2');
    const req2 = h.state.requests.get('req-dev2');
    check('新设备申请绑定到新世代与新设备', req2.epoch === 2 && req2.deviceId === 'dev-pump-02');
  }

  console.log('[F] 待确认窗口期：load 后未握手，申请被拒且定时作废');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-1');
    h.frame.dispatch('load', {});
    check('load 后绑定进入待确认', h.state.binding.unconfirmed === true);

    h.request(frameWin, VENDOR_ORIGIN, 'doc-1', 'req-unconf');
    check('待确认期间的申请被拒', !h.state.requests.has('req-unconf'));

    // 模拟兜底定时器触发（生产代码里是 setInterval 回调）
    const before = h.state.epoch;
    vm.runInContext(
      'if (state.binding && state.binding.unconfirmed) { invalidateRequests("测试兜底：", true); }',
      h.sandbox,
    );
    check('兜底后绑定清空、世代推进', h.state.binding === null && h.state.epoch === before + 1);

    // 未获准站点 load 后永不握手的场景：消息直接被 origin 拒绝
    h.frame.contentWindow = makeSource();
    h.request(makeSource(), ROGUE_ORIGIN, 'rogue-doc', 'req-rogue2');
    check('未获准站点消息被固定 origin 拒绝', h.state.requests.size === 0);
  }

  console.log('[G] 握手时序竞争：hello 早于 load 事件也不会误杀绑定');
  {
    const h = await boot();
    const frameWin = makeSource();
    h.frame.contentWindow = frameWin;
    // 重新加载场景：先到 hello（新 docId），后到 load
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-2');
    check('新文档握手即完成绑定', h.state.binding?.docId === 'doc-2');
    h.frame.dispatch('load', {});
    check('随后的 load 仅置待确认，不推进世代', h.state.epoch === 1 && h.state.binding.unconfirmed === true);
    // hello 重发（厂商页 150ms 重发机制）→ 同 docId 补确认
    h.hello(frameWin, VENDOR_ORIGIN, 'doc-2');
    check('同 docId 补确认恢复绑定、世代不变', h.state.binding.unconfirmed === false && h.state.epoch === 1);
  }

  console.log('\n结果：%d 通过 / %d 失败', pass, fail);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
