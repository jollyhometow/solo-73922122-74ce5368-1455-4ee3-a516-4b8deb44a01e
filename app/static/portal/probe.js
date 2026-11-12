'use strict';

// 同源旁窗：origin 与门户完全一致，但不是门户内绑定的 iframe 文档。
const out = document.getElementById('out');

function say(msg, level = 'info') {
  const div = document.createElement('div');
  div.className = `log-line log-${level}`;
  div.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  out.prepend(div);
}

async function main() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  document.getElementById('portal-origin').textContent = cfg.selfOrigin;
  document.getElementById('opener-state').textContent =
    window.opener ? '存在（门户主窗口）' : '无（请从门户按钮打开本页）';

  window.addEventListener('message', (event) => {
    if (event.origin !== cfg.selfOrigin) return;
    const denied = typeof event.data?.type === 'string' && event.data.type.includes('denied');
    say(`收到门户回复：${JSON.stringify(event.data)}`, denied ? 'error' : 'info');
  });

  document.getElementById('btn-spoof-request').addEventListener('click', () => {
    if (!window.opener) return say('没有 opener，无法演示。', 'error');
    window.opener.postMessage(
      { type: 'log:request', requestId: crypto.randomUUID(), docId: `spoof-doc-${crypto.randomUUID()}` },
      cfg.selfOrigin,
    );
    say('已向门户发送冒充的 log:request（同源，origin 合法）。');
  });

  document.getElementById('btn-spoof-hello').addEventListener('click', () => {
    if (!window.opener) return say('没有 opener，无法演示。', 'error');
    window.opener.postMessage(
      { type: 'vendor:hello', docId: `spoof-doc-${crypto.randomUUID()}`, href: location.href },
      cfg.selfOrigin,
    );
    say('已向门户发送冒充的 vendor:hello（应被来源窗口校验拒绝，不会形成绑定）。');
  });
}

main();
