'use strict';

// 门户主文档：所有安全决策都在这里完成。
// 厂商页面只能通过 postMessage 提申请，永远接触不到批准令牌。

const els = {
  portalOrigin: document.getElementById('portal-origin'),
  vendorOrigin: document.getElementById('vendor-origin'),
  deviceSelect: document.getElementById('device-select'),
  delayInput: document.getElementById('delay-input'),
  frame: document.getElementById('vendor-frame'),
  frameStatus: document.getElementById('frame-status'),
  btnReload: document.getElementById('btn-reload'),
  btnLoadRogue: document.getElementById('btn-load-rogue'),
  btnOpenProbe: document.getElementById('btn-open-probe'),
  requests: document.getElementById('requests'),
  eventLog: document.getElementById('event-log'),
};

/** @type {{role:string,selfOrigin:string,portalOrigin:string,vendorOrigin:string,rogueOrigin:string}} */
const cfg = { role: '', selfOrigin: '', portalOrigin: '', vendorOrigin: '', rogueOrigin: '' };

const state = {
  devices: [],
  currentDeviceId: '',
  // 文档世代号：iframe 每次加载/跳转、切换设备都会 +1，旧世代的一切申请立即失效。
  epoch: 0,
  // 当前唯一绑定的 iframe 文档：{ docId, origin, sourceWindow, href, unconfirmed }
  binding: null,
  /** @type {Map<string, any>} */
  requests: new Map(),
};

const STATUS_TEXT = {
  pending: '等待批准',
  approving: '批准/取数中',
  approved: '已批准，取数中',
  delivered: '已交付厂商文档',
  denied: '已拒绝',
  failed: '取数失败',
  invalidated: '已失效（文档/设备换代）',
};

function shortId(id) {
  return String(id).slice(0, 8);
}

