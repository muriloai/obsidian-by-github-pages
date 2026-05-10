/** Incrementar ao mudar lógica — verificar no console (F12) se o deploy está atualizado. */
const APP_BUILD = '2026-05-10-v13';

const TREE_SEARCH_DEBOUNCE_MS = 200;
/** Autocomplete tipo Obsidian [[ — mínimo de caracteres após [[ */
const WIKI_LINK_MIN_CHARS = 2;

const UI_EDITOR_EMPTY_TITLE =
  'Editor | selecione um arquivo na lista ao lado';

/**
 * Configuração
 * CLIENT_ID: credencial OAuth "Aplicação Web" (GCP).
 * BRAIN_FOLDER_ID: ID na URL do Drive (.../folders/ESTE_ID) ou use ?folder=ID na página.
 *
 * GCP: inclua em "URIs de redirecionamento autorizados" → https://muriloai.github.io
 * (e http://localhost:PORTA para testes locais).
 */
const CONFIG = {
  CLIENT_ID:
    '1096778565225-ucf7kcnrap9qnledd3cbugdoi5t3k1hc.apps.googleusercontent.com',
  /**
   * Pasta do vault Obsidian no Drive (não a pasta pai que a envolve).
   * Pai: …/folders/1JjM7_QtmkLaQgMMEmfclobsMVZhGzX61
   * Vault Obsidian (use este ID): …/folders/1vTkjJSKbVZ1Swn7jfoh3IrJuG3E8Shhz
   */
  BRAIN_FOLDER_ID: '1vTkjJSKbVZ1Swn7jfoh3IrJuG3E8Shhz',
  /** Se a pasta estiver em um drive compartilhado (Google Workspace), use true. */
  BRAIN_IN_SHARED_DRIVE: false,
  /** Obsidian: arquivos .md em subpastas — listar tudo de forma recursiva (recomendado). */
  LIST_MD_RECURSIVE: true,
};

const SCOPES =
  'openid email profile https://www.googleapis.com/auth/drive';

/** Depois da primeira listagem no Drive ok, próximos logins podem ser mais silenciosos. */
const LS_DRIVE_LIST_OK = 'brain-drive-drive-list-ok-v1';

const state = {
  accessToken: null,
  currentFile: null,
  dirty: false,
  didInitialLoadAfterAuth: false,
  tokenClient: null,
  easyMDE: null,
  loadingFile: false,
  /** Depois de "Autorizar Google Drive": novo token e nova tentativa de listar. */
  wantRefreshAfterToken: false,
  /** Última lista completa do Drive (para busca sem novo request). */
  lastFileList: [],
  /** Nome para o cabeçalho da sidebar (OAuth userinfo). */
  userDisplayName: '',
  /** fileId → linhas de sugestão wiki (nome do ficheiro + aliases YAML). */
  aliasHintsByFileId: new Map(),
};

const MSG_RELOAD_FROM_DRIVE =
  'Recarregar substitui o texto pela última versão salva no Google Drive.\n\n' +
  'As alterações feitas neste editor e ainda não salvas com o botão Salvar serão perdidas.\n\n' +
  'Continuar?';

const MSG_SWITCH_NOTE_UNSAVED =
  'Esta nota tem alterações não salvas.\n\n' +
  'Ao abrir outra nota, essas alterações serão descartadas (use Salvar antes se precisar enviar ao Drive).\n\n' +
  'Continuar?';

const tokenWaiters = [];

/** GIS pode não chamar o callback (popup fechado, rede) — evita lista/spinner presos. */
const TOKEN_REQUEST_TIMEOUT_MS = 75000;

/** Listagem recursiva sem resposta (rede/API) — não deixa o spinner eterno. */
const LIST_MD_TIMEOUT_MS = 120000;

let tokenRequestTimer = null;

