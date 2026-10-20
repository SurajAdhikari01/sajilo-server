/**
 * Sajilo Explorer - Compiler & IR Viewer UI Client
 * 
 * Workflow:
 * 1. User inputs custom Sajilo code in the left editor (custom_input.sj).
 * 2. User clicks "Run" (or Ctrl+Enter).
 * 3. The code is sent via HTTP POST to the user's C++ server.
 * 4. The C++ server runs the compiler, produces the output file (out.ir),
 *    and sends the generated content back.
 * 5. The UI displays the generated output file in the right viewer.
 */

// ============================================================================
// 1. CONFIGURATION & C++ SERVER INTEGRATION
// ============================================================================
const defaultServerUrl = (window.location.protocol.startsWith('http') && window.location.host)
  ? `${window.location.origin}/compile`
  : 'http://localhost:8080/compile';

const CONFIG = {
  // Your C++ server URL. Default is http://localhost:8080/compile
  serverUrl: defaultServerUrl,
  
  // Format to send: 'json' ({ "code": "..." }) or 'raw' (text/plain)
  requestFormat: 'json',
  
  // Auto-run on typing (off by default so user controls when to Run)
  autoRun: false,
  debounceMs: 500,
  
  fontSize: 15,
  syncScroll: true
};

// Initial starter code in the custom input editor
const STARTER_CODE = `func main(int var, int hell) -> deu(int) {
  manau int test = 10;
  manau int a = 1;
  manau int b = 2;

  jaba(a + b) {
    a + b;
    laijau(test);
  } natra {
    exit(0);
  }

  manau:const int number = 10;
  manau string buffer = "sajilo";
  read(buffer, number);
  exit(number);
}`;

// Sample templates available from the dropdown
const CODE_TEMPLATES = {
  empty: ``,
  default: STARTER_CODE,
  branching: `func main() -> deu(int) {
  manau int score = 85;
  manau int passing = 40;

  jaba(score > passing) {
    write("Student passed\\n", 15);
    laijau(1);
  } natra {
    write("Student failed\\n", 15);
    laijau(0);
  }
}`,
  nested: `func main() -> deu(int) {
  manau int a = 5;
  manau int b = 10;

  jaba(a < b) {
    manau int temp = a + b;
    jaba(temp == 15) {
      laijau(temp);
    }
  }
  laijau(0);
}`,
  syscalls: `func main() -> deu(int) {
  manau int len = 12;
  manau string message = "hello sajilo\\n";
  write(message, len);

  manau string input_buf = "";
  read(input_buf, 32);

  exit(0);
}`
};

// Placeholder shown in Output Viewer before the first run or when waiting for server
const WAITING_PLACEHOLDER = `; =====================================================================
; Waiting to run code on your C++ server
; =====================================================================
; 
; 1. Enter or edit your custom Sajilo code on the left.
; 2. Click the green "Run" button (or press Ctrl + Enter).
; 3. Your C++ server at ${CONFIG.serverUrl} will receive the code,
;    compile it with sajilo, and return the generated output here.
;
; Example C++ server endpoint:
;   POST ${CONFIG.serverUrl}
;   Payload: { "code": "<your-custom-code>" }
;   Response: generated compilation output
; =====================================================================`;

// ============================================================================
// 2. MONACO LANGUAGE DEFINITIONS
// ============================================================================
function registerLanguages(monaco) {
  // Sajilo Source Language
  monaco.languages.register({ id: 'sajilo' });
  monaco.languages.setMonarchTokensProvider('sajilo', {
    keywords: [
      'func', 'manau', 'const', 'jaba', 'natra', 'laijau', 'deu',
      'read', 'write', 'exit', 'return', 'paxi', 'aani', 'bhitra'
    ],
    typeKeywords: ['int', 'string', 'bool', 'float', 'char', 'void'],
    operators: ['=', '>', '<', '!', '==', '<=', '>=', '!=', '+', '-', '*', '/', '%', '->', ':'],
    
    tokenizer: {
      root: [
        [/#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@default': 'identifier'
          }
        }],
        [/\b\d+\b/, 'number'],
        [/[{}()\[\]]/, '@brackets'],
        [/->|==|<=|>=|!=|[:+\-*\/%=<>!]/, 'operator'],
        [/[;,.]/, 'delimiter'],
      ]
    }
  });

  // Sajilo 3-Address Intermediate Representation (IR) & Output Viewer
  monaco.languages.register({ id: 'sajilo-ir' });
  monaco.languages.setMonarchTokensProvider('sajilo-ir', {
    keywords: ['jmp', 'call', 'param', 'return', 'if', 'false', 'true'],
    
    tokenizer: {
      root: [
        // Error messages and lines (highlighted in vivid proper error red across all themes)
        [/^\[ERROR\].*$/, 'invalid'],
        [/^Error:.*$/, 'invalid'],
        [/^.*\[.*Error.*\].*$/, 'invalid'],
        [/^[a-zA-Z0-9_.\-\/\\]+:\d+(:\d+)?:\s*.*$/, 'invalid'],
        [/\b(error|Error|ERROR|failed|Failed|FAILED)\b/, 'invalid'],
        [/\b[bB]\d+:/, 'type.identifier'],
        [/\b[a-zA-Z_]\w*:/, 'type.identifier'],
        [/;.*$/, 'comment'],
        [/#.*$/, 'comment'],
        [/__sys_\w+|sys_\w+/, 'support.function'],
        [/\bt\d+\b/, 'variable.name'],
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier'
          }
        }],
        [/\b\d+\b/, 'number'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/=|[+\-*\/]/, 'operator'],
      ]
    }
  });
}

