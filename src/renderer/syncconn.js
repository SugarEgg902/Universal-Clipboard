// 连接共享主机小窗：校验输入 → 经 preload 桥（window.api）调主进程 health 校验 + 写配置。
const api = window.api;

const btn = document.getElementById('go');
btn.addEventListener('click', async () => {
  const addr = document.getElementById('addr').value.trim();
  const token = document.getElementById('token').value.trim();
  const err = document.getElementById('err');
  err.textContent = '';
  const m = addr.match(/^([\d.]+):(\d+)$/);
  if (!m) { err.textContent = '地址格式应为 IP:端口'; return; }
  if (!token) { err.textContent = '请输入配对码'; return; }
  btn.disabled = true; // 防连点重复发起连接
  try {
    const res = await api.syncConnect({ hostIp: m[1], hostPort: Number(m[2]), token });
    if (res && res.ok) {
      window.close();
      return;
    }
    err.textContent = (res && res.error) || '连接失败';
  } catch {
    err.textContent = '连接失败（主进程错误）';
  } finally {
    btn.disabled = false;
  }
});