function clearTokenRequestTimer() {
  if (tokenRequestTimer != null) {
    clearTimeout(tokenRequestTimer);
    tokenRequestTimer = null;
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const el = {
  userName: null,
  fileTree: null,
  fileListEmpty: null,
  btnLogin: null,
  btnLogout: null,
  btnSave: null,
  btnReloadFile: null,
  btnTheme: null,
  saveStatus: null,
  btnReauthDrive: null,
  editorFileTitle: null,
  sidebar: null,
  sidebarHead: null,
  listLoadingSpinner: null,
  treeSearch: null,
};

let saveStatusClearTimer = null;

function setEditorFileTitle(label) {
  if (!el.editorFileTitle) return;
  el.editorFileTitle.textContent = label || UI_EDITOR_EMPTY_TITLE;
}

function hasOAuthClientConfigured() {
  const id = (CONFIG.CLIENT_ID || '').trim();
  return (
    Boolean(id) &&
    !/^SEU_CLIENT_ID\b/i.test(id) &&
    id.endsWith('.apps.googleusercontent.com')
  );
}

/** ID da pasta no Drive (constante em CONFIG ou ?folder= / #folder= na URL). */
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

/** Windows / syncs às vezes usam "\"; o Drive no site usa "/". */
function normalizePathLabel(label) {
  return String(label || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

function setSaveStatus(text, options = {}) {
  const { autoClearMs } = options;
  if (el.saveStatus) el.saveStatus.textContent = text || '';
  if (saveStatusClearTimer != null) {
    clearTimeout(saveStatusClearTimer);
    saveStatusClearTimer = null;
  }
  if (autoClearMs != null && autoClearMs > 0 && text) {
    const cleared = text;
    saveStatusClearTimer = setTimeout(() => {
      saveStatusClearTimer = null;
      if (el.saveStatus && el.saveStatus.textContent === cleared) {
        el.saveStatus.textContent = '';
      }
    }, autoClearMs);
  }
}

function updateSidebarSectionTitle() {
  if (!el.sidebarHead) return;
  const name = (state.userDisplayName || '').trim();
  el.sidebarHead.textContent = name
    ? `Notas (.md) | ${name}`
    : 'Notas (.md)';
}

function setListLoading(active) {
  if (el.listLoadingSpinner) {
    el.listLoadingSpinner.hidden = !active;
    el.listLoadingSpinner.setAttribute('aria-busy', active ? 'true' : 'false');
  }
  if (el.sidebar) el.sidebar.classList.toggle('sidebar--loading', active);
}

function debounce(fn, ms) {
  let t;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Parte do link Obsidian antes de `|` em [[nota|texto]]. */
function wikiLinkQuerySegment(raw) {
  return String(raw || '').split('|')[0].trim();
}

function stripYamlQuotes(s) {
  let t = String(s || '').trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1);
  }
  return t.trim();
}

/** Extrai aliases do frontmatter YAML (Obsidian). */
function extractAliasesFromMarkdown(text) {
  const out = [];
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return out;
  const fm = m[1];

  const aliasSingle = fm.match(/^alias:\s*(.+)$/m);
  if (aliasSingle) out.push(stripYamlQuotes(aliasSingle[1]));

  const lines = fm.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ma = line.match(/^aliases:\s*(.*)$/);
    if (!ma) {
      i++;
      continue;
    }
    const rest = ma[1].trim();
    if (rest.startsWith('[')) {
      const close = rest.lastIndexOf(']');
      const open = rest.indexOf('[');
      if (close > open) {
        rest
          .slice(open + 1, close)
          .split(',')
          .forEach((p) => {
            const t = stripYamlQuotes(p.trim());
            if (t) out.push(t);
          });
        i++;
        continue;
      }
      const joined = lines.slice(i).join('\n');
      const blk = joined.match(/^aliases:\s*\[([\s\S]*?)\]\s*$/m);
      if (blk) {
        blk[1].split(',').forEach((p) => {
          const t = stripYamlQuotes(p.trim());
          if (t) out.push(t);
        });
      }
      break;
    }
    if (rest === '') {
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        out.push(stripYamlQuotes(lines[i].replace(/^\s+-\s+/, '').trim()));
        i++;
      }
      continue;
    }
    out.push(stripYamlQuotes(rest));
    i++;
  }

  return [...new Set(out.map((s) => String(s).trim()).filter(Boolean))];
}

async function getFileContentHead(fileId, maxBytes = 32768) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media`;
  let res = await driveFetch(url, {
    headers: { Range: `bytes=0-${maxBytes - 1}` },
  });
  if (res.status === 416 || res.status === 404) {
    res = await driveFetch(url);
  }
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

function registerFileAliasesFromContent(file, text, targetMap = state.aliasHintsByFileId) {
  const label = normalizePathLabel(file._listLabel || file.name);
  const stem = (label.split('/').pop() || '')
    .replace(/\.md$/i, '')
    .trim();
  if (!stem) return;

  const aliases = extractAliasesFromMarkdown(text);
  const rows = [];
  const addTerm = (term) => {
    const t = String(term || '').trim().toLowerCase();
    if (!t) return;
    rows.push({ stem, label, term: t });
  };
  addTerm(stem);
  for (const a of aliases) addTerm(a);
  targetMap.set(file.id, rows);
}

/** Após listar o vault: lê só o início de cada .md para aliases e nomes. */
async function indexVaultWikiHints() {
  const files = state.lastFileList || [];
  const built = new Map();
  const batchSize = 6;
  for (let j = 0; j < files.length; j += batchSize) {
    const slice = files.slice(j, j + batchSize);
    await Promise.all(
      slice.map(async (f) => {
        if (!f?.id) return;
        try {
          const text = await getFileContentHead(f.id);
          registerFileAliasesFromContent(f, text, built);
        } catch (_) {
          /* nota inacessível ou sem frontmatter */
        }
      })
    );
  }
  state.aliasHintsByFileId = built;
  const cf = state.currentFile;
  const editorTxt = state.easyMDE?.value();
  if (cf?.id && typeof editorTxt === 'string') {
    registerFileAliasesFromContent(cf, editorTxt);
  }
}

/** Nomes de notas (.md) + aliases YAML — usa lista do Drive e índice em aliasHintsByFileId. */
function buildWikiSuggestions(queryRaw) {
  const ql = wikiLinkQuerySegment(queryRaw).toLowerCase();
  if (ql.length < WIKI_LINK_MIN_CHARS) return [];

  const seen = new Set();
  const raw = [];
  const push = (stem, label) => {
    const k = `${stem.toLowerCase()}\0${label}`;
    if (seen.has(k)) return;
    seen.add(k);
    raw.push({ stem, label });
  };

  for (const f of state.lastFileList || []) {
    const label = normalizePathLabel(f._listLabel || f.name);
    const stem = (label.split('/').pop() || '')
      .replace(/\.md$/i, '')
      .trim();
    if (!stem) continue;
    const blob = `${stem} ${label}`.toLowerCase();
    if (!blob.includes(ql)) continue;
    push(stem, label);
  }

  for (const rows of state.aliasHintsByFileId.values()) {
    for (const row of rows) {
      if (!row.term.includes(ql)) continue;
      push(row.stem, row.label);
    }
  }

  raw.sort((a, b) =>
    a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' })
  );

  const stemCount = new Map();
  for (const r of raw) {
    const k = r.stem.toLowerCase();
    stemCount.set(k, (stemCount.get(k) || 0) + 1);
  }

  return raw.slice(0, 45).map((r) => {
    const dup = (stemCount.get(r.stem.toLowerCase()) || 0) > 1;
    const needsPath = dup || r.label.includes('/');
    return {
      text: r.stem,
      displayText: needsPath ? `${r.stem} — ${r.label}` : r.stem,
    };
  });
}

function wikiLinkHint(cm) {
  const CM = typeof CodeMirror !== 'undefined' ? CodeMirror : cm.constructor;
  const Pass = CM.Pass;
  const Pos = CM.Pos;

  const cur = cm.getCursor();
  const line = cm.getLine(cur.line);
  const before = line.slice(0, cur.ch);
  const match = before.match(/\[\[([^\[\]]*)$/);
  if (!match) return Pass;
  const qRaw = match[1];
  if (wikiLinkQuerySegment(qRaw).length < WIKI_LINK_MIN_CHARS) return Pass;

  const items = buildWikiSuggestions(qRaw);
  if (!items.length) return Pass;

  const innerStart = before.lastIndexOf('[[') + 2;

  return {
    from: Pos(cur.line, innerStart),
    to: cur,
    list: items.map((it) => ({
      text: it.text,
      displayText: it.displayText,
    })),
  };
}

function attachWikiLinkAutocomplete(cm) {
  const CM = typeof CodeMirror !== 'undefined' ? CodeMirror : cm.constructor;
  if (!CM || typeof CM.showHint !== 'function') return;

  const triggerWiki = debounce(() => {
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line);
    const before = line.slice(0, cur.ch);
    if (!/\[\[([^\[\]]*)$/.test(before)) return;
    const m = before.match(/\[\[([^\[\]]*)$/);
    if (!m) return;
    if (wikiLinkQuerySegment(m[1]).length < WIKI_LINK_MIN_CHARS) return;
    CM.showHint(cm, wikiLinkHint, { completeSingle: false });
  }, 90);

  cm.on('inputRead', triggerWiki);
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
  clearTokenRequestTimer();
  if (resp.error) {
    console.error('Erro GIS:', resp);
    state.wantRefreshAfterToken = false;
    tokenWaiters.splice(0).forEach((w) => w.reject(new Error(resp.error)));
    return;
  }
  state.accessToken = resp.access_token;
  console.log('access_token', resp.access_token);
  tokenWaiters.splice(0).forEach((w) => w.resolve(resp.access_token));

  if (!state.didInitialLoadAfterAuth) {
    state.didInitialLoadAfterAuth = true;
    void bootstrapAfterAuth();
  } else if (state.wantRefreshAfterToken) {
    state.wantRefreshAfterToken = false;
    void retryListAfterReauth();
  }
}

/** Novo token após autorizar o Drive — tentar listar de novo. */
async function retryListAfterReauth() {
  try {
    setSaveStatus('Atualizando permissões…');
    await refreshFileList();
    setSaveStatus('');
    if (el.btnReauthDrive) el.btnReauthDrive.hidden = true;
  } catch (e) {
    console.error(e);
    const msg = e.message || String(e);
    setSaveStatus(msg);
    if (el.fileListEmpty) {
      el.fileListEmpty.hidden = false;
      el.fileListEmpty.textContent = msg;
    }
  }
}

function requestAccessToken() {
  return new Promise((resolve, reject) => {
    clearTokenRequestTimer();
    tokenWaiters.push({ resolve, reject });
    tokenRequestTimer = setTimeout(() => {
      tokenRequestTimer = null;
      const pending = tokenWaiters.splice(0);
      const err = new Error(
        'Tempo esgotado ao obter autorização Google. Use Entrar com Google de novo.'
      );
      pending.forEach((w) => w.reject(err));
    }, TOKEN_REQUEST_TIMEOUT_MS);
    state.tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function bootstrapAfterAuth() {
  try {
    await loadUserProfile();
    el.btnLogin.hidden = true;
    el.btnLogout.hidden = false;
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao carregar o perfil. Saia e entre de novo.');
    return;
  }

  try {
    await refreshFileList();
    setSaveStatus('');
    if (el.btnReauthDrive) el.btnReauthDrive.hidden = true;
  } catch (e) {
    console.error(e);
    const msg =
      e.message ||
      'Não foi possível listar os arquivos no Google Drive. Veja a mensagem abaixo.';
    setSaveStatus(msg);
    if (el.fileListEmpty) {
      el.fileListEmpty.hidden = false;
      el.fileListEmpty.textContent = msg;
    }
    if (el.btnReauthDrive)
      el.btnReauthDrive.hidden = !shouldShowReauthButton(msg);
  }
}

function explainDriveListFailure(status, bodyText) {
  let raw = bodyText || '';
  try {
    const j = JSON.parse(raw);
    const err = j.error || {};
    const reason = err.errors?.[0]?.reason || '';
    const msg = err.message || '';

    if (
      /Drive API has not been used|SERVICE_DISABLED|accessNotConfigured/i.test(
        msg + reason
      )
    ) {
      return (
        'Ative a API "Google Drive API" no Google Cloud Console, no mesmo projeto do Client ID ' +
        '(APIs e serviços → Biblioteca → Google Drive API → Ativar).'
      );
    }

    if (
      reason === 'insufficientPermissions' ||
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT|Request had insufficient authentication scopes/i.test(
        msg
      )
    ) {
      return (
        'Falta permissão para o Google Drive. Clique em "Autorizar Google Drive" ou remova o acesso a este app em ' +
        'https://myaccount.google.com/permissions e entre de novo para aceitar todas as permissões.'
      );
    }

    if (status === 404 || reason === 'notFound') {
      return (
        'Pasta não encontrada ou sem acesso. Confira o ID (BRAIN_FOLDER_ID ou ?folder= na URL).'
      );
    }

    if (status === 403 && /cannotDownload/i.test(msg)) {
      return 'Sem permissão para ler esta pasta. Confirme se esta conta tem acesso no Drive.';
    }

    return msg || raw.slice(0, 240) || `Erro HTTP ${status}`;
  } catch (_) {
    return raw.slice(0, 240) || `Erro HTTP ${status}`;
  }
}

function shouldShowReauthButton(message) {
  return /Autorizar Google Drive|Autorizar Drive|permissão|scope|Falta permissão/i.test(
    message
  );
}

async function loadUserProfile() {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${state.accessToken}` },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(
      `Perfil do Google (${res.status}). Confirme os escopos openid/perfil e um token válido. ${t.slice(0, 120)}`
    );
  }
  const data = await res.json();
  state.userDisplayName = data.name || data.email || '';
  el.userName.textContent = state.userDisplayName;
  updateSidebarSectionTitle();
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

