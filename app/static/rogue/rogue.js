'use strict';

// 未获准站点：源不在门户白名单中，所有消息与接口访问都应失败。
const out = document.getElementById('out');

function say(msg, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  out.prepend(line);
}

async function main() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  document.getElementById('self-origin').textContent = cfg.selfOrigin;
  const portalOrigin = cfg.portalOrigin;
  const target = window.parent !== window ? window.parent : window.opener;

  window.addEventListener('message', (event) => {
    if (event.origin !== portalOrigin) return;
    const denied = typeof event.data?.type === 'string' && event.data.type.includes('denied');
    say(`收到门户回复：${JSON.stringify(event.data)}`, denied ? 'error' : 'info');
  });

  document.getElementById('btn-request').addEventListener('click', () => {
    if (!target) return say('没有可发送的门户窗口（请把本站点嵌入门户 iframe，或从门户打开）。', 'error');
    target.postMessage(
      { type: 'log:request', requestId: crypto.randomUUID(), docId: `rogue-${crypto.randomUUID()}` },
      portalOrigin,
    );
    say('已向门户发送 log:request，预期被固定 origin 校验拒绝。');
  });

  document.getElementById('btn-hello').addEventListener('click', () => {
    if (!target) return say('没有可发送的门户窗口。', 'error');
    target.postMessage(
      { type: 'vendor:hello', docId: `rogue-${crypto.randomUUID()}`, href: location.href },
      portalOrigin,
    );
    say('已发送冒充 hello，预期被固定 origin 校验拒绝，无法形成绑定。');
  });

  document.getElementById('btn-direct').addEventListener('click', async () => {
    const attempts = [
      `${portalOrigin}/api/logs?deviceId=dev-gw-01&token=stolen-or-guessed&delay=0`,
      `${portalOrigin}/api/devices`,
    ];
    for (const url of attempts) {
      try {
        const resp = await fetch(url);
        say(`直连 ${url} -> HTTP ${resp.status}（未获得数据）`, 'warn');
      } catch (err) {
        say(`直连 ${url} 被浏览器 CORS 拦截：${err.message}`, 'error');
      }
    }
  });
}

main();
