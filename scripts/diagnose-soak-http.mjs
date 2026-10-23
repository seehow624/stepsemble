// Diagnostic branch only. The soak owns a fresh secret-free localhost Host.
if (process.argv.some(value => /reliability-soak\.test\.js$/.test(value))) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await original(...args);
    const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url);
    if (!response.ok && url.hostname === '127.0.0.1' && url.pathname === '/api/agent/open') {
      let body; try { body = await response.clone().json(); } catch {}
      console.log(JSON.stringify({diagnostic:'owned-soak-task-open',status:response.status,error:typeof body?.error === 'string' ? body.error.slice(0,500) : null,code:body?.code || null}));
    }
    return response;
  };
}
