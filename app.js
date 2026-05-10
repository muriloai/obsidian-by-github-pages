/**
 * Configuração
 * CLIENT_ID: credencial OAuth "Aplicação Web" (GCP).
 * BRAIN_FOLDER_ID: ID na URL do Drive (.../folders/ESTE_ID), ou omita e use ?folder=ID na página.
 *
 * GCP: acrescentar em "URIs de redirecionamento autorizados" → https://muriloai.github.io
 * (mantém também http://localhost:PORT para desenvolvimento local).
 */
const CONFIG = {
  CLIENT_ID:
    '1096778565225-ucf7kcnrap9qnledd3cbugdoi5t3k1hc.apps.googleusercontent.com',
  BRAIN_FOLDER_ID: '1vTkjJSKbVZ1Swn7jfoh3IrJuG3E8Shhz',
};

const SCOPES =
  'openid email profile https://www.googleapis.com/auth/drive';

const AUTOSAVE_MS = 2000;

const state = {
  accessToken: null,
  currentFile: null,
  dirty: false,
  didInitialLoadAfterAuth: false,
  autosaveTimer: null,
  tokenClient: null,
  easyMDE: null,
  loadingFile: false,
};

const tokenWaiters = [];

const el = {
  userName: null,
  fileList: null,
  fileListEmpty: null,
  btnLogin: null,
  btnLogout: null,
  btnSave: null,
  btnTheme: null,
  saveStatus: null,
};

function hasOAuthClientConfigured() {
  const id = (CONFIG.CLIENT_ID || '').trim();
  return (
    Boolean(id) &&
    !/^SEU_CLIENT_ID\b/i.test(id) &&
    id.endsWith('.apps.googleusercontent.com')
  );
}

/** ID da pasta no Drive (constante ou ?folder= / #folder= sem commit). */
function getBrainFolderId() {
  let fromUrl =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('folder')
      : null;
  if (!fromUrl && typeof window !== 'undefined' && window.location.hash.length > 1) {
    fromUrl = new URLSearchParams(
      window.location.hash.replace(/^#\??/, '')
    ).get('folder');
  }
  const raw = ((fromUrl && fromUrl.trim()) || CONFIG.BRAIN_FOLDER_ID || '').trim();
  if (!raw || raw === 'SEU_FOLDER_ID') return '';
  return raw;
}

function hasBrainFolderConfigured() {
  return Boolean(getBrainFolderId());
}

function setSaveStatus(text) {
  if (el.saveStatus) el.saveStatus.textContent = text || '';
}

function whenGsiReady(cb) {
  if (window.google?.accounts?.oauth2) {
    cb();
    return;
  }
  const t = setInterval(() => {
    if (window.google?.accounts?.oauth2) {
      clearInterval(t);
      cb();
    }
  }, 50);
}

function initTokenClient() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES,
    callback: handleTokenResponse,
  });
}

function handleTokenResponse(resp) {
  if (resp.error) {
    console.error('Erro GIS:', resp);
    tokenWaiters.splice(0).forEach((w) => w.reject(new Error(resp.error)));
    return;
  }
  state.accessToken = resp.access_token;
  console.log('access_token', resp.access_token);
  tokenWaiters.splice(0).forEach((w) => w.resolve(resp.access_token));

  if (!state.didInitialLoadAfterAuth) {
    state.didInitialLoadAfterAuth = true;
    void bootstrapAfterAuth();
  }
}

