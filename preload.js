const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  maximizable: () => ipcRenderer.invoke('window:maximizable'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
  isAlwaysOnTop: () => ipcRenderer.invoke('window:isAlwaysOnTop'),
  setSize: (w, h, animate) => ipcRenderer.invoke('window:setSize', w, h, animate),
  setMinimumSize: (w, h) => ipcRenderer.invoke('window:setMinimumSize', w, h),
  getPosition: () => ipcRenderer.invoke('window:getPosition'),
  setPosition: (x, y) => ipcRenderer.invoke('window:setPosition', x, y),
  setResizable: (flag) => ipcRenderer.invoke('window:setResizable', flag),

  // Floating / edge-snap (main-process driven)
  enterFloating: () => ipcRenderer.invoke('window:enterFloating'),
  exitFloating: () => ipcRenderer.invoke('window:exitFloating'),
  isFloating: () => ipcRenderer.invoke('window:isFloating'),
  collapseTo: (edge) => ipcRenderer.invoke('window:collapseTo', edge),
  restoreFromCollapse: (edge) => ipcRenderer.invoke('window:restoreFromCollapse', edge),
  setIconDragging: (flag) => ipcRenderer.invoke('window:setIconDragging', flag),
  snapToNearestEdge: () => ipcRenderer.invoke('window:snapToNearestEdge'),
  onEdgeSnap: (cb) => {
    const listener = (e, edge) => cb(edge);
    ipcRenderer.on('window:edge-snap', listener);
    return () => ipcRenderer.removeListener('window:edge-snap', listener);
  },

  // File operations
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (content) => ipcRenderer.invoke('dialog:saveFile', content),
  saveHTML: (html) => ipcRenderer.invoke('dialog:saveHTML', html),
  savePDF: (html) => ipcRenderer.invoke('dialog:savePDF', html),
  readFileByPath: (filePath) => ipcRenderer.invoke('file:readByPath', filePath),
  writeFileByPath: (filePath, content) => ipcRenderer.invoke('file:writeByPath', filePath, content),
  savePrompt: (fileName) => ipcRenderer.invoke('dialog:savePrompt', fileName),
  // AI Agent: tool-use loop runs in main process to bypass CORS
  agentChat: (params) => ipcRenderer.invoke('ai:agentChat', params),
  onAgentText: (cb) => {
    const listener = (e, chunk) => cb(chunk);
    ipcRenderer.on('agent:text', listener);
    return () => ipcRenderer.removeListener('agent:text', listener);
  },
  onAgentToolStart: (cb) => {
    const listener = (e, data) => cb(data);
    ipcRenderer.on('agent:tool_start', listener);
    return () => ipcRenderer.removeListener('agent:tool_start', listener);
  },
  onAgentToolResult: (cb) => {
    const listener = (e, data) => cb(data);
    ipcRenderer.on('agent:tool_result', listener);
    return () => ipcRenderer.removeListener('agent:tool_result', listener);
  },
  onAgentDone: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('agent:done', listener);
    return () => ipcRenderer.removeListener('agent:done', listener);
  },
  // Renderer listens for tool-execution requests from the main process.
  onExecTool: (cb) => {
    const listener = (e, data) => cb(data);
    ipcRenderer.on('agent:execTool', listener);
    return () => ipcRenderer.removeListener('agent:execTool', listener);
  },
  // Renderer sends a tool's result back to the main process.
  sendToolResult: (requestId, result, error) =>
    ipcRenderer.send('agent:toolResult', { requestId, result, error }),
});