/** Lista tudo que está diretamente dentro de uma pasta (arquivos e subpastas), com paginação. */
async function listAllItemsInFolder(pageParentId) {
  const q = `'${pageParentId}' in parents and trashed = false`;
  const out = [];
  let pageToken;
  const fields = 'nextPageToken, files(id, name, mimeType, modifiedTime)';

  do {
    const params = new URLSearchParams({
      q,
      fields,
      pageSize: '100',
    });
    if (CONFIG.BRAIN_IN_SHARED_DRIVE) {
      params.set('supportsAllDrives', 'true');
      params.set('includeItemsFromAllDrives', 'true');
      params.set('corpora', 'allDrives');
    }
    if (pageToken) params.set('pageToken', pageToken);

    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(explainDriveListFailure(res.status, body));
    }
    const data = await res.json();
    out.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return out;
}

/** Percorre subpastas e junta .md (vault Obsidian típico). */
async function listMdRecursive(rootFolderId) {
  const mdFiles = [];
  const visited = new Set();

  async function walk(folderId, pathPrefix) {
    if (visited.has(folderId)) return;
    visited.add(folderId);

    const items = await listAllItemsInFolder(folderId);
    for (const item of items) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const seg = item.name || 'pasta';
        await walk(item.id, `${pathPrefix}${seg}/`);
      } else if (item.name && item.name.toLowerCase().endsWith('.md')) {
        mdFiles.push({
          ...item,
          _listLabel: `${pathPrefix}${item.name}`,
        });
      }
    }
  }

  await walk(rootFolderId, '');
  return mdFiles;
}