// ============================================================================
// 2.5 THEME MANAGEMENT & VIM MONACO PALETTES
// ============================================================================
let currentTheme = 'catppuccin-mocha';
try {
  const saved = localStorage.getItem('sajilo-theme');
  if (saved) currentTheme = saved;
} catch (_) {}

function applyTheme(themeId) {
  currentTheme = themeId;
  document.documentElement.setAttribute('data-theme', themeId);
  try {
    localStorage.setItem('sajilo-theme', themeId);
  } catch (_) {}

  const themeLabels = {
    'catppuccin-mocha': 'Catppuccin',
    'tokyo-night': 'Tokyo Night',
    'gruvbox-dark': 'Gruvbox',
    'nord': 'Nord',
    'vs-dark': 'VS Dark'
  };

  const labelElem = document.getElementById('current-theme-label');
  if (labelElem && themeLabels[themeId]) {
    labelElem.textContent = themeLabels[themeId];
  }

  document.querySelectorAll('#theme-menu .theme-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-theme') === themeId);
  });

  if (typeof monaco !== 'undefined' && monaco.editor && monaco.editor.setTheme) {
    monaco.editor.setTheme(themeId);
  }
}

function registerMonacoThemes(monaco) {
  // Catppuccin Mocha (Vim / Neovim)
  monaco.editor.defineTheme('catppuccin-mocha', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'cba6f7', fontStyle: 'italic' },
      { token: 'type', foreground: 'f9e2af' },
      { token: 'type.identifier', foreground: 'f9e2af' },
      { token: 'string', foreground: 'a6e3a1' },
      { token: 'number', foreground: 'fab387' },
      { token: 'comment', foreground: '6c7086', fontStyle: 'italic' },
      { token: 'operator', foreground: '89dceb' },
      { token: 'identifier', foreground: 'cdd6f4' },
      { token: 'support.function', foreground: '89b4fa' },
      { token: 'variable.name', foreground: 'f5c2e7' },
      { token: 'invalid', foreground: 'f38ba8', fontStyle: 'bold' },
      { token: 'error', foreground: 'f38ba8', fontStyle: 'bold' }
    ],
    colors: {
      'editor.background': '#1e1e2e',
      'editor.foreground': '#cdd6f4',
      'editorCursor.foreground': '#f5e0dc',
      'editor.lineHighlightBackground': '#26273b',
      'editorLineNumber.foreground': '#6c7086',
      'editorLineNumber.activeForeground': '#cdd6f4',
      'editor.selectionBackground': '#45475a88'
    }
  });

  // Tokyo Night (Vim)
  monaco.editor.defineTheme('tokyo-night', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'bb9af7', fontStyle: 'italic' },
      { token: 'type', foreground: '2ac3de' },
      { token: 'type.identifier', foreground: '2ac3de' },
      { token: 'string', foreground: '9ece6a' },
      { token: 'number', foreground: 'ff9e64' },
      { token: 'comment', foreground: '565f89', fontStyle: 'italic' },
      { token: 'operator', foreground: '89ddff' },
      { token: 'identifier', foreground: 'c0caf5' },
      { token: 'support.function', foreground: '7aa2f7' },
      { token: 'variable.name', foreground: 'e0af68' },
      { token: 'invalid', foreground: 'f7768e', fontStyle: 'bold' },
      { token: 'error', foreground: 'f7768e', fontStyle: 'bold' }
    ],
    colors: {
      'editor.background': '#1a1b26',
      'editor.foreground': '#c0caf5',
      'editorCursor.foreground': '#c0caf5',
      'editor.lineHighlightBackground': '#24283b',
      'editorLineNumber.foreground': '#565f89',
      'editorLineNumber.activeForeground': '#c0caf5',
      'editor.selectionBackground': '#283457'
    }
  });

  // Gruvbox Dark (Vim)
  monaco.editor.defineTheme('gruvbox-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'fb4934', fontStyle: 'italic' },
      { token: 'type', foreground: 'fabd2f' },
      { token: 'type.identifier', foreground: 'fabd2f' },
      { token: 'string', foreground: 'b8bb26' },
      { token: 'number', foreground: 'd3869b' },
      { token: 'comment', foreground: '928374', fontStyle: 'italic' },
      { token: 'operator', foreground: 'fe8019' },
      { token: 'identifier', foreground: 'ebdbb2' },
      { token: 'support.function', foreground: '83a598' },
      { token: 'variable.name', foreground: 'b8bb26' },
      { token: 'invalid', foreground: 'fb4934', fontStyle: 'bold' },
      { token: 'error', foreground: 'fb4934', fontStyle: 'bold' }
    ],
    colors: {
      'editor.background': '#282828',
      'editor.foreground': '#ebdbb2',
      'editorCursor.foreground': '#ebdbb2',
      'editor.lineHighlightBackground': '#3c3836',
      'editorLineNumber.foreground': '#7c6f64',
      'editorLineNumber.activeForeground': '#ebdbb2',
      'editor.selectionBackground': '#504945'
    }
  });

  // Nord
  monaco.editor.defineTheme('nord', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '81a1c1', fontStyle: 'italic' },
      { token: 'type', foreground: '8fbcbb' },
      { token: 'type.identifier', foreground: '8fbcbb' },
      { token: 'string', foreground: 'a3be8c' },
      { token: 'number', foreground: 'b48ead' },
      { token: 'comment', foreground: '616e88', fontStyle: 'italic' },
      { token: 'operator', foreground: '88c0d0' },
      { token: 'identifier', foreground: 'd8dee9' },
      { token: 'support.function', foreground: '88c0d0' },
      { token: 'invalid', foreground: 'bf616a', fontStyle: 'bold' },
      { token: 'error', foreground: 'bf616a', fontStyle: 'bold' }
    ],
    colors: {
      'editor.background': '#2e3440',
      'editor.foreground': '#d8dee9',
      'editorCursor.foreground': '#d8dee9',
      'editor.lineHighlightBackground': '#3b4252',
      'editorLineNumber.foreground': '#4c566a',
      'editorLineNumber.activeForeground': '#d8dee9',
      'editor.selectionBackground': '#434c5e'
    }
  });
}

