'use strict';

// 厂商源旁窗：与 iframe 同 origin，但窗口不同。用来证明“只校验 origin 不够”。
const out = document.getElementById('out');

function say(msg, level = 'info') {
  const div = document.createElement('div');
  div.className = `log-line log-${level}`;
  div.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  out.prepend(div);
}

async function main() {
  const cfg = await fetch('/api/config').then((r) => r.json());

  window.addEventListener('message', (event) => {
    if (event.origin !== cfg.portalOrigin) return;
    const denied = typeof event.data?.type === 'string' && event.data.type.includes('denied');
    say(`收到门户回复：${JSON.stringify(event.data)}`, denied ? 'error' : 'info');
  });

  document.getElementById('btn-spoof-request').addEventListener('click', () => {
    if (!window.opener) return say('没有 opener，请从门户中的厂商页按钮打开本旁窗。', 'error');
    window.opener.parent.postMessage(
      { type: 'log:request', requestId: crypto.randomUUID(), docId: `spoof-${crypto.randomUUID()}` },
      cfg.portalOrigin,
    );
    say('已向门户发送冒充的 log:request（origin 合法，但来源窗口不是 iframe）。');
  });

  document.getElementById('btn-spoof-hello').addEventListener('click', () => {
    if (!window.opener) return say('没有 opener，请从门户中的厂商页按钮打开本旁窗。', 'error');
    window.opener.parent.postMessage(
      { type: 'vendor:hello', docId: `spoof-${crypto.randomUUID()}`, href: location.href },
      cfg.portalOrigin,
    );
    say('已发送冒充 hello（门户来源窗口校验应拒绝，不会产生绑定）。');
  });
}

main();