/** Somente .md no nível direto da pasta Brain (modo legado). */
async function listMdShallowOnly(brainFolderId) {
  const items = await listAllItemsInFolder(brainFolderId);
  return items.filter(
    (f) => f.name && f.name.toLowerCase().endsWith('.md')
  );
}

async function listMdInBrainFolder() {
  const folderId = getBrainFolderId();
  if (!folderId) return [];
  if (CONFIG.LIST_MD_RECURSIVE) {
    return listMdRecursive(folderId);
  }
  return listMdShallowOnly(folderId);
}

/** Monta árvore de pastas a partir dos caminhos `_listLabel` (ex.: Pasta/nota.md). */
function buildFolderTree(files) {
  const root = { kind: 'folder', name: '', children: [] };

  function getOrCreateFolder(parent, name) {
    let f = parent.children.find(
      (c) => c.kind === 'folder' && c.name === name
    );
    if (!f) {
      f = { kind: 'folder', name, children: [] };
      parent.children.push(f);
    }
    return f;
  }

  const sorted = files.slice().sort((a, b) => {
    const la = normalizePathLabel(a._listLabel || a.name);
    const lb = normalizePathLabel(b._listLabel || b.name);
    return la.localeCompare(lb, 'pt-BR', { sensitivity: 'base' });
  });

  for (const file of sorted) {
    const label = normalizePathLabel(file._listLabel || file.name);
    const parts = label.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      if (i === parts.length - 1) {
        parent.children.push({ kind: 'file', name: seg, file });
      } else {
        parent = getOrCreateFolder(parent, seg);
      }
    }
  }

  sortFolderTree(root);
  return root;
}