// ============================================================================
// 3. UI STATE & MULTI-FILE TAB HELPERS
// ============================================================================
let editorLeft = null;
let editorRight = null;
let autoRunTimer = null;
let isRunning = false;

let files = [
  {
    id: 'file-1',
    name: 'main.sj',
    content: STARTER_CODE
  }
];
let activeFileId = 'file-1';
const fileModels = new Map();

function getActiveFile() {
  return files.find(f => f.id === activeFileId) || files[0];
}

function getOrCreateFileModel(file) {
  if (typeof monaco === 'undefined' || !monaco.editor) return null;
  if (!fileModels.has(file.id)) {
    const uri = monaco.Uri.parse(`inmemory://workspace/${file.id}/${file.name}`);
    const existing = monaco.editor.getModel(uri);
    const model = existing || monaco.editor.createModel(file.content, 'sajilo', uri);
    model.onDidChangeContent(() => {
      file.content = model.getValue();
      updateCodeStats();
      if (CONFIG.autoRun) {
        clearTimeout(autoRunTimer);
        autoRunTimer = setTimeout(() => {
          runCodeOnCppServer();
        }, CONFIG.debounceMs);
      }
    });
    fileModels.set(file.id, model);
  }
  return fileModels.get(file.id);
}

function renderTabs() {
  const container = document.getElementById('editor-tabs');
  if (!container) return;
  container.innerHTML = '';

  files.forEach((file) => {
    const tab = document.createElement('div');
    tab.className = `tab ${file.id === activeFileId ? 'active' : ''}`;
    tab.title = `${file.name} (Click name to rename)`;

    const icon = document.createElement('span');
    icon.className = 'file-icon sj-icon';
    icon.textContent = 'SJ';

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = file.name;
    title.title = 'Click to rename file';

    const triggerRename = (e) => {
      e.stopPropagation();
      const currentName = file.name;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-title-input';
      input.value = currentName;
      title.replaceWith(input);
      input.focus();
      input.select();

      let finished = false;
      const finishRename = () => {
        if (finished) return;
        finished = true;
        let val = input.value.trim();
        if (!val) val = currentName;
        if (!val.endsWith('.sj')) val += '.sj';
        file.name = val;
        renderTabs();
      };

      input.addEventListener('blur', finishRename);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          finishRename();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          finished = true;
          renderTabs();
        }
      });
    };

    // Click directly on input file name to rename
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      if (file.id === activeFileId) {
        triggerRename(e);
      } else {
        switchToFile(file.id);
      }
    });

    title.addEventListener('dblclick', triggerRename);

    tab.appendChild(icon);
    tab.appendChild(title);

    if (files.length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close-btn';
      closeBtn.innerHTML = '&times;';
      closeBtn.title = `Close ${file.name}`;
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeFile(file.id);
      });
      tab.appendChild(closeBtn);
    }

    tab.addEventListener('click', () => {
      switchToFile(file.id);
    });

    container.appendChild(tab);
  });
}

function switchToFile(fileId) {
  activeFileId = fileId;
  const file = getActiveFile();
  if (!file) return;

  if (editorLeft) {
    if (editorLeft.setModel) {
      const model = getOrCreateFileModel(file);
      if (model) editorLeft.setModel(model);
    } else if (editorLeft.setValue) {
      editorLeft.setValue(file.content);
    }
    if (editorLeft.focus) editorLeft.focus();
  }

  renderTabs();
  updateCodeStats();
}

function addNewFile(customName, initialContent) {
  let counter = files.length + 1;
  let name = customName;
  if (!name) {
    while (files.some(f => f.name === `file${counter}.sj`)) {
      counter++;
    }
    name = `file${counter}.sj`;
  }
  if (!name.endsWith('.sj')) name += '.sj';

  const defaultContent = initialContent || `func helper_${counter}() -> deu(int) {\n  laijau(${counter});\n};\n`;
  const newFile = {
    id: 'file-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    name: name,
    content: defaultContent
  };
  files.push(newFile);
  switchToFile(newFile.id);
  showToast(`Created ${name}`);
}