function nowText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function logEvent(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${nowText()}] ${message}`;
  els.eventLog.prepend(line);
  while (els.eventLog.children.length > 200) {
    els.eventLog.lastElementChild.remove();
  }
}

function invalidateRequests(reason, resetBinding) {
  // 文档换代（加载/导航/刷新）：推进世代并清空绑定。
  // 切换设备：推进世代但保留当前文档绑定（同一文档继续服务新设备）。
  state.epoch += 1;
  if (resetBinding) {
    state.binding = null;
    els.frameStatus.textContent = 'iframe 文档未绑定（等待厂商页 hello 握手）。';
  }
  let killed = 0;
  for (const req of state.requests.values()) {
    if (req.status === 'pending' || req.status === 'approving' || req.status === 'approved') {
      req.status = 'invalidated';
      killed += 1;
    }
  }
  renderRequests();
  logEvent(`${reason} 世代推进到 ${state.epoch}，${killed} 笔在途申请作废。`, 'warn');
}

function isCurrentBinding(req) {
  return (
    state.binding !== null &&
    !state.binding.unconfirmed &&
    req.epoch === state.epoch &&
    req.origin === state.binding.origin &&
    req.docId === state.binding.docId &&
    req.sourceWindow === state.binding.sourceWindow
  );
}

function postToBinding(message) {
  if (!state.binding) return;
  state.binding.sourceWindow.postMessage(message, state.binding.origin);
}

async function burnToken(token, deviceId) {
  // 文档换代导致令牌不再需要时，主动把一次性令牌用掉，避免遗留可用凭证。
  try {
    await fetch(`/api/logs?deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}&delay=0`);
  } catch {
    /* 忽略：销毁动作不影响主流程 */
  }
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;

  // 校验 1：固定 origin 白名单。同源旁窗（门户自己的源）也过不了这一关。
  if (event.origin !== cfg.vendorOrigin) {
    logEvent(
      `拒绝来自非白名单源的消息：origin=${event.origin}，类型=${data.type ?? '未知'}（固定 origin 校验失败）`,
      'error',
    );
    if (data.type === 'log:request' || data.type === 'vendor:hello') {
      event.source?.postMessage(
        { type: 'log:denied', requestId: data.requestId ?? null, reason: 'origin 不在门户白名单中' },
        event.origin,
      );
    }
    return;
  }

  // 校验 2：来源窗口必须是当前 iframe，而不是同源/同 origin 的其他窗口（旁窗、弹窗）。
  if (event.source !== els.frame.contentWindow) {
    logEvent(
      `拒绝冒充消息：origin 合法（${event.origin}），但来源窗口不是当前绑定的 iframe（疑似旁窗/弹窗冒充）。`,
      'error',
    );
    if (data.type === 'log:request') {
      event.source?.postMessage(
        { type: 'log:denied', requestId: data.requestId, reason: '来源窗口不是已绑定的厂商 iframe' },
        event.origin,
      );
    }
    return;
  }

  if (data.type === 'vendor:hello') {
    // 每次加载/跳转后的新文档都有新的 docId。与当前绑定不同即视为文档换代：
    // 旧世代的全部在途申请立即作废，然后才绑定新文档。
    if (!state.binding || state.binding.docId !== String(data.docId)) {
      invalidateRequests(
        state.binding ? `检测到 iframe 新文档 ${String(data.docId).slice(0, 8)}（旧文档已被替换）：` : 'iframe 新文档握手：',
        true,
      );
    } else if (state.binding.unconfirmed) {
      // load 事件先到、握手后到的补确认场景，不再重复推进世代。
      logEvent(`文档 ${shortId(data.docId)} 握手补确认，绑定恢复有效。`, 'ok');
    }
    state.binding = {
      docId: String(data.docId),
      origin: event.origin,
      sourceWindow: event.source,
      href: String(data.href ?? ''),
      unconfirmed: false,
    };
    els.frameStatus.textContent =
      `已绑定文档 ${shortId(state.binding.docId)}…，实际 iframe 来源：${event.origin} ${state.binding.href}`;
    logEvent(`厂商文档握手绑定：docId=${shortId(data.docId)}，origin=${event.origin}，世代=${state.epoch}。`, 'ok');
    postToBinding({ type: 'portal:hello-ack', portalOrigin: cfg.portalOrigin });
    postToBinding({
      type: 'state',
      deviceId: state.currentDeviceId,
      deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? '',
      delay: Number(els.delayInput.value) || 0,
    });
    return;
  }

  if (data.type === 'log:request') {
    if (!state.binding || state.binding.unconfirmed || data.docId !== state.binding.docId) {
      logEvent('拒绝申请：文档未完成绑定/处于待确认状态，或文档标识与当前绑定不一致。', 'error');
      event.source.postMessage(
        { type: 'log:denied', requestId: data.requestId, reason: '文档未绑定或标识不符' },
        event.origin,
      );
      return;
    }
    const req = {
      requestId: String(data.requestId),
      docId: state.binding.docId,
      origin: event.origin,
      sourceWindow: event.source,
      epoch: state.epoch,
      deviceId: state.currentDeviceId,
      deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? state.currentDeviceId,
      createdAt: nowText(),
      status: 'pending',
    };
    state.requests.set(req.requestId, req);
    logEvent(
      `收到日志申请 ${shortId(req.requestId)}：设备=${req.deviceId}，来源文档=${shortId(req.docId)}，等待人工批准。`,
    );
    renderRequests();
    return;
  }
});

async function approveRequest(requestId) {
  const req = state.requests.get(requestId);
  if (!req || req.status !== 'pending' || !isCurrentBinding(req)) {
    logEvent('批准动作被拦截：申请不存在、已处理或已失效（每笔申请只能批准一次）。', 'warn');
    renderRequests();
    return;
  }
  req.status = 'approving';
  renderRequests();

  let token = null;
  try {
    const resp = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: req.deviceId }),
    });
    if (!resp.ok) throw new Error(`/api/approve -> HTTP ${resp.status}`);
    token = (await resp.json()).token;
  } catch (err) {
    req.status = 'failed';
    renderRequests();
    logEvent(`批准接口调用失败：${err.message}`, 'error');
    return;
  }

  // await 之后必须重新校验：等待期间刷新/导航/切换设备都会让世代推进。
  if (!isCurrentBinding(req)) {
    logEvent('批准令牌签发回来时文档/设备已换代，令牌不发给任何文档并立即作废。', 'warn');
    req.status = 'invalidated';
    renderRequests();
    await burnToken(token, req.deviceId);
    return;
  }

  req.status = 'approved';
  renderRequests();
  const delay = Number(els.delayInput.value) || 0;
  const url =
    `/api/logs?deviceId=${encodeURIComponent(req.deviceId)}` +
    `&token=${encodeURIComponent(token)}&delay=${encodeURIComponent(delay)}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`/api/logs -> HTTP ${resp.status}`);
    const payload = await resp.json();

    // 迟到结果判定：取数期间文档/设备一旦换代，结果绝不能交给新文档。
    if (!isCurrentBinding(req)) {
      logEvent(
        `取数结果迟到：申请 ${shortId(requestId)} 对应的文档已不存在，结果丢弃，新文档不会收到旧数据。`,
        'warn',
      );
      req.status = 'invalidated';
      renderRequests();
      return;
    }
    postToBinding({ type: 'log:result', requestId, ok: true, data: payload });
    req.status = 'delivered';
    logEvent(
      `申请 ${shortId(requestId)} 已交付：${payload.count} 条脱敏日志仅回传给发起申请的文档 ${shortId(req.docId)}。`,
      'ok',
    );
  } catch (err) {
    if (!isCurrentBinding(req)) {
      logEvent(`取数失败返回时文档已换代，错误信息同样丢弃：${err.message}`, 'warn');
      req.status = 'invalidated';
    } else {
      req.status = 'failed';
      postToBinding({ type: 'log:result', requestId, ok: false, error: err.message });
      logEvent(`取数失败：${err.message}`, 'error');
    }
  }
  renderRequests();
}

function denyRequest(requestId) {
  const req = state.requests.get(requestId);
  if (!req || req.status !== 'pending') return;
  req.status = 'denied';
  if (isCurrentBinding(req)) {
    postToBinding({ type: 'log:denied', requestId, reason: '值班员拒绝了本次申请' });
  }
  logEvent(`申请 ${shortId(requestId)} 已被人工拒绝。`, 'warn');
  renderRequests();
}