function requestAccessToken() {
  return new Promise((resolve, reject) => {
    tokenWaiters.push({ resolve, reject });
    state.tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function bootstrapAfterAuth() {
  try {
    await loadUserProfile();
    el.btnLogin.hidden = true;
    el.btnLogout.hidden = false;
    await refreshFileList();
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao carregar perfil ou lista');
  }
}

async function loadUserProfile() {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${state.accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo: ${res.status}`);
  const data = await res.json();
  el.userName.textContent = data.name || data.email || '';
}

async function driveFetch(url, options = {}) {
  const base = { ...options };
  const hdr = { ...(options.headers || {}) };
  hdr.Authorization = `Bearer ${state.accessToken}`;
  base.headers = hdr;

  let res = await fetch(url, base);
  if (res.status === 401) {
    state.accessToken = null;
    await requestAccessToken();
    hdr.Authorization = `Bearer ${state.accessToken}`;
    res = await fetch(url, base);
  }
  return res;
}

async function listMdInBrainFolder() {
  const folderId = getBrainFolderId();
  if (!folderId) return [];
  const q = `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const out = [];
  let pageToken;
  const fields = 'nextPageToken, files(id, name, mimeType, modifiedTime)';

  do {
    const params = new URLSearchParams({
      q,
      fields,
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`
    );
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    out.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return out.filter((f) => f.name && f.name.toLowerCase().endsWith('.md'));
}

function renderFileList(files) {
  el.fileList.innerHTML = '';
  if (!files.length) {
    el.fileListEmpty.hidden = false;
    el.fileListEmpty.textContent =
      'Nenhum ficheiro .md nesta pasta (ou permissões insuficientes).';
    return;
  }

  el.fileListEmpty.hidden = true;
  const frag = document.createDocumentFragment();

  files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .forEach((file) => {
      const li = document.createElement('li');
      li.dataset.id = file.id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = file.name;
      btn.addEventListener('click', () => void selectFile(file, li));
      li.appendChild(btn);
      frag.appendChild(li);
    });

  el.fileList.appendChild(frag);
}

async function refreshFileList() {
  if (!hasOAuthClientConfigured()) {
    el.fileListEmpty.hidden = false;
    el.fileListEmpty.textContent =
      'CLIENT_ID inválido em app.js.';
    el.fileList.innerHTML = '';
    return;
  }
  if (!hasBrainFolderConfigured()) {
    el.fileListEmpty.hidden = false;
    el.fileListEmpty.textContent =
      'Defina BRAIN_FOLDER_ID em app.js ou abra com ?folder=ID_DA_PASTA (URL do Drive …/folders/ID).';
    el.fileList.innerHTML = '';
    return;
  }
  setSaveStatus('A carregar lista…');
  const files = await listMdInBrainFolder();
  renderFileList(files);
  setSaveStatus('');
}

async function getFileContent(fileId) {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

function buildMultipartBody(fileName, content) {
  const boundary = `brain_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const meta = JSON.stringify({ name: fileName });
  const bodyParts = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n',
    '\r\n',
    meta,
    `\r\n--${boundary}\r\n`,
    'Content-Type: text/markdown; charset=UTF-8\r\n',
    '\r\n',
    content,
    `\r\n--${boundary}--`,
  ];
  return {
    boundary,
    body: bodyParts.join(''),
  };
}

async function patchFileContents(fileId, fileName, content) {
  const { boundary, body } = buildMultipartBody(fileName, content);
  const res = await driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(
      fileId
    )}?uploadType=multipart`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': `multipart/related; boundary="${boundary}"`,
      },
      body,
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `PATCH ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

async function saveCurrentFile({ silent } = {}) {
  if (!state.currentFile || !state.easyMDE) return;
  const content = state.easyMDE.value();
  if (!silent) setSaveStatus('A guardar…');
  await patchFileContents(
    state.currentFile.id,
    state.currentFile.name,
    content
  );
  state.dirty = false;
  if (!silent) setSaveStatus('Guardado');
}

function cancelAutosave() {
  if (state.autosaveTimer) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
}

function scheduleAutosave() {
  cancelAutosave();
  state.autosaveTimer = setTimeout(() => {
    state.autosaveTimer = null;
    void saveCurrentFile({ silent: true }).then(() => {
      setSaveStatus('Guardado (auto)');
    }).catch((e) => {
      console.error(e);
      setSaveStatus('Erro ao guardar');
    });
  }, AUTOSAVE_MS);
}

async function selectFile(file, liEl) {
  try {
    if (state.dirty && state.currentFile) {
      setSaveStatus('A guardar…');
      await saveCurrentFile({ silent: true });
    }

    [...el.fileList.querySelectorAll('li')].forEach((li) =>
      li.classList.remove('is-active')
    );
    liEl.classList.add('is-active');

    state.currentFile = file;
    setSaveStatus('A abrir…');
    const text = await getFileContent(file.id);
    state.loadingFile = true;
    state.easyMDE.value(text);
    queueMicrotask(() => {
      state.loadingFile = false;
      state.dirty = false;
    });
    el.btnSave.disabled = false;
    setSaveStatus('');

    cancelAutosave();
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao abrir ficheiro');
  }
}

function initTheme() {
  const prefersDark =
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const stored = localStorage.getItem('brain-drive-theme');
  const dark =
    stored === 'dark' || (!stored && prefersDark);

  document.documentElement.classList.toggle('dark', dark);
}

function toggleTheme() {
  const dark = !document.documentElement.classList.contains('dark');
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('brain-drive-theme', dark ? 'dark' : 'light');

  try {
    if (state.easyMDE?.codemirror?.refresh)
      state.easyMDE.codemirror.refresh();
  } catch (_) {
    /* ignore */
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const onReady = () => {
    navigator.serviceWorker.register(new URL('./sw.js', window.location.href), {
      scope: './',
    }).catch((e) => console.warn('SW registar:', e));
  };
  if (document.readyState === 'complete') onReady();
  else window.addEventListener('load', onReady);
}

function logout() {
  cancelAutosave();
  state.accessToken = null;
  state.currentFile = null;
  state.dirty = false;
  state.didInitialLoadAfterAuth = false;
  el.userName.textContent = '';
  el.fileList.innerHTML = '';
  el.fileListEmpty.hidden = false;
  el.fileListEmpty.textContent =
    'Inicie sessão para ver os ficheiros.';
  el.btnLogin.hidden = false;
  el.btnLogout.hidden = true;
  el.btnSave.disabled = true;
  setSaveStatus('');
  if (state.easyMDE) state.easyMDE.value('');
}

function bindUi() {
  el.userName = document.getElementById('user-name');
  el.fileList = document.getElementById('file-list');
  el.fileListEmpty = document.getElementById('file-list-empty');
  el.btnLogin = document.getElementById('btn-google-login');
  el.btnLogout = document.getElementById('btn-logout');
  el.btnSave = document.getElementById('btn-save');
  el.btnTheme = document.getElementById('btn-theme');
  el.saveStatus = document.getElementById('save-status');

  initTheme();

  el.btnTheme.addEventListener('click', toggleTheme);

  el.btnLogin.addEventListener('click', () => {
    if (!hasOAuthClientConfigured()) {
      window.alert(
        'Defina um CLIENT_ID OAuth (Aplicação Web) válido em CONFIG em app.js.'
      );
      return;
    }
    state.tokenClient.requestAccessToken({ prompt: '' });
  });

  el.btnLogout.addEventListener('click', logout);

  el.btnSave.addEventListener('click', () => {
    cancelAutosave();
    void saveCurrentFile({ silent: false }).catch((e) => {
      console.error(e);
      setSaveStatus('Erro ao guardar');
    });
  });

  state.easyMDE = new EasyMDE({
    element: document.getElementById('editor-container'),
    spellChecker: false,
    status: ['lines', 'words', 'cursor'],
    placeholder: 'Selecione um ficheiro .md na lista…',
    autoDownloadFontAwesome: false,
  });

  state.easyMDE.codemirror.on('change', () => {
    if (state.loadingFile || !state.currentFile) return;
    state.dirty = true;
    setSaveStatus('Alterações pendentes');
    scheduleAutosave();
  });

  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  whenGsiReady(() => {
    initTokenClient();
    if (el.btnLogin) el.btnLogin.disabled = false;
  });
});
