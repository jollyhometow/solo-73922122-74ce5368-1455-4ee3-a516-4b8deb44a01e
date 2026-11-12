'use strict';

// 获准厂商诊断页。
// 边界：本页不知道、也拿不到门户的批准令牌；只能向父窗口发 postMessage 申请。
// 每次加载生成新的 docId 并重新握手，旧文档的申请在门户侧自动失效。

const cfg = { role: '', selfOrigin: '', portalOrigin: '', vendorOrigin: '' };
const docId = `vendor-doc-${crypto.randomUUID()}`;
const pending = new Map(); // requestId -> 超时计时器
let helloAcked = false;
let helloTimer = null;

const els = {
  selfOrigin: document.getElementById('self-origin'),
  portalOrigin: document.getElementById('portal-origin'),
  bindStatus: document.getElementById('bind-status'),
  deviceName: document.getElementById('device-name'),
  delayValue: document.getElementById('delay-value'),
  docId: document.getElementById('doc-id'),
  commLog: document.getElementById('comm-log'),
  logOutput: document.getElementById('log-output'),
  btnRequest: document.getElementById('btn-request'),
  btnDirectFetch: document.getElementById('btn-direct-fetch'),
  btnOpenProbe: document.getElementById('btn-open-probe'),
  btnNavigate: document.getElementById('btn-navigate'),
};

function say(msg, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  els.commLog.prepend(line);
}

function isEmbeddedInPortal() {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

function sendToPortal(message) {
  // 显式指定 targetOrigin，防止父窗口被导航到其他源后数据外泄。
  window.parent.postMessage(message, cfg.portalOrigin);
}

async function main() {
  Object.assign(cfg, await fetch('/api/config').then((r) => r.json()));
  els.selfOrigin.textContent = cfg.selfOrigin;
  els.portalOrigin.textContent = cfg.portalOrigin;
  els.docId.textContent = docId;

  if (!isEmbeddedInPortal()) {
    els.bindStatus.textContent = '当前为顶层窗口直接打开（未被门户嵌入），无法发起申请，仅可做接口直连演示。';
    say('未检测到父窗口，postMessage 申请通道不可用。', 'warn');
  } else {
    // 加载即握手：门户以 load 事件 + hello 消息重新绑定本文档。
    // 重发机制用于消除“父页面 load 事件与子文档 hello 的到达先后”这一时序竞争。
    const sendHello = () => {
      if (helloAcked) {
        clearInterval(helloTimer);
        helloTimer = null;
        return;
      }
      sendToPortal({ type: 'vendor:hello', docId, href: location.href });
    };
    sendHello();
    helloTimer = setInterval(sendHello, 150);
    els.bindStatus.textContent = '已向门户发送 hello，等待绑定确认…';
  }

  window.addEventListener('message', (event) => {
    // 固定 origin：只接受门户源的消息，未获准站点/其他源一律忽略。
    if (event.origin !== cfg.portalOrigin) {
      say(`忽略来源 ${event.origin} 的消息（非门户源）。`, 'warn');
      return;
    }
    if (event.source !== window.parent) {
      say('忽略非父窗口消息（可能是同 origin 旁窗冒充门户）。', 'warn');
      return;
    }
    const msg = event.data;
    if (typeof msg !== 'object' || msg === null) return;

    if (msg.type === 'portal:hello-ack') {
      helloAcked = true;
      if (helloTimer) {
        clearInterval(helloTimer);
        helloTimer = null;
      }
      els.bindStatus.textContent = '已与门户完成文档绑定，可以发起申请。';
      say('门户确认绑定。', 'ok');
    } else if (msg.type === 'state') {
      els.deviceName.textContent = `${msg.deviceName}（${msg.deviceId}）`;
      els.delayValue.textContent = String(msg.delay);
    } else if (msg.type === 'log:result') {
      // 纵深防御：新文档的 pending 表里没有旧 requestId，迟到结果直接丢弃不渲染。
      if (!pending.has(msg.requestId)) {
        say(`丢弃未知申请 ${String(msg.requestId).slice(0, 8)} 的迟到结果（不属于本文档）。`, 'warn');
        return;
      }
      const timer = pending.get(msg.requestId);
      clearTimeout(timer);
      pending.delete(msg.requestId);
      if (msg.ok) {
        els.logOutput.textContent = msg.data.entries.map((line) => line).join('\n');
        say(`申请 ${msg.requestId.slice(0, 8)} 成功：收到 ${msg.data.count} 条脱敏日志。`, 'ok');
      } else {
        els.logOutput.textContent = `取数失败：${msg.error}`;
        say(`申请 ${msg.requestId.slice(0, 8)} 失败：${msg.error}`, 'error');
      }
    } else if (msg.type === 'log:denied') {
      if (msg.requestId && pending.has(msg.requestId)) {
        clearTimeout(pending.get(msg.requestId));
        pending.delete(msg.requestId);
      }
      say(`申请 ${msg.requestId ? msg.requestId.slice(0, 8) : ''} 被门户拒绝：${msg.reason}`, 'error');
    }
  });

  els.btnRequest.addEventListener('click', () => {
    if (!isEmbeddedInPortal()) {
      say('未嵌入门户，无法申请。', 'error');
      return;
    }
    const requestId = crypto.randomUUID();
    sendToPortal({ type: 'log:request', requestId, docId });
    // 40 秒仅用于本页提示，真正的生命周期由门户世代控制。
    const timer = setTimeout(() => {
      pending.delete(requestId);
      say(`申请 ${requestId.slice(0, 8)} 长时间无回应（可能文档已换代，申请在门户侧作废）。`, 'warn');
    }, 40000);
    pending.set(requestId, timer);
    say(`已发出日志申请 ${requestId.slice(0, 8)}，等待值班员逐次人工批准。`);
  });

  els.btnDirectFetch.addEventListener('click', async () => {
    // 演示厂商无法绕过门户：既没有一次性令牌，跨源请求也没有 CORS 许可。
    const attempts = [
      `${cfg.portalOrigin}/api/logs?deviceId=dev-gw-01&token=guessed-token&delay=0`,
      `${cfg.portalOrigin}/api/approve`,
      `${cfg.portalOrigin}/api/devices`,
    ];
    for (const url of attempts) {
      try {
        const resp = await fetch(url, {
          method: url.includes('/approve') ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: url.includes('/approve') ? JSON.stringify({ deviceId: 'dev-gw-01' }) : undefined,
        });
        say(`直连 ${url} -> HTTP ${resp.status}（未获得数据）`, 'warn');
      } catch (err) {
        say(`直连 ${url} 被浏览器拦截：${err.message}`, 'error');
      }
    }
  });

  els.btnOpenProbe.addEventListener('click', () => {
    window.open('/probe.html', 'vendor-probe', 'width=560,height=520');
  });

  els.btnNavigate.addEventListener('click', () => {
    // 跳转到同站导航页后，门户 load 事件推进世代，本文档的在途申请全部失效；
    // 若取数结果迟到，门户不会把它交给新文档。
    location.href = '/navigated.html';
  });
}

main();
