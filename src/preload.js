// Ponte entre a tela (sem acesso a Node) e o processo principal. A tela só
// enxerga `window.kr`, e o processo principal só aceita os métodos da lista
// dele (ver ipcApi em main/main.js).

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('kr', {
  /** Chama um método do app. Resolve com o valor ou rejeita com a mensagem de erro. */
  call: async (method, ...args) => {
    const res = await ipcRenderer.invoke('kr:call', method, ...args);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Erro desconhecido');
    return res.value;
  },
  onState: (callback) => subscribe('kr:state', callback),
  onLog: (callback) => subscribe('kr:log', callback),
});