function renderRequests() {
  const list = [...state.requests.values()].reverse();
  if (list.length === 0) {
    els.requests.innerHTML = '<p class="hint">暂无申请。</p>';
    return;
  }
  els.requests.innerHTML = '';
  for (const req of list) {
    const card = document.createElement('div');
    card.className = `req-card req-${req.status}`;
    const actionable = req.status === 'pending' && isCurrentBinding(req);
    card.innerHTML = `
      <div class="req-head">
        <span>申请 ${shortId(req.requestId)}</span>
        <span class="req-status">${STATUS_TEXT[req.status] ?? req.status}</span>
      </div>
      <div class="req-meta">设备：${req.deviceName}（${req.deviceId}）</div>
      <div class="req-meta">来源：${req.origin} · 文档 ${shortId(req.docId)} · 世代 ${req.epoch}</div>
      <div class="req-meta">发起时间：${req.createdAt}</div>
      <div class="req-actions"></div>`;
    if (actionable) {
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'primary';
      okBtn.textContent = '批准本次申请';
      okBtn.addEventListener('click', () => approveRequest(req.requestId));
      const noBtn = document.createElement('button');
      noBtn.type = 'button';
      noBtn.className = 'warn';
      noBtn.textContent = '拒绝';
      noBtn.addEventListener('click', () => denyRequest(req.requestId));
      card.querySelector('.req-actions').append(okBtn, noBtn);
    }
    els.requests.append(card);
  }
}

// ---- 控件行为 ----

els.frame.addEventListener('load', () => {
  // 刷新、导航（含跳到未获准站点）都会触发 load。
  // 新文档必须重新 hello 握手；在它重新确认前，旧绑定只标记为“待确认”，
  // 由下方兜底定时器升级为作废，防止跳转到不发握手的站点后旧授权继续可用。
  if (state.binding && !state.binding.unconfirmed) {
    state.binding.unconfirmed = true;
    logEvent('iframe 发生加载/跳转：当前绑定转为待确认，等待新文档重新握手。', 'warn');
  }
});

// 兜底：待确认状态持续 1 秒（已足够覆盖 load 与 hello 的任何先后顺序），
// 说明新文档不是获准厂商文档（如未获准站点/导航到非诊断页），正式作废旧世代。
setInterval(() => {
  if (state.binding?.unconfirmed) {
    invalidateRequests('iframe 新文档未在时限内完成握手（可能为未获准站点/跳转）：', true);
  }
}, 1000);

els.deviceSelect.addEventListener('change', () => {
  // 切换设备：同一文档继续存在，但旧设备的在途申请一律失效（迟到结果不得交给新设备上下文）。
  invalidateRequests('切换设备：', false);
  state.currentDeviceId = els.deviceSelect.value;
  logEvent(`当前设备切换为 ${state.currentDeviceId}。`);
  if (state.binding && !state.binding.unconfirmed) {
    postToBinding({
      type: 'state',
      deviceId: state.currentDeviceId,
      deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? '',
      delay: Number(els.delayInput.value) || 0,
    });
  }
});

els.delayInput.addEventListener('change', () => {
  const v = Math.max(0, Math.min(30, Number(els.delayInput.value) || 0));
  els.delayInput.value = v;
  if (state.binding && !state.binding.unconfirmed) {
    postToBinding({
      type: 'state',
      deviceId: state.currentDeviceId,
      deviceName: state.devices.find((d) => d.id === state.currentDeviceId)?.name ?? '',
      delay: v,
    });
  }
});

els.btnReload.addEventListener('click', () => {
  // 重新赋值 src 触发全新文档加载，load 事件负责推进世代。
  els.frame.src = `${cfg.vendorOrigin}/`;
});

els.btnLoadRogue.addEventListener('click', () => {
  els.frame.src = els.frame.dataset.rogueOrigin || 'http://localhost:8082/';
});

els.btnOpenProbe.addEventListener('click', () => {
  // 与门户同源的旁窗：origin 合法但不是 iframe，来源窗口校验会拒绝它。
  window.open('/probe.html', 'portal-probe', 'width=560,height=520');
});

// ---- 初始化 ----

async function init() {
  Object.assign(cfg, await fetch('/api/config').then((r) => r.json()));
  els.portalOrigin.textContent = cfg.selfOrigin;
  els.vendorOrigin.textContent = cfg.vendorOrigin;
  els.frame.dataset.rogueOrigin = cfg.rogueOrigin;

  const resp = await fetch('/api/devices');
  state.devices = (await resp.json()).devices;
  for (const d of state.devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name}（${d.id}）`;
    els.deviceSelect.append(opt);
  }
  state.currentDeviceId = state.devices[0]?.id ?? '';

  logEvent(`门户就绪，固定厂商白名单 origin：${cfg.vendorOrigin}。`);
  els.frame.src = `${cfg.vendorOrigin}/`;
}

init().catch((err) => logEvent(`初始化失败：${err.message}`, 'error'));