function closeFile(fileId) {
  if (files.length <= 1) {
    showToast('Cannot close the last remaining file', 'warn');
    return;
  }
  const idx = files.findIndex(f => f.id === fileId);
  if (idx === -1) return;
  const removed = files.splice(idx, 1)[0];
  if (fileModels.has(fileId)) {
    try { fileModels.get(fileId).dispose(); } catch (_) {}
    fileModels.delete(fileId);
  }
  if (activeFileId === fileId) {
    const nextIdx = Math.max(0, idx - 1);
    switchToFile(files[nextIdx].id);
  } else {
    renderTabs();
  }
  showToast(`Closed ${removed.name}`);
}

function getCombinedSourceCode() {
  const activeFile = getActiveFile();
  if (editorLeft && editorLeft.getValue) {
    activeFile.content = editorLeft.getValue();
  }

  if (files.length === 1) {
    return activeFile.content;
  }

  // Put non-main files first, then main file so functions are defined before main
  const otherFiles = [];
  const mainFiles = [];

  files.forEach(f => {
    if (f.name === 'main.sj' || f.content.includes('func main')) {
      mainFiles.push(f);
    } else {
      otherFiles.push(f);
    }
  });

  const ordered = [...otherFiles, ...mainFiles];
  return ordered.map(f => `// ================= [${f.name}] =================\n${f.content.trim()}`).join('\n\n');
}