function sortFolderTree(node) {
  if (node.kind !== 'folder') return;
  const folders = node.children.filter((c) => c.kind === 'folder');
  const fileNodes = node.children.filter((c) => c.kind === 'file');
  folders.sort((a, b) =>
    a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })
  );
  fileNodes.sort((a, b) =>
    a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })
  );
  node.children = [...folders, ...fileNodes];
  folders.forEach(sortFolderTree);
}

/** Sem busca: primeiros níveis de pasta abertos. Com busca: tudo aberto para ver resultados. */
const TREE_EXPAND_MAX_DEPTH = 4;

function renderTreeNode(node, container, depth, expandAll) {
  if (node.kind === 'file') {
    const li = document.createElement('li');
    li.className = 'tree-file';
    li.setAttribute('role', 'none');
    const btn = document.createElement('button');
    btn.type = 'button';
    const ic = document.createElement('span');
    ic.className = 'tree-file-icon fa fa-file-text-o';
    ic.setAttribute('aria-hidden', 'true');
    btn.appendChild(ic);
    btn.appendChild(document.createTextNode(node.name));
    if (state.currentFile?.id === node.file.id) btn.classList.add('is-active');
    btn.addEventListener('click', () => void selectFile(node.file, btn));
    li.appendChild(btn);
    container.appendChild(li);
    return;
  }

  const li = document.createElement('li');
  li.className = 'tree-folder';
  const details = document.createElement('details');
  details.open =
    expandAll || depth < TREE_EXPAND_MAX_DEPTH;
  const summary = document.createElement('summary');
  const fIcon = document.createElement('span');
  fIcon.className = 'tree-folder-icon fa fa-folder-o';
  fIcon.setAttribute('aria-hidden', 'true');
  summary.appendChild(fIcon);
  summary.appendChild(document.createTextNode(node.name));
  details.appendChild(summary);
  const ul = document.createElement('ul');
  ul.className = 'tree-children';
  ul.setAttribute('role', 'group');
  node.children.forEach((child) =>
    renderTreeNode(child, ul, depth + 1, expandAll)
  );
  details.appendChild(ul);
  li.appendChild(details);
  container.appendChild(li);
}

