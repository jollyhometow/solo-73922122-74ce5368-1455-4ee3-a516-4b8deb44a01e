'use strict';

// 跳转后的新文档：重新握手绑定；旧文档的任何迟到消息都与本页无关。
const docId = `vendor-doc-${crypto.randomUUID()}`;
document.getElementById('doc-id').textContent = docId;
const commLog = document.getElementById('comm-log');

function say(msg, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  commLog.prepend(line);
}

async function main() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  let acked = false;
  if (window.parent !== window) {
    // 与主诊断页相同的重发握手，消除父子 load/hello 时序竞争。
    const sendHello = () => {
      if (acked) return;
      window.parent.postMessage({ type: 'vendor:hello', docId, href: location.href }, cfg.portalOrigin);
    };
    sendHello();
    const timer = setInterval(() => {
      if (acked) clearInterval(timer);
      else sendHello();
    }, 150);
    say('新文档已发送 hello，请求门户重新绑定。');
  } else {
    say('当前为顶层窗口，无门户可绑定。', 'warn');
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== cfg.portalOrigin || event.source !== window.parent) return;
    const msg = event.data;
    if (msg?.type === 'portal:hello-ack') {
      acked = true;
      say('门户已绑定本新文档；旧文档的迟到结果不会转发到这里。', 'ok');
    } else if (msg?.type === 'state') {
      say(`门户当前设备：${msg.deviceId}，延迟 ${msg.delay}s。`);
    } else if (msg?.type === 'log:result') {
      say(`意外收到日志结果 requestId=${msg.requestId}（正常流程下不应出现）。`, 'warn');
    }
  });

  document.getElementById('btn-back').addEventListener('click', () => {
    location.href = '/';
  });
}

main();