function logConsole(message, type = 'info') {
  const consoleOutput = document.getElementById('console-output');
  const countPill = document.getElementById('log-count');
  if (!consoleOutput) return;

  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  consoleOutput.appendChild(entry);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;

  const totalLogs = consoleOutput.querySelectorAll('.log-entry').length;
  if (countPill) countPill.textContent = `${totalLogs} logs`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

function updateServerStatus(status, text) {
  const pill = document.getElementById('server-status-pill');
  const label = document.getElementById('server-status-text');
  if (!pill || !label) return;

  pill.className = `status-pill status-${status}`;
  label.textContent = text;
}

function updateCodeStats() {
  if (!editorLeft) return;
  const val = editorLeft.getValue();
  const lenElem = document.getElementById('code-length-display');
  if (lenElem) {
    lenElem.textContent = `${val.length} chars`;
  }
}

function updateOutputStats() {
  if (!editorRight) return;
  const lineCount = editorRight.getModel().getLineCount();
  const statsElem = document.getElementById('ir-stats');
  if (statsElem) {
    statsElem.textContent = `${lineCount} lines`;
  }
}

async function checkServerHealth() {
  try {
    const healthUrl = CONFIG.serverUrl.replace(/\/compile\/?$/, '/health');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(healthUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.ok) {
      updateServerStatus('online', 'C++ Server: Online');
      logConsole(`C++ Server reachable at ${healthUrl}`, 'success');
      return true;
    }
  } catch (_) {
    // Keep standby or current status
  }
  return false;
}

// ============================================================================
// 4. RUN CODE ON C++ SERVER
// ============================================================================

function highlightErrorInEditor(errorMsg) {
  if (!editorLeft || typeof monaco === 'undefined') return;
  const match = errorMsg.match(/([a-zA-Z0-9_.\-\/\\]+\.sj):(\d+)(?::(\d+))?:?\s*(.*)/i);
  if (match) {
    const errorFile = match[1].split('/').pop().split('\\').pop();
    const line = parseInt(match[2], 10);
    const col = match[3] ? parseInt(match[3], 10) : 1;
    const msg = (match[4] || 'Compilation error').replace(/^["']|["']$/g, '');

    const active = getActiveFile();
    if (active && (active.name === errorFile || files.length === 1)) {
      monaco.editor.setModelMarkers(editorLeft.getModel(), 'sajilo', [{
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: 1000,
        message: msg,
        severity: monaco.MarkerSeverity.Error
      }]);
    }
  }
}

function clearEditorErrors() {
  if (editorLeft && typeof monaco !== 'undefined') {
    monaco.editor.setModelMarkers(editorLeft.getModel(), 'sajilo', []);
  }
}

/**
 * Takes the currently active file from the editor, sends it to the C++ server
 * via HTTP POST, and displays the generated output in the right editor.
 * Only the active (open) file is compiled — not the combined multi-file source.
 */
async function runCodeOnCppServer() {
  if (isRunning || !editorLeft || !editorRight) return;

  const activeFile = getActiveFile();
  // Always capture the latest editor content into the active file
  if (editorLeft && editorLeft.getValue) {
    activeFile.content = editorLeft.getValue();
  }

  // Run ONLY the currently open (active) file — not combined multi-file output
  const sourceCode = activeFile.content;
  const btnRun = document.getElementById('btn-run');
  const btnRunText = btnRun.querySelector('.btn-text');
  const durationText = document.getElementById('duration-text');
  const compileBadge = document.getElementById('compile-duration');
  const bottomBar = document.querySelector('.bottom-bar');

  if (!sourceCode.trim()) {
    showToast('Input is empty. Enter some Sajilo code first!', 'error');
    return;
  }

  isRunning = true;
  btnRun.classList.add('running');
  if (btnRunText) btnRunText.textContent = 'Running...';
  if (durationText) durationText.textContent = 'Sending to C++ server...';

  const startTime = performance.now();
  logConsole(`Compiling [${activeFile.name}] (${sourceCode.length} chars) via ${CONFIG.serverUrl}...`, 'dim');

  try {
    // Build request payload — send only the active (open) file
    let headers = {};
    let bodyData = null;

    if (CONFIG.requestFormat === 'json') {
      headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*'
      };
      bodyData = JSON.stringify({
        code: sourceCode,
        filename: activeFile.name,
        // Send only the active file (not all files)
        files: [{ name: activeFile.name, content: sourceCode }]
      });
    } else {
      headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Accept': 'text/plain, */*'
      };
      bodyData = sourceCode;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

    const response = await fetch(CONFIG.serverUrl, {
      method: 'POST',
      headers: headers,
      body: bodyData,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const json = await response.json();

        // Explicitly check status: true or false
        if (json.status === true) {
          // Status TRUE: show compiled output in the viewer
          clearEditorErrors();
          const outputContent = json.output || json.ir || '';
          editorRight.setValue(outputContent);
          updateOutputStats();
          if (compileBadge) compileBadge.classList.remove('error');
          if (bottomBar) bottomBar.classList.remove('error-mode');
          if (durationText) durationText.textContent = `Generated in ${elapsed}s`;
          updateServerStatus('online', 'C++ Server: Online');
          logConsole(`[Sajilo] Compilation succeeded (${elapsed}s, ${outputContent.length} bytes)`, 'success');
          showToast(`Compiled successfully in ${elapsed}s!`, 'success');
        } else {
          // Status FALSE: format and display error in vivid proper red
          const rawError = (json.error || json.output || 'Unknown compilation error').trim();
          editorRight.setValue(`[ERROR] Sajilo Compilation Failed:\n${'='.repeat(68)}\n\n${rawError}\n\n${'='.repeat(68)}`);
          updateOutputStats();
          if (compileBadge) compileBadge.classList.add('error');
          if (bottomBar) bottomBar.classList.add('error-mode');
          if (durationText) durationText.textContent = `Compilation Error (${elapsed}s)`;
          updateServerStatus('online', 'C++ Server: Online');
          logConsole(`[Sajilo Error] ${rawError}`, 'error');
          showToast(`Compilation error: check output viewer`, 'error');
          highlightErrorInEditor(rawError);
        }

        if (json.stderr) {
          logConsole(`[C++ Stderr] ${json.stderr}`, 'warn');
        }
      } else {
        // Raw text response
        clearEditorErrors();
        const outputContent = await response.text();
        editorRight.setValue(outputContent);
        updateOutputStats();
        if (compileBadge) compileBadge.classList.remove('error');
        if (bottomBar) bottomBar.classList.remove('error-mode');
        if (durationText) durationText.textContent = `Generated in ${elapsed}s`;
        updateServerStatus('online', 'C++ Server: Online');
        logConsole(`Output received (${elapsed}s, ${outputContent.length} bytes)`, 'success');
        showToast(`Output generated in ${elapsed}s!`, 'success');
      }

    } else {
      let errorText = '';
      try {
        const errJson = await response.json();
        errorText = errJson.error || errJson.output || JSON.stringify(errJson);
      } catch (_) {
        errorText = await response.text();
      }
      if (compileBadge) compileBadge.classList.add('error');
      if (bottomBar) bottomBar.classList.add('error-mode');
      editorRight.setValue(`[ERROR] Server Error (HTTP ${response.status}):\n${'='.repeat(68)}\n\n${errorText || response.statusText}\n\n${'='.repeat(68)}`);
      updateOutputStats();
      if (durationText) durationText.textContent = `Error (${elapsed}s)`;
      logConsole(`Compiler error (HTTP ${response.status}): ${errorText}`, 'error');
      showToast(`Server error`, 'error');
      return;
    }

  } catch (err) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
    updateServerStatus('error', 'C++ Server: Failed');
    if (compileBadge) compileBadge.classList.add('error');
    if (bottomBar) bottomBar.classList.add('error-mode');
    if (durationText) durationText.textContent = `Error (${elapsed}s)`;

    logConsole(`Connection failed: ${err.message}`, 'error');
    logConsole(`Please verify your C++ server is listening on ${CONFIG.serverUrl} and has CORS enabled`, 'dim');

    // Show diagnostic in proper error red format
    editorRight.setValue(`[ERROR] Could Not Connect to C++ Server:\n${'='.repeat(68)}\n\nEndpoint: ${CONFIG.serverUrl}\nDetails: ${err.message}\n\nTroubleshooting:\n1. Make sure your C++ server is started and listening on port 8080\n2. Ensure your server sends CORS headers:\n     Access-Control-Allow-Origin: *\n3. Once your server is running, click "Run" again!\n\n${'='.repeat(68)}`);

    showToast(`Failed to reach C++ server at ${CONFIG.serverUrl}`, 'error');
    updateOutputStats();

  } finally {
    isRunning = false;
    btnRun.classList.remove('running');
    if (btnRunText) btnRunText.textContent = 'Run';
  }
}

// ============================================================================
// 5. RESIZABLE SPLIT PANES
// ============================================================================
function initSplitter() {
  const splitter = document.getElementById('splitter');
  const paneLeft = document.getElementById('pane-left');
  const paneRight = document.getElementById('pane-right');
  const workspace = document.getElementById('workspace');

  let isDragging = false;

  splitter.addEventListener('mousedown', () => {
    isDragging = true;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const workspaceRect = workspace.getBoundingClientRect();
    const offsetLeft = e.clientX - workspaceRect.left;
    const totalWidth = workspaceRect.width;

    const minWidth = 220;
    const clampedOffset = Math.max(minWidth, Math.min(totalWidth - minWidth, offsetLeft));

    const leftPercentage = (clampedOffset / totalWidth) * 100;
    paneLeft.style.flex = `0 0 ${leftPercentage}%`;
    paneRight.style.flex = `0 0 ${100 - leftPercentage}%`;

    if (editorLeft) editorLeft.layout();
    if (editorRight) editorRight.layout();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (editorLeft) editorLeft.layout();
      if (editorRight) editorRight.layout();
    }
  });

  splitter.addEventListener('dblclick', () => {
    paneLeft.style.flex = '1';
    paneRight.style.flex = '1';
    if (editorLeft) editorLeft.layout();
    if (editorRight) editorRight.layout();
    showToast('Reset split panes to 50/50');
  });

  window.addEventListener('resize', () => {
    if (editorLeft) editorLeft.layout();
    if (editorRight) editorRight.layout();
  });
}

// ============================================================================
// 6. MONACO BOOTSTRAP
// ============================================================================
function initMonaco() {
  if (typeof require === 'undefined') {
    initFallbackTextareas();
    return;
  }

  require.config({
    paths: {
      vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs'
    }
  });

  window.MonacoEnvironment = {
    getWorkerUrl: function () {
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
        self.MonacoEnvironment = { baseUrl: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/' };
        importScripts('https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/base/worker/workerMain.js');
      `)}`;
    }
  };

  require(['vs/editor/editor.main'], function () {
    registerLanguages(monaco);
    registerMonacoThemes(monaco);

    const commonOptions = {
      theme: currentTheme,
      fontSize: CONFIG.fontSize,
      fontFamily: "'VictorMono Nerd Font', 'VictorMono NF', 'Victor Mono', monospace",
      fontLigatures: true,
      automaticLayout: true,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      cursorBlinking: 'smooth',
      smoothScrolling: true,
      tabSize: 2,
      minimap: { enabled: true, maxColumn: 40, renderCharacters: false }
    };

    // Left Editor: Custom Code Input (Editable)
    const activeFile = getActiveFile();
    const initialModel = getOrCreateFileModel(activeFile);

    editorLeft = monaco.editor.create(document.getElementById('editor-left'), {
      ...commonOptions,
      model: initialModel,
      readOnly: false
    });

    // Right Editor: Output File Viewer (out.ir) - Select and View Only, No Edit
    editorRight = monaco.editor.create(document.getElementById('editor-right'), {
      ...commonOptions,
      value: WAITING_PLACEHOLDER,
      language: 'sajilo-ir',
      readOnly: true,              // View & select only, no editing
      domReadOnly: true,           // Disables keyboard inputs
      cursorStyle: 'line',         // Standard selectable text cursor
      contextmenu: true            // Allows right-click to select all and copy
    });

    applyTheme(currentTheme);
    renderTabs();

    // Update cursor position and length live
    editorLeft.onDidChangeCursorPosition((e) => {
      const posDisplay = document.getElementById('cursor-pos');
      if (posDisplay) {
        posDisplay.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      }
    });

    editorLeft.onDidChangeModelContent(() => {
      updateCodeStats();
      if (!CONFIG.autoRun) return;
      clearTimeout(autoRunTimer);
      autoRunTimer = setTimeout(() => {
        runCodeOnCppServer();
      }, CONFIG.debounceMs);
    });

    // Synchronize scrolling
    let isSyncing = false;
    editorLeft.onDidScrollChange((e) => {
      if (!CONFIG.syncScroll || isSyncing) return;
      isSyncing = true;
      editorRight.setScrollTop(e.scrollTop);
      isSyncing = false;
    });

    editorRight.onDidScrollChange((e) => {
      if (!CONFIG.syncScroll || isSyncing) return;
      isSyncing = true;
      editorLeft.setScrollTop(e.scrollTop);
      isSyncing = false;
    });

    updateCodeStats();
    updateOutputStats();
    logConsole('Monaco Editor ready. Enter code on the left and click "Run" to test with your C++ server.', 'success');
  });
}

function initFallbackTextareas() {
  logConsole('Using lightweight textarea fallback.', 'warn');
  const leftContainer = document.getElementById('editor-left');
  const rightContainer = document.getElementById('editor-right');

  const taLeft = document.createElement('textarea');
  taLeft.style.cssText = 'width:100%;height:100%;background:#1e1e1e;color:#d4d4d4;font-family:monospace;padding:12px;border:none;resize:none;outline:none;font-size:13px;line-height:1.5;';
  taLeft.value = STARTER_CODE;
  leftContainer.appendChild(taLeft);

  const taRight = document.createElement('textarea');
  taRight.style.cssText = 'width:100%;height:100%;background:#1e1e1e;color:#ce9178;font-family:monospace;padding:12px;border:none;resize:none;outline:none;font-size:13px;line-height:1.5;cursor:text;user-select:text;';
  taRight.value = WAITING_PLACEHOLDER;
  taRight.readOnly = true; // Select and view only
  rightContainer.appendChild(taRight);

  editorLeft = {
    getValue: () => taLeft.value,
    setValue: (v) => {
      taLeft.value = v;
      const f = getActiveFile();
      if (f) f.content = v;
      updateCodeStats();
    },
    layout: () => {}
  };
  editorRight = {
    getValue: () => taRight.value,
    setValue: (v) => { taRight.value = v; updateOutputStats(); },
    layout: () => {},
    getModel: () => ({ getLineCount: () => taRight.value.split('\n').length })
  };

  renderTabs();

  taLeft.addEventListener('input', () => {
    const f = getActiveFile();
    if (f) f.content = taLeft.value;
    updateCodeStats();
    if (CONFIG.autoRun) runCodeOnCppServer();
  });
}

// ============================================================================
// 7. EVENT LISTENERS
// ============================================================================
function setupEventListeners() {
  // Dropdown click-to-toggle & outside click handling
  document.querySelectorAll('.dropdown-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const parent = btn.closest('.dropdown');
      const wasOpen = parent.classList.contains('open');
      document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) {
        parent.classList.add('open');
      }
    });
  });

  // Clicking outside closes open dropdowns
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
    }
  });

  // Prevent dropdowns from closing when clicking inside settings popup controls
  document.querySelectorAll('.dropdown-menu').forEach((menu) => {
    menu.addEventListener('click', (e) => {
      if (e.target.closest('.setting-item') || e.target.closest('.setting-item-row')) {
        e.stopPropagation();
      }
    });
  });

  // Add file tab button (+)
  const btnAddTab = document.getElementById('btn-add-tab');
  if (btnAddTab) {
    btnAddTab.addEventListener('click', () => {
      addNewFile();
    });
  }

  // RUN BUTTON
  const btnRun = document.getElementById('btn-run');
  btnRun.addEventListener('click', () => {
    runCodeOnCppServer();
  });

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter to Run
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runCodeOnCppServer();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      showToast('Source code saved in memory');
    }
  });

  // Clear button: empties active file editor
  const btnClear = document.getElementById('btn-clear');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      const activeFile = getActiveFile();
      activeFile.content = '';
      if (editorLeft) {
        if (editorLeft.setValue) editorLeft.setValue('');
        if (editorLeft.focus) editorLeft.focus();
        showToast(`Cleared ${activeFile.name}!`);
      }
    });
  }

  // Server URL settings input
  const serverInput = document.getElementById('server-url-input');
  const endpointDisplay = document.getElementById('status-endpoint-display');
  if (serverInput) {
    serverInput.value = CONFIG.serverUrl;
    serverInput.addEventListener('change', (e) => {
      CONFIG.serverUrl = e.target.value.trim();
      const endpointVal = endpointDisplay ? endpointDisplay.querySelector('.endpoint-val') : null;
      if (endpointVal) endpointVal.textContent = CONFIG.serverUrl;
      showToast(`Compiler server endpoint set to ${CONFIG.serverUrl}`);
      checkServerHealth();
    });
  }
  if (endpointDisplay) {
    const endpointVal = endpointDisplay.querySelector('.endpoint-val');
    if (endpointVal) endpointVal.textContent = CONFIG.serverUrl;
  }

  // Request format select (JSON vs raw text)
  const formatSelect = document.getElementById('request-format-select');
  if (formatSelect) {
    formatSelect.addEventListener('change', (e) => {
      CONFIG.requestFormat = e.target.value;
      showToast(`Request format set to: ${CONFIG.requestFormat}`);
    });
  }

  // Click endpoint in bottom bar to quickly change URL
  if (endpointDisplay) {
    endpointDisplay.addEventListener('click', () => {
      const newUrl = prompt('Enter compiler server endpoint URL:', CONFIG.serverUrl);
      if (newUrl && newUrl.trim()) {
        CONFIG.serverUrl = newUrl.trim();
        serverInput.value = CONFIG.serverUrl;
        const endpointVal = endpointDisplay.querySelector('.endpoint-val');
        if (endpointVal) endpointVal.textContent = CONFIG.serverUrl;
        showToast(`Compiler server endpoint set to ${CONFIG.serverUrl}`);
      }
    });
  }

  // Auto-run toggle
  const autoRunToggle = document.getElementById('auto-run-toggle');
  if (autoRunToggle) {
    autoRunToggle.addEventListener('change', (e) => {
      CONFIG.autoRun = e.target.checked;
      showToast(CONFIG.autoRun ? 'Auto-run enabled on typing' : 'Auto-run disabled');
    });
  }

  // Sync scroll toggle
  const syncToggle = document.getElementById('sync-scroll-toggle');
  if (syncToggle) {
    syncToggle.addEventListener('change', (e) => {
      CONFIG.syncScroll = e.target.checked;
    });
  }

  // Status pill click to trigger run / test
  const serverPill = document.getElementById('server-status-pill');
  if (serverPill) {
    serverPill.addEventListener('click', () => {
      runCodeOnCppServer();
    });
  }

  // Theme selector dropdown
  document.querySelectorAll('#theme-menu [data-theme]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const themeId = link.getAttribute('data-theme');
      applyTheme(themeId);
      showToast(`Theme: ${link.textContent.trim()}`);
      document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
    });
  });

  // Code samples dropdown
  document.querySelectorAll('[data-template]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const templateKey = link.getAttribute('data-template');
      if (CODE_TEMPLATES.hasOwnProperty(templateKey)) {
        const activeFile = getActiveFile();
        activeFile.content = CODE_TEMPLATES[templateKey];
        if (editorLeft && editorLeft.setValue) {
          editorLeft.setValue(activeFile.content);
        }
        showToast(`Loaded sample: ${link.textContent.trim()}`);
        document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
      }
    });
  });

  // Copy buttons
  document.getElementById('btn-copy-src').addEventListener('click', () => {
    if (!editorLeft) return;
    navigator.clipboard.writeText(editorLeft.getValue()).then(() => {
      showToast('Copied active code!', 'success');
    });
  });

  document.getElementById('btn-copy-ir').addEventListener('click', () => {
    if (!editorRight) return;
    navigator.clipboard.writeText(editorRight.getValue()).then(() => {
      showToast('Copied output!', 'success');
    });
  });

  // Download buttons
  document.getElementById('btn-download-src').addEventListener('click', () => {
    const activeFile = getActiveFile();
    const content = (editorLeft && editorLeft.getValue) ? editorLeft.getValue() : activeFile.content;
    downloadFile(activeFile.name, content);
  });

  document.getElementById('btn-download-ir').addEventListener('click', () => {
    if (!editorRight) return;
    downloadFile('output.ir', editorRight.getValue());
  });

  // Font size buttons
  const changeFontSize = (delta) => {
    CONFIG.fontSize = Math.min(24, Math.max(10, CONFIG.fontSize + delta));
    if (editorLeft && editorLeft.updateOptions) editorLeft.updateOptions({ fontSize: CONFIG.fontSize });
    if (editorRight && editorRight.updateOptions) editorRight.updateOptions({ fontSize: CONFIG.fontSize });
  };

  document.getElementById('btn-font-dec-left').addEventListener('click', () => changeFontSize(-1));
  document.getElementById('btn-font-inc-left').addEventListener('click', () => changeFontSize(1));
  document.getElementById('btn-font-dec-right').addEventListener('click', () => changeFontSize(-1));
  document.getElementById('btn-font-inc-right').addEventListener('click', () => changeFontSize(1));

  // Console Drawer toggling & drag resizing
  const drawer = document.getElementById('console-drawer');
  const drawerResizer = document.getElementById('drawer-resizer');
  const drawerToggle = document.getElementById('drawer-toggle');
  const toggleConsoleBtn = document.getElementById('toggle-console-btn');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  let isDraggingDrawer = false;
  let startDragY = 0;
  let startDrawerHeight = 180;
  let savedDrawerHeight = 180;

  if (drawerResizer && drawer) {
    drawerResizer.addEventListener('mousedown', (e) => {
      // Only start drag on left mouse button
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      isDraggingDrawer = true;
      drawerResizer.classList.add('dragging');
      startDragY = e.clientY;

      // Capture current actual rendered height (not saved height)
      const currentHeight = drawer.offsetHeight;
      startDrawerHeight = currentHeight > 38 ? currentHeight : savedDrawerHeight;

      // Ensure drawer is open and frozen at its current pixel height before drag
      drawer.classList.remove('closed');
      drawer.style.height = `${startDrawerHeight}px`;
      drawer.style.transition = 'none';
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingDrawer) return;
      const delta = startDragY - e.clientY;
      const newHeight = Math.max(32, Math.min(window.innerHeight - 120, startDrawerHeight + delta));
      if (newHeight <= 38) {
        drawer.classList.add('closed');
        drawer.style.height = '';
      } else {
        drawer.classList.remove('closed');
        drawer.style.height = `${newHeight}px`;
        savedDrawerHeight = newHeight;
      }
      if (editorLeft && editorLeft.layout) editorLeft.layout();
      if (editorRight && editorRight.layout) editorRight.layout();
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingDrawer) {
        isDraggingDrawer = false;
        drawerResizer.classList.remove('dragging');
        drawer.style.transition = '';
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (editorLeft && editorLeft.layout) editorLeft.layout();
        if (editorRight && editorRight.layout) editorRight.layout();
      }
    });
  }

  const toggleDrawer = () => {
    if (drawer.classList.contains('closed')) {
      drawer.classList.remove('closed');
      drawer.style.height = `${savedDrawerHeight}px`;
    } else {
      savedDrawerHeight = drawer.offsetHeight || savedDrawerHeight;
      drawer.classList.add('closed');
      drawer.style.height = '';
    }
    setTimeout(() => {
      if (editorLeft && editorLeft.layout) editorLeft.layout();
      if (editorRight && editorRight.layout) editorRight.layout();
    }, 200);
  };

  if (drawerToggle) drawerToggle.addEventListener('click', (e) => {
    // Don't toggle if user grabbed the resizer handle
    if (e.target.closest('.drawer-resizer')) return;
    if (e.target.closest('#btn-clear-logs')) return;
    if (e.target.closest('#btn-collapse-toggle')) {
      toggleDrawer();
      return;
    }
    toggleDrawer();
  });
  if (toggleConsoleBtn) toggleConsoleBtn.addEventListener('click', toggleDrawer);

  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', (e) => {
      e.stopPropagation();
      const output = document.getElementById('console-output');
      if (output) output.innerHTML = '';
      const count = document.getElementById('log-count');
      if (count) count.textContent = '0 messages';
    });
  }
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${filename}`, 'success');
}

// ============================================================================
// 8. ON DOM READY
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  initSplitter();
  setupEventListeners();
  initMonaco();
  checkServerHealth();
});