function renderFileTree(files, options = {}) {
  const expandAll = Boolean(options.expandAll);
  const isFiltered = Boolean(options.isFiltered);

  el.fileTree.innerHTML = '';
  if (!files.length) {
    if (isFiltered) {
      el.fileListEmpty.hidden = true;
      const p = document.createElement('p');
      p.className = 'tree-no-results';
      p.textContent = 'Nenhum arquivo corresponde à busca.';
      el.fileTree.appendChild(p);
      return;
    }
    el.fileListEmpty.hidden = false;
    el.fileListEmpty.textContent =
      'Nenhum .md nesta pasta do vault (incluindo subpastas). Confira o ID da pasta no Drive ou onde estão os arquivos.';
    return;
  }

  el.fileListEmpty.hidden = true;
  const root = buildFolderTree(files);
  const ul = document.createElement('ul');
  ul.className = 'tree-root';
  ul.setAttribute('role', 'group');
  root.children.forEach((child) =>
    renderTreeNode(child, ul, 0, expandAll)
  );
  el.fileTree.appendChild(ul);
}

function applyTreeFilter() {
  const q = (el.treeSearch?.value || '').trim();
  const all = state.lastFileList || [];
  if (!q) {
    renderFileTree(all, { expandAll: false, isFiltered: false });
    return;
  }
  const ql = q.toLowerCase();
  const filtered = all.filter((f) => {
    const label = normalizePathLabel(f._listLabel || f.name).toLowerCase();
    return label.includes(ql);
  });
  renderFileTree(filtered, { expandAll: true, isFiltered: true });
}

async function refreshFileList() {
  if (!hasOAuthClientConfigured()) {
    el.fileListEmpty.hidden = false;
    el.fileListEmpty.textContent =
      'CLIENT_ID inválido no app.js.';
    el.fileTree.innerHTML = '';
    return;
  }
  if (!hasBrainFolderConfigured()) {
    el.fileListEmpty.hidden = false;
    el.fileListEmpty.textContent =
      'Defina BRAIN_FOLDER_ID no app.js ou abra com ?folder=ID_DA_PASTA (URL do Drive …/folders/ID).';
    el.fileTree.innerHTML = '';
    return;
  }
  setListLoading(true);
  setSaveStatus('Carregando lista…');
  try {
    const files = await withTimeout(
      listMdInBrainFolder(),
      LIST_MD_TIMEOUT_MS,
      'Tempo esgotado ao listar o Drive. Verifique a rede e use Recarregar.'
    );
    state.lastFileList = files;
    if ((el.treeSearch?.value || '').trim()) {
      applyTreeFilter();
    } else {
      renderFileTree(files, { expandAll: false, isFiltered: false });
    }
    void indexVaultWikiHints().catch((e) =>
      console.warn('[Brain Drive] índice wiki', e)
    );
    setSaveStatus('');
    localStorage.setItem(LS_DRIVE_LIST_OK, '1');
  } finally {
    setListLoading(false);
  }
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

async function saveCurrentFile() {
  if (!state.currentFile || !state.easyMDE) return;
  const content = state.easyMDE.value();
  setSaveStatus('Salvando…');
  await patchFileContents(
    state.currentFile.id,
    state.currentFile.name,
    content
  );
  state.dirty = false;
  setSaveStatus('Salvo', { autoClearMs: 3200 });
}

async function reloadCurrentFileFromDrive() {
  if (!state.currentFile || !state.easyMDE) return;
  if (state.dirty) {
    const ok = window.confirm(MSG_RELOAD_FROM_DRIVE);
    if (!ok) return;
  }
  setSaveStatus('Recarregando…');
  try {
    const text = await getFileContent(state.currentFile.id);
    state.loadingFile = true;
    state.easyMDE.value(text);
    queueMicrotask(() => {
      state.loadingFile = false;
      state.dirty = false;
    });
    registerFileAliasesFromContent(state.currentFile, text);
    setSaveStatus('Recarregado do Drive', { autoClearMs: 4200 });
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao recarregar');
  }
}

async function selectFile(file, btnEl) {
  try {
    if (
      state.dirty &&
      state.currentFile &&
      state.currentFile.id !== file.id
    ) {
      const ok = window.confirm(MSG_SWITCH_NOTE_UNSAVED);
      if (!ok) return;
    }

    if (el.fileTree) {
      el.fileTree.querySelectorAll('.tree-file button').forEach((b) =>
        b.classList.remove('is-active')
      );
      if (btnEl) btnEl.classList.add('is-active');
    }

    state.currentFile = file;
    setEditorFileTitle(file._listLabel || file.name);
    setSaveStatus('Abrindo…');
    const text = await getFileContent(file.id);
    registerFileAliasesFromContent(file, text);
    state.loadingFile = true;
    state.easyMDE.value(text);
    queueMicrotask(() => {
      state.loadingFile = false;
      state.dirty = false;
    });
    el.btnSave.disabled = false;
    if (el.btnReloadFile) el.btnReloadFile.disabled = false;
    setSaveStatus('');
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao abrir o arquivo');
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
    navigator.serviceWorker
      .register(new URL('./sw.js?v=13', window.location.href), {
        scope: './',
      })
      .catch((e) => console.warn('Service Worker:', e));
  };
  if (document.readyState === 'complete') onReady();
  else window.addEventListener('load', onReady);
}

function logout() {
  clearTokenRequestTimer();
  tokenWaiters.splice(0).forEach((w) =>
    w.reject(new Error('Sessão encerrada'))
  );
  state.accessToken = null;
  state.currentFile = null;
  state.dirty = false;
  state.wantRefreshAfterToken = false;
  state.didInitialLoadAfterAuth = false;
  state.lastFileList = [];
  state.userDisplayName = '';
  state.aliasHintsByFileId = new Map();
  el.userName.textContent = '';
  if (el.treeSearch) el.treeSearch.value = '';
  el.fileTree.innerHTML = '';
  el.fileListEmpty.hidden = false;
  el.fileListEmpty.textContent =
    'Faça login para ver os arquivos.';
  el.btnLogin.hidden = false;
  el.btnLogout.hidden = true;
  if (el.btnReauthDrive) el.btnReauthDrive.hidden = true;
  el.btnSave.disabled = true;
  if (el.btnReloadFile) el.btnReloadFile.disabled = true;
  setSaveStatus('');
  setListLoading(false);
  setEditorFileTitle(null);
  updateSidebarSectionTitle();
  if (state.easyMDE) state.easyMDE.value('');
}

function bindUi() {
  el.userName = document.getElementById('user-name');
  el.fileTree = document.getElementById('file-tree');
  el.fileListEmpty = document.getElementById('file-list-empty');
  el.btnLogin = document.getElementById('btn-google-login');
  el.btnLogout = document.getElementById('btn-logout');
  el.btnSave = document.getElementById('btn-save');
  el.btnReloadFile = document.getElementById('btn-reload-file');
  el.btnTheme = document.getElementById('btn-theme');
  el.saveStatus = document.getElementById('save-status');
  el.btnReauthDrive = document.getElementById('btn-reauth-drive');
  el.editorFileTitle = document.getElementById('editor-file-title');
  el.sidebar = document.getElementById('sidebar');
  el.sidebarHead = document.getElementById('sidebar-section-title');
  el.listLoadingSpinner = document.getElementById('list-loading-spinner');
  el.treeSearch = document.getElementById('tree-search');

  initTheme();
  updateSidebarSectionTitle();

  el.btnTheme.addEventListener('click', toggleTheme);

  if (el.treeSearch) {
    const runSearch = debounce(() => applyTreeFilter(), TREE_SEARCH_DEBOUNCE_MS);
    el.treeSearch.addEventListener('input', runSearch);
    el.treeSearch.addEventListener('search', () => applyTreeFilter());
  }

  if (el.btnReauthDrive) {
    el.btnReauthDrive.addEventListener('click', () => {
      if (!state.tokenClient) return;
      state.wantRefreshAfterToken = true;
      state.tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  }

  el.btnLogin.addEventListener('click', () => {
    if (!hasOAuthClientConfigured()) {
      window.alert(
        'Defina um CLIENT_ID OAuth (aplicativo Web) válido em CONFIG no app.js.'
      );
      return;
    }
    const silentOk = localStorage.getItem(LS_DRIVE_LIST_OK) === '1';
    state.tokenClient.requestAccessToken({
      prompt: silentOk ? '' : 'consent',
    });
  });

  el.btnLogout.addEventListener('click', logout);

  el.btnSave.addEventListener('click', () => {
    void saveCurrentFile().catch((e) => {
      console.error(e);
      setSaveStatus('Erro ao salvar');
    });
  });

  if (el.btnReloadFile) {
    el.btnReloadFile.addEventListener('click', () => {
      void reloadCurrentFileFromDrive();
    });
  }

  state.easyMDE = new EasyMDE({
    element: document.getElementById('markdown-editor'),
    spellChecker: false,
    status: false,
    placeholder: 'Selecione um arquivo .md na lista ao lado.',
    /* Font Awesome 4 já é carregado no index.html (CDN); evita duplicar ou falhar no auto-download */
    autoDownloadFontAwesome: false,
  });

  state.easyMDE.codemirror.on('change', () => {
    if (state.loadingFile || !state.currentFile) return;
    state.dirty = true;
    setSaveStatus('Alterações não salvas');
  });

  attachWikiLinkAutocomplete(state.easyMDE.codemirror);

  setListLoading(false);
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', () => {
  console.info('[Brain Drive] build', APP_BUILD);
  bindUi();
  whenGsiReady(() => {
    initTokenClient();
    if (el.btnLogin) el.btnLogin.disabled = false;
  });
});
