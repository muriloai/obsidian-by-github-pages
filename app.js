/** Incrementar ao mudar lógica — verificar no console (F12) se o deploy está atualizado. */
const APP_BUILD = '2026-05-10-v28';

/** Valor do select «Alcance do mapa»: construir grafo com todas as notas (lento). */
const GRAPH_SCOPE_ALL = '__VAULT_ALL__';

const TREE_SEARCH_DEBOUNCE_MS = 200;
/** Autocomplete tipo Obsidian [[ — mínimo de caracteres após [[ (1 = já após uma letra) */
const WIKI_LINK_MIN_CHARS = 1;

const UI_EDITOR_EMPTY_TITLE =
  'Editor | abra uma nota pelo Mapa ou na lista ao lado';

/**
 * Configuração (repositório / GitHub Pages público)
 *
 * CLIENT_ID — Em apps só no browser (SPA), o ID OAuth é público por desenho (Google não trata
 * como segredo). O que protege: URIs de redirecionamento autorizadas no GCP, ecrã de consentimento,
 * e “utilizadores de teste” enquanto o app não está em produção. Nunca commits com CLIENT_SECRET
 * (só servidor); este projeto não usa secret no cliente.
 *
 * BRAIN_FOLDER_ID — Identifica uma pasta no Drive; não dá acesso sozinha: só contas com OAuth e
 * permissão nessa pasta/cDrive conseguem ler ou escrever.
 *
 * GCP: URIs autorizadas → https://muriloai.github.io … (e localhost para dev).
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
  /** 'editor' | 'graph' — abas Editor / Mapa */
  vaultMainTab: 'editor',
  /** Instância vis-network do mapa do vault */
  vaultGraphNetwork: null,
  vaultGraphBuilding: false,
  obsidianBookmarksRaw: null,
  obsidianGraphRaw: null,
  /** Caminhos normalizados vindos de .obsidian/bookmarks.json */
  obsidianBookmarkPaths: new Set(),
  /** Cache da extração [[…]] (invalidado quando a lista ou o conteúdo relevante mudam). */
  vaultGraphLinkCache: null,
  vaultGraphRefreshQueued: false,
  /** Evita reler .obsidian ao mudar só de aba Editor ↔ Mapa. */
  obsidianConfigsLoaded: false,
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const MSG_RELOAD_FROM_DRIVE =
  'Recarregar substitui o texto pela última versão salva no Google Drive.\n\n' +
  'As alterações feitas neste editor e ainda não salvas com o botão Salvar serão perdidas.\n\n' +
  'Continuar?';

const MSG_SWITCH_NOTE_UNSAVED =
  'Esta nota tem alterações não salvas.\n\n' +
  'Ao abrir outra nota, essas alterações serão descartadas (use Salvar antes se precisar enviar ao Drive).\n\n' +
  'Continuar?';

/** Caracteres não permitidos em nome de ficheiro no Windows / Drive. */
const INVALID_NOTE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

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
  statusTtlBar: null,
  statusTtlFill: null,
  tabEditor: null,
  tabGraph: null,
  panelEditor: null,
  panelGraph: null,
  graphNetwork: null,
  graphLoading: null,
  graphLoadingStatus: null,
  headerGraphStatus: null,
  btnCloseNote: null,
  btnDuplicateNote: null,
  btnDeleteNote: null,
  noteTitleBlock: null,
  noteTitleInput: null,
  graphBookmarkSelect: null,
};

let saveStatusClearTimer = null;
let graphResizeObserver = null;

function setHeaderGraphStatus(text) {
  if (el.headerGraphStatus) el.headerGraphStatus.textContent = text || '';
}

function clearHeaderGraphStatus() {
  setHeaderGraphStatus('');
}

function showGraphLoading(visible) {
  if (!el.graphLoading) return;
  el.graphLoading.hidden = !visible;
  el.graphLoading.setAttribute('aria-busy', visible ? 'true' : 'false');
}

function setGraphProgress(text) {
  if (el.graphLoadingStatus) el.graphLoadingStatus.textContent = text || '';
}

function syncEditorChromeVisibility() {
  const has = Boolean(state.currentFile);
  if (el.btnSave) el.btnSave.hidden = !has;
  if (el.btnReloadFile) el.btnReloadFile.hidden = !has;
  if (el.btnCloseNote) el.btnCloseNote.hidden = !has;
  if (el.btnDuplicateNote) el.btnDuplicateNote.hidden = !has;
  if (el.btnDeleteNote) el.btnDeleteNote.hidden = !has;
  if (el.noteTitleBlock) el.noteTitleBlock.hidden = !has;
  if (el.noteTitleInput && !has) el.noteTitleInput.value = '';
}

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

function noteStemFromFile(file) {
  if (!file) return '';
  const label = normalizePathLabel(file._listLabel || file.name);
  const base = label.split('/').pop() || file.name || '';
  return base.replace(/\.md$/i, '');
}

function sanitizeNoteFileStem(raw) {
  let s = String(raw || '')
    .trim()
    .replace(INVALID_NOTE_FILENAME_CHARS, '')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!s) s = 'sem-titulo';
  if (/^(con|prn|aux|nul)$/i.test(s) || /^com[1-9]$/i.test(s) || /^lpt[1-9]$/i.test(s))
    s = `${s}_`;
  return s.slice(0, 180);
}

function computeVaultListSignature(files) {
  if (!files?.length) return 'empty';
  return files
    .map((f) =>
      [
        f.id,
        f.modifiedTime || '',
        f.name || '',
        normalizePathLabel(f._listLabel || ''),
      ].join('\t')
    )
    .sort()
    .join('|');
}

function invalidateVaultGraphLinkCache() {
  state.vaultGraphLinkCache = null;
}

function invalidateObsidianConfigCache() {
  state.obsidianConfigsLoaded = false;
}

function updateFileInLastList(updated) {
  const i = state.lastFileList.findIndex((f) => f.id === updated.id);
  if (i >= 0) state.lastFileList[i] = { ...state.lastFileList[i], ...updated };
}

function rerenderFileTreeFromState() {
  const files = state.lastFileList || [];
  if ((el.treeSearch?.value || '').trim()) applyTreeFilter();
  else renderFileTree(files, { expandAll: false, isFiltered: false });
  if (state.currentFile?.id) {
    queueMicrotask(() => revealFileInSidebar(state.currentFile));
  }
}

async function fetchDriveFileMeta(fileId) {
  const params = new URLSearchParams({
    fields: 'id,name,parents,modifiedTime,mimeType',
  });
  if (CONFIG.BRAIN_IN_SHARED_DRIVE) params.set('supportsAllDrives', 'true');
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function renameDriveFile(fileId, newName) {
  const params = new URLSearchParams();
  if (CONFIG.BRAIN_IN_SHARED_DRIVE) params.set('supportsAllDrives', 'true');
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json().catch(() => ({}));
}

async function copyDriveFile(fileId, name, parents) {
  const params = new URLSearchParams();
  if (CONFIG.BRAIN_IN_SHARED_DRIVE) params.set('supportsAllDrives', 'true');
  const body = { name };
  if (parents && parents.length) body.parents = parents;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?${params}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function pickDuplicateFilename(sourceFile) {
  const label = normalizePathLabel(sourceFile._listLabel || sourceFile.name);
  const parts = label.split('/').filter(Boolean);
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const baseStem = parts[parts.length - 1].replace(/\.md$/i, '');
  const siblingLower = new Set(
    (state.lastFileList || [])
      .filter((f) => {
        const L = normalizePathLabel(f._listLabel || f.name);
        const d = L.includes('/') ? L.replace(/\/[^/]+$/, '') : '';
        return d === dir;
      })
      .map((f) =>
        (
          normalizePathLabel(f._listLabel || f.name).split('/').pop() || ''
        ).toLowerCase()
      )
  );
  let n = 2;
  let nameFile;
  do {
    nameFile = `${baseStem} ${n}.md`;
    if (!siblingLower.has(nameFile.toLowerCase())) break;
    n++;
  } while (n < 6000);
  return nameFile;
}

async function trashDriveFile(fileId) {
  const params = new URLSearchParams();
  if (CONFIG.BRAIN_IN_SHARED_DRIVE) params.set('supportsAllDrives', 'true');
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`,
    { method: 'DELETE' }
  );
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    throw new Error(t || `DELETE ${res.status}`);
  }
}

async function deleteCurrentNote() {
  if (!state.currentFile) return;
  const label = state.currentFile._listLabel || state.currentFile.name;
  if (state.dirty) {
    const ok = window.confirm(
      'Esta nota tem alterações não salvas. Eliminar no Drive mesmo assim?'
    );
    if (!ok) return;
  } else {
    const ok = window.confirm(
      `Eliminar esta nota no Google Drive (ficheiro vai para o lixo)?\n\n${label}`
    );
    if (!ok) return;
  }
  const id = state.currentFile.id;
  setSaveStatus('A eliminar…');
  try {
    await trashDriveFile(id);
    invalidateVaultGraphLinkCache();
    invalidateObsidianConfigCache();
    state.lastFileList = state.lastFileList.filter((f) => f.id !== id);
    state.aliasHintsByFileId.delete(id);
    closeCurrentNote();
    rerenderFileTreeFromState();
    setSaveStatus('Nota enviada para o lixo do Drive', { autoClearMs: 3800 });
    if (state.vaultMainTab === 'graph') void refreshVaultGraphView();
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao eliminar');
  }
}

async function duplicateCurrentNote() {
  if (!state.currentFile || !state.easyMDE) return;
  if (state.dirty) {
    const ok = window.confirm(
      'A nota tem alterações não salvas. Salvar antes de duplicar?'
    );
    if (!ok) return;
    try {
      await saveCurrentFile();
    } catch (e) {
      console.error(e);
      setSaveStatus('Erro ao salvar antes de duplicar');
      return;
    }
  }
  const src = state.currentFile;
  setSaveStatus('Duplicando…');
  try {
    const meta = await fetchDriveFileMeta(src.id);
    const parents = meta.parents || [];
    const newName = pickDuplicateFilename(src);
    const created = await copyDriveFile(src.id, newName, parents);
    invalidateVaultGraphLinkCache();
    await refreshFileList();
    const nf = state.lastFileList.find((f) => f.id === created.id);
    if (nf) await selectFile(nf, null);
    setSaveStatus('Nota duplicada', { autoClearMs: 3200 });
  } catch (e) {
    console.error(e);
    setSaveStatus('Erro ao duplicar');
  }
}

function scheduleVaultGraphFit() {
  requestAnimationFrame(() => {
    try {
      state.vaultGraphNetwork?.fit({ animation: false });
    } catch (_) {
      /* ignore */
    }
    requestAnimationFrame(() => {
      try {
        state.vaultGraphNetwork?.redraw();
        state.vaultGraphNetwork?.fit({ animation: false });
      } catch (_) {
        /* ignore */
      }
    });
  });
}

function ensureVaultGraphResizeObserver() {
  if (graphResizeObserver || !el.graphNetwork) return;
  graphResizeObserver = new ResizeObserver(() => {
    if (state.vaultMainTab !== 'graph' || !state.vaultGraphNetwork) return;
    try {
      state.vaultGraphNetwork.redraw();
      state.vaultGraphNetwork.fit({ animation: false });
    } catch (_) {
      /* ignore */
    }
  });
  graphResizeObserver.observe(el.graphNetwork);
}

function hideStatusTtlBar() {
  if (el.statusTtlBar) {
    el.statusTtlBar.hidden = true;
    el.statusTtlBar.setAttribute('aria-hidden', 'true');
  }
  if (el.statusTtlFill) {
    el.statusTtlFill.style.transition = 'none';
    el.statusTtlFill.style.width = '100%';
  }
}

/** Barra fina que encolhe durante autoClearMs (sincronizada com o texto que some). */
function startStatusTtlCountdown(ms) {
  if (!el.statusTtlBar || !el.statusTtlFill || !ms) return;
  const fill = el.statusTtlFill;
  el.statusTtlBar.hidden = false;
  el.statusTtlBar.setAttribute('aria-hidden', 'false');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  fill.offsetWidth;
  requestAnimationFrame(() => {
    fill.style.transition = `width ${ms}ms linear`;
    fill.style.width = '0%';
  });
}

function setSaveStatus(text, options = {}) {
  const { autoClearMs } = options;
  if (saveStatusClearTimer != null) {
    clearTimeout(saveStatusClearTimer);
    saveStatusClearTimer = null;
  }
  hideStatusTtlBar();
  if (el.saveStatus) el.saveStatus.textContent = text || '';
  if (autoClearMs != null && autoClearMs > 0 && text) {
    startStatusTtlCountdown(autoClearMs);
    const cleared = text;
    saveStatusClearTimer = setTimeout(() => {
      saveStatusClearTimer = null;
      if (el.saveStatus && el.saveStatus.textContent === cleared) {
        el.saveStatus.textContent = '';
      }
      hideStatusTtlBar();
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

/**
 * Conteúdo do ficheiro para índice de aliases (só precisamos do início).
 * Pedidos com Range devolviam 416 no Drive para ficheiros vazios ou nalguns casos — GET completo e cortar em memória.
 */
async function getFileContentHead(fileId, maxBytes = 32768) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media`;
  const res = await driveFetch(url);
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
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
  const CM = cm.constructor;
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

/**
 * EasyMDE empacota outra cópia do CM; o addon show-hint faz defineExtension no global.
 * O estático CodeMirror.showHint(cm,…) chama cm.showHint(opts) na instância — precisamos
 * copiar showHint/closeHint do CodeMirror.prototype para o protótipo deste editor.
 */
function syncCodeMirrorShowHint(cm) {
  const g = typeof CodeMirror !== 'undefined' ? CodeMirror : null;
  if (!g || !g.prototype) return;
  const src = g.prototype;
  const dst = Object.getPrototypeOf(cm);
  if (typeof src.showHint === 'function' && typeof dst.showHint !== 'function') {
    dst.showHint = src.showHint;
  }
  if (typeof src.closeHint === 'function' && typeof dst.closeHint !== 'function') {
    dst.closeHint = src.closeHint;
  }
  if (typeof g.showHint === 'function' && typeof cm.constructor.showHint !== 'function') {
    cm.constructor.showHint = g.showHint;
  }
}

function attachWikiLinkAutocomplete(cm) {
  syncCodeMirrorShowHint(cm);
  const runHint =
    typeof CodeMirror !== 'undefined' && typeof CodeMirror.showHint === 'function'
      ? (c) =>
          CodeMirror.showHint(c, wikiLinkHint, {
            completeSingle: false,
            closeOnUnfocus: true,
          })
      : null;
  if (!runHint || typeof cm.showHint !== 'function') {
    console.warn(
      '[Brain Drive] CodeMirror.showHint indisponível — autocomplete [[ desativado.'
    );
    return;
  }

  /** inputRead quase só IME; digitação normal usa change — sem change o [[ não abria sugestões. */
  const triggerWiki = debounce(() => {
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line) || '';
    const before = line.slice(0, cur.ch);
    if (!/\[\[([^\[\]]*)$/.test(before)) return;
    const m = before.match(/\[\[([^\[\]]*)$/);
    if (!m) return;
    if (wikiLinkQuerySegment(m[1]).length < WIKI_LINK_MIN_CHARS) return;
    runHint(cm);
  }, 45);

  cm.on('change', triggerWiki);
  cm.on('cursorActivity', triggerWiki);
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

/** Pastas começam fechadas; com filtro de busca expandimos tudo para mostrar resultados. */
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
    btn.setAttribute('data-file-id', node.file.id);
    if (state.currentFile?.id === node.file.id) btn.classList.add('is-active');
    btn.addEventListener('click', () => void selectFile(node.file, btn));
    li.appendChild(btn);
    container.appendChild(li);
    return;
  }

  const li = document.createElement('li');
  li.className = 'tree-folder';
  const details = document.createElement('details');
  details.open = Boolean(expandAll);
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

/** Expande pastas na sidebar e destaca a nota (ex.: aberta pelo Mapa sem clicar na árvore). */
function revealFileInSidebar(file) {
  if (!el.fileTree || !file?.id) return;
  const fid = String(file.id);

  const findBtn = () =>
    el.fileTree.querySelector(`button[data-file-id="${fid}"]`);

  let btn = findBtn();
  if (!btn && el.treeSearch && el.treeSearch.value.trim()) {
    el.treeSearch.value = '';
    applyTreeFilter();
    btn = findBtn();
  }
  if (!btn) return;

  el.fileTree.querySelectorAll('.tree-file button').forEach((b) =>
    b.classList.remove('is-active')
  );
  btn.classList.add('is-active');

  let x = btn.parentElement;
  while (x && x !== el.fileTree) {
    if (x.tagName === 'DETAILS') x.open = true;
    x = x.parentElement;
  }

  btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    invalidateVaultGraphLinkCache();
    invalidateObsidianConfigCache();
    if ((el.treeSearch?.value || '').trim()) {
      applyTreeFilter();
    } else {
      renderFileTree(files, { expandAll: false, isFiltered: false });
    }
    void indexVaultWikiHints().catch((e) =>
      console.warn('[Brain Drive] índice wiki', e)
    );
    destroyVaultGraphNetwork();
    if (state.vaultMainTab === 'graph') void refreshVaultGraphView();
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

async function findChildFolderId(parentId, folderName) {
  const items = await listAllItemsInFolder(parentId);
  const hit = items.find(
    (i) => i.mimeType === FOLDER_MIME && i.name === folderName
  );
  return hit?.id || null;
}

async function findFileInFolder(parentId, fileName) {
  const items = await listAllItemsInFolder(parentId);
  return (
    items.find((i) => i.mimeType !== FOLDER_MIME && i.name === fileName) ||
    null
  );
}

function collectBookmarkPathsFromObsidianJson(data, intoSet) {
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.type === 'file' && typeof node.path === 'string') {
      intoSet.add(normalizePathLabel(node.path));
    }
    if (node.items) walk(node.items);
    if (node.children) walk(node.children);
  }
  walk(data?.items ?? data);
}

function syncGraphContextBarVisible() {
  const bar = document.getElementById('graph-context-bar');
  if (bar) bar.hidden = false;
}

function flattenObsidianBookmarksForMenu(raw) {
  const out = [];
  function walk(node, depth) {
    if (!node || depth > 40) return;
    if (Array.isArray(node)) {
      node.forEach((x) => walk(x, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const type = node.type;
    const title =
      (typeof node.title === 'string' && node.title.trim()) ||
      (typeof node.path === 'string' && node.path.split('/').pop()) ||
      'Marcador';
    if (type === 'folder' && typeof node.path === 'string') {
      const px = normalizePathLabel(node.path).replace(/\/+$/g, '');
      if (px) out.push({ title, pathPrefix: px });
    } else if (type === 'file' && typeof node.path === 'string') {
      const pl = normalizePathLabel(node.path);
      const parent = pl.includes('/') ? pl.replace(/\/[^/]+$/, '') : '';
      if (parent) out.push({ title: `${title} (pasta)`, pathPrefix: parent });
      else out.push({ title, pathPrefix: pl.replace(/\.md$/i, '') });
    }
    if (node.items) walk(node.items, depth + 1);
    if (node.children) walk(node.children, depth + 1);
  }
  walk(raw?.items ?? raw, 0);
  const seen = new Set();
  return out.filter((e) => {
    const k = `${e.pathPrefix}\0${e.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function populateGraphBookmarkSelect() {
  const sel = el.graphBookmarkSelect || document.getElementById('graph-bookmark-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '— Escolha o alcance para carregar o mapa —';
  sel.appendChild(opt0);
  const optAll = document.createElement('option');
  optAll.value = GRAPH_SCOPE_ALL;
  optAll.textContent = 'Todo o vault (todas as notas · mais lento)';
  sel.appendChild(optAll);
  for (const e of flattenObsidianBookmarksForMenu(state.obsidianBookmarksRaw)) {
    const o = document.createElement('option');
    o.value = e.pathPrefix;
    o.textContent = e.title;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.value = '';
  syncGraphContextBarVisible();
}

async function loadObsidianConfigsFromDrive() {
  state.obsidianBookmarksRaw = null;
  state.obsidianGraphRaw = null;
  state.obsidianBookmarkPaths = new Set();

  const root = getBrainFolderId();
  if (!root || !state.accessToken) {
    populateGraphBookmarkSelect();
    return;
  }

  try {
    const obsId = await findChildFolderId(root, '.obsidian');
    if (!obsId) {
      populateGraphBookmarkSelect();
      return;
    }

    const bm = await findFileInFolder(obsId, 'bookmarks.json');
    if (bm) {
      const txt = await getFileContent(bm.id);
      state.obsidianBookmarksRaw = JSON.parse(txt);
      collectBookmarkPathsFromObsidianJson(
        state.obsidianBookmarksRaw,
        state.obsidianBookmarkPaths
      );
    }

    const gf = await findFileInFolder(obsId, 'graph.json');
    if (gf) {
      const txt = await getFileContent(gf.id);
      state.obsidianGraphRaw = JSON.parse(txt);
    }
  } catch (e) {
    console.warn('[Brain Drive] .obsidian', e);
  }
  populateGraphBookmarkSelect();
}

async function ensureObsidianConfigsLoaded() {
  if (state.obsidianConfigsLoaded) return;
  await loadObsidianConfigsFromDrive();
  state.obsidianConfigsLoaded = true;
}

function shortLabelForGraph(f) {
  const lab = normalizePathLabel(f._listLabel || f.name);
  const parts = lab.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || lab;
  return `…/${parts.slice(-2).join('/')}`;
}

function buildStemToFilesMap(files) {
  const m = new Map();
  for (const f of files) {
    const lab = normalizePathLabel(f._listLabel || f.name);
    const stem = (lab.split('/').pop() || '')
      .replace(/\.md$/i, '')
      .trim()
      .toLowerCase();
    if (!stem) continue;
    if (!m.has(stem)) m.set(stem, []);
    m.get(stem).push(f);
  }
  return m;
}

function resolveWikiTargetToFile(raw, files, stemMap) {
  const t = raw.trim();
  if (!t) return null;
  let norm = normalizePathLabel(t.replace(/\\/g, '/'));
  const nLow = norm.toLowerCase();

  if (!nLow.endsWith('.md')) {
    const withMd = `${norm}.md`;
    for (const f of files) {
      const lab = normalizePathLabel(f._listLabel || f.name);
      const ll = lab.toLowerCase();
      if (ll === withMd.toLowerCase() || ll.endsWith('/' + withMd.toLowerCase())) {
        return f;
      }
    }
  }

  for (const f of files) {
    const lab = normalizePathLabel(f._listLabel || f.name);
    if (lab.toLowerCase() === nLow) return f;
  }

  const stemKey = (norm.split('/').pop() || norm)
    .replace(/\.md$/i, '')
    .trim()
    .toLowerCase();
  const cand = stemMap.get(stemKey);
  if (cand?.length === 1) return cand[0];
  return null;
}

function extractWikiLinkTargetsForGraph(md) {
  const out = [];
  const s = String(md || '');
  const re = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1].trim());
  return out;
}

function getVaultGraphThemeColors() {
  const dark = document.documentElement.classList.contains('dark');
  if (dark) {
    return {
      nodeFont: '#e6e9f0',
      nodeBg: '#161b22',
      nodeBgHi: '#1f2937',
      nodeBorder: '#3d4f6f',
      edge: '#5c6b85',
      accent: '#60a5fa',
      bookmarkBg: '#14532d',
      bookmarkBorder: '#22c55e',
    };
  }
  return {
    nodeFont: '#1a1d26',
    nodeBg: '#ffffff',
    nodeBgHi: '#f1f5f9',
    nodeBorder: '#cbd5e1',
    edge: '#94a3b8',
    accent: '#2563eb',
    bookmarkBg: '#dcfce7',
    bookmarkBorder: '#16a34a',
  };
}

function buildVisNetworkOptions() {
  const th = getVaultGraphThemeColors();
  return {
    layout: {
      improvedLayout: false,
    },
    physics: {
      enabled: true,
      stabilization: { iterations: 120 },
      barnesHut: {
        gravitationalConstant: -22000,
        springLength: 175,
      },
    },
    nodes: {
      font: { color: th.nodeFont, size: 13 },
      borderWidth: 2,
      shape: 'box',
      margin: 10,
      color: {
        highlight: {
          background: th.nodeBgHi,
          border: th.accent,
        },
      },
    },
    edges: {
      arrows: { to: { enabled: true, scaleFactor: 0.45 } },
      color: { color: th.edge, highlight: th.accent },
      smooth: { type: 'continuous', roundness: 0.35 },
    },
    interaction: { hover: true, tooltipDelay: 100, multiselect: false },
  };
}

function extractObsidianGraphSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    return { search: '', showOrphans: true };
  }
  const r = raw;
  let search = '';
  const candidates = [
    typeof r.search === 'string' ? r.search : null,
    typeof r.query === 'string' ? r.query : null,
    r.filter && typeof r.filter === 'object' && typeof r.filter.search === 'string'
      ? r.filter.search
      : null,
    r.filters && typeof r.filters === 'object' && typeof r.filters.search === 'string'
      ? r.filters.search
      : null,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) {
      search = String(c).trim();
      break;
    }
  }
  let showOrphans = true;
  if (typeof r.showOrphans === 'boolean') showOrphans = r.showOrphans;
  return { search, showOrphans };
}

function sanitizeObsidianPathNeedle(raw) {
  return String(raw || '')
    .trim()
    .replace(/^["'`«»]+|["'`«»]+$/g, '')
    .trim();
}

/** Extrai cláusulas path: e texto livre do campo search do Obsidian (ex.: path:"Pasta/Sub"). */
function parseObsidianGraphQuery(searchRaw) {
  let rest = String(searchRaw || '');
  const pathNeedles = [];

  rest = rest.replace(/path:\s*"([^"]*)"\s*/gi, (_, p) => {
    const t = sanitizeObsidianPathNeedle(p);
    if (t) pathNeedles.push(t);
    return ' ';
  });
  rest = rest.replace(/path:\s*'([^']*)'\s*/gi, (_, p) => {
    const t = sanitizeObsidianPathNeedle(p);
    if (t) pathNeedles.push(t);
    return ' ';
  });
  rest = rest.replace(/path:\s*"([^"]+)/gi, (_, p) => {
    const t = sanitizeObsidianPathNeedle(p);
    if (t) pathNeedles.push(t);
    return ' ';
  });
  rest = rest.replace(/path:\s*([^\s"']+)\s*/gi, (_, p) => {
    const t = sanitizeObsidianPathNeedle(p);
    if (t && !t.startsWith('"') && !t.startsWith("'")) pathNeedles.push(t);
    return ' ';
  });

  return {
    pathNeedles,
    freeText: rest.replace(/\s+/g, ' ').trim(),
  };
}

function pathMatchesObsidianPathNeedles(fullPath, needles) {
  if (!needles.length) return true;
  const fp = normalizePathLabel(fullPath).toLowerCase();
  for (const raw of needles) {
    const n = normalizePathLabel(raw).toLowerCase().replace(/^\/+|\/+$/g, '');
    if (!n) continue;
    if (fp.includes(n)) continue;
    const segments = n.split('/').filter(Boolean);
    if (segments.length && segments.some((seg) => seg.length >= 2 && fp.includes(seg.toLowerCase())))
      continue;
    return false;
  }
  return true;
}

function obsidianFreeTextMatchesFullPath(fullPath, label, freeText) {
  if (!freeText) return true;
  const blob = `${normalizePathLabel(fullPath)} ${label || ''}`.toLowerCase();
  const tokens = freeText.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const t = tok.toLowerCase();
    if (!t || t.startsWith('-')) continue;
    if (t.startsWith('tag:')) {
      if (!blob.includes(t.slice(4))) return false;
    } else if (!blob.includes(t)) return false;
  }
  return true;
}

function pathMatchesBookmarkPrefix(fullPath, prefix) {
  if (!prefix || !String(prefix).trim()) return true;
  const fp = normalizePathLabel(fullPath).toLowerCase();
  const px = normalizePathLabel(prefix).toLowerCase().replace(/\/+$/g, '');
  if (!px) return true;
  return fp === px || fp.startsWith(px + '/');
}

/** Filtros graph.json + marcador (path prefix) — ignorável quando não há notas (fallback). */
function applyObsidianGraphFilters(nodes, edges, raw, files, bookmarkPathPrefix, ignoreGraphSearch) {
  const base = extractObsidianGraphSettings(raw || {});
  const st = ignoreGraphSearch
    ? { search: '', showOrphans: base.showOrphans }
    : base;

  const idToPath = new Map(
    (files || []).map((f) => [
      f.id,
      normalizePathLabel(f._listLabel || f.name),
    ])
  );

  const parsed = parseObsidianGraphQuery(st.search);

  let outN = nodes.filter((n) => {
    const path = idToPath.get(n.id) || '';
    if (!pathMatchesBookmarkPrefix(path, bookmarkPathPrefix)) return false;
    if (!pathMatchesObsidianPathNeedles(path, parsed.pathNeedles)) return false;
    if (!obsidianFreeTextMatchesFullPath(path, n.label || '', parsed.freeText))
      return false;
    return true;
  });

  let outE = edges.slice();
  const notes = [];
  if (st.search && !ignoreGraphSearch) {
    notes.push(`filtro "${st.search.slice(0, 52)}${st.search.length > 52 ? '…' : ''}"`);
  }
  if (bookmarkPathPrefix)
    notes.push(`marcador · ${normalizePathLabel(bookmarkPathPrefix)}`);

  const okIds = new Set(outN.map((n) => n.id));
  outE = outE.filter((e) => okIds.has(e.from) && okIds.has(e.to));

  if (st.showOrphans === false) {
    const connected = new Set();
    for (const e of outE) {
      connected.add(e.from);
      connected.add(e.to);
    }
    outN = outN.filter((n) => connected.has(n.id));
    const ok = new Set(outN.map((n) => n.id));
    outE = outE.filter((e) => ok.has(e.from) && ok.has(e.to));
    notes.push('órfãs ocultas');
  }

  return {
    nodes: outN,
    edges: outE,
    filterNote: notes.length ? notes.join(' · ') : '',
  };
}

function destroyVaultGraphNetwork() {
  if (state.vaultGraphNetwork) {
    try {
      state.vaultGraphNetwork.destroy();
    } catch (_) {
      /* ignore */
    }
    state.vaultGraphNetwork = null;
  }
}

function buildVaultGraphNodes(files) {
  const th = getVaultGraphThemeColors();
  const bp = state.obsidianBookmarkPaths;
  return files.map((f) => {
    const fullPath = normalizePathLabel(f._listLabel || f.name);
    const pathLow = fullPath.toLowerCase();
    let isBm = bp.has(fullPath) || bp.has(pathLow);
    if (!isBm) {
      for (const p of bp) {
        if (pathLow.endsWith(p.toLowerCase()) || p.toLowerCase().endsWith(pathLow)) {
          isBm = true;
          break;
        }
      }
    }
    return {
      id: f.id,
      label: shortLabelForGraph(f),
      title: fullPath + (isBm ? ' · favorito (Obsidian)' : ''),
      color: isBm
        ? { background: th.bookmarkBg, border: th.bookmarkBorder }
        : { background: th.nodeBg, border: th.nodeBorder },
    };
  });
}

async function extractVaultGraphEdges(files, stemMap) {
  const edgeSeen = new Set();
  const edges = [];
  let nextFileIndex = 0;
  let finishedCount = 0;
  const total = files.length;
  const concurrency = 5;

  async function scanOne(f) {
    let text;
    try {
      text = await getFileContent(f.id);
    } catch {
      return;
    }
    for (const tgt of extractWikiLinkTargetsForGraph(text)) {
      const to = resolveWikiTargetToFile(tgt, files, stemMap);
      if (!to || to.id === f.id) continue;
      const key = `${f.id}->${to.id}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push({ from: f.id, to: to.id });
    }
  }

  async function worker() {
    while (true) {
      const i = nextFileIndex++;
      if (i >= total) break;
      await scanOne(files[i]);
      finishedCount++;
      if (finishedCount % 25 === 0) {
        setGraphProgress(`Extraindo links [[…]] ${finishedCount}/${total}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return edges;
}

async function buildVaultGraphModel(filesOverride) {
  const files = Array.isArray(filesOverride)
    ? filesOverride
    : state.lastFileList || [];
  if (!files.length) return { nodes: [], edges: [] };
  const stemMap = buildStemToFilesMap(files);
  const nodes = buildVaultGraphNodes(files);
  const edges = await extractVaultGraphEdges(files, stemMap);
  return { nodes, edges };
}

async function refreshVaultGraphView() {
  if (!el.graphNetwork) return;

  if (typeof vis === 'undefined' || !vis.Network || !vis.DataSet) {
    setHeaderGraphStatus(
      'Biblioteca do mapa não carregou. Verifique a rede ou bloqueios.'
    );
    return;
  }

  if (state.vaultGraphBuilding) {
    state.vaultGraphRefreshQueued = true;
    return;
  }

  state.vaultGraphBuilding = true;
  showGraphLoading(true);
  setGraphProgress('Preparando mapa…');
  /** Evita mostrar mensagens antigas (ex.: lista vazia) no topo durante o carregamento. */
  clearHeaderGraphStatus();
  destroyVaultGraphNetwork();

  try {
    if (!state.obsidianConfigsLoaded) {
      setGraphProgress('Carregando bookmarks e filtros (.obsidian)…');
    }
    await ensureObsidianConfigsLoaded();

    const scope =
      (el.graphBookmarkSelect && el.graphBookmarkSelect.value) || '';

    if (!scope) {
      showGraphLoading(false);
      setGraphProgress('');
      setHeaderGraphStatus(
        'Escolha um marcador ou «Todo o vault» na lista acima. Só depois o mapa carrega e extrai ligações [[…]] para esse conjunto.'
      );
      return;
    }

    let files = state.lastFileList || [];
    if (scope !== GRAPH_SCOPE_ALL) {
      files = files.filter((f) =>
        pathMatchesBookmarkPrefix(f._listLabel || f.name, scope)
      );
    }

    if (!files.length) {
      showGraphLoading(false);
      setGraphProgress('');
      setHeaderGraphStatus(
        'Nenhuma nota neste alcance. Escolha outro marcador ou «Todo o vault».'
      );
      return;
    }

    const sig = `${computeVaultListSignature(files)}|scope:${scope}`;
    let nodes;
    let edges;

    if (
      state.vaultGraphLinkCache &&
      state.vaultGraphLinkCache.sig === sig &&
      Array.isArray(state.vaultGraphLinkCache.edges)
    ) {
      setGraphProgress('Montando mapa (ligações em cache)…');
      nodes = buildVaultGraphNodes(files);
      edges = state.vaultGraphLinkCache.edges.map((e) => ({
        from: e.from,
        to: e.to,
      }));
    } else {
      setGraphProgress('Construindo notas e extraindo links [[…]]…');
      const built = await buildVaultGraphModel(files);
      nodes = built.nodes;
      edges = built.edges;
      state.vaultGraphLinkCache = {
        sig,
        edges: edges.map((e) => ({ from: e.from, to: e.to })),
      };
    }

    const allowedIds = new Set(files.map((f) => f.id));
    edges = edges.filter(
      (e) => allowedIds.has(e.from) && allowedIds.has(e.to)
    );

    let filtered = applyObsidianGraphFilters(
      nodes,
      edges,
      state.obsidianGraphRaw,
      files,
      '',
      false
    );
    let usedFallback = false;

    if (filtered.nodes.length === 0 && files.length > 0) {
      const relaxed = applyObsidianGraphFilters(
        nodes,
        edges,
        state.obsidianGraphRaw,
        files,
        '',
        true
      );
      if (relaxed.nodes.length > 0) {
        filtered = relaxed;
        usedFallback = true;
      }
    }

    nodes = filtered.nodes;
    edges = filtered.edges;

    const bm = state.obsidianBookmarkPaths.size;
    if (nodes.length === 0) {
      if (!files.length) {
        setHeaderGraphStatus(
          'Nenhuma nota listada. Entre com a conta e aguarde o vault.'
        );
      } else {
        setHeaderGraphStatus(
          'Nenhuma nota visível com os filtros do graph.json neste alcance. Ajuste no Obsidian ou escolha outro marcador.'
        );
      }
    } else {
      let line = `${nodes.length} notas · ${edges.length} ligações`;
      if (scope !== GRAPH_SCOPE_ALL) {
        line += ` · alcance: ${normalizePathLabel(scope).slice(0, 56)}${normalizePathLabel(scope).length > 56 ? '…' : ''}`;
      }
      if (filtered.filterNote) line += ` · ${filtered.filterNote}`;
      if (usedFallback) {
        line +=
          ' · texto do graph.json excluía tudo — mapa só com filtro de caminho/órfãs';
      }
      if (bm) line += ` · ${bm} favorito(s) (bookmarks.json)`;
      setHeaderGraphStatus(line);
    }

    const data = {
      nodes: new vis.DataSet(nodes),
      edges: new vis.DataSet(edges),
    };
    const opts = buildVisNetworkOptions();

    state.vaultGraphNetwork = new vis.Network(el.graphNetwork, data, opts);
    state.vaultGraphNetwork.on('click', (p) => {
      if (p.nodes.length === 1) {
        switchToEditorAndOpenNote(p.nodes[0]);
      }
    });
    scheduleVaultGraphFit();
  } catch (e) {
    console.warn(e);
    const msg = e.message || String(e);
    setHeaderGraphStatus(msg);
    setGraphProgress(msg);
  } finally {
    state.vaultGraphBuilding = false;
    showGraphLoading(false);
    if (state.vaultGraphRefreshQueued) {
      state.vaultGraphRefreshQueued = false;
      queueMicrotask(() => void refreshVaultGraphView());
    }
  }
}

function syncVaultSidebarForTab() {
  if (!el.sidebar) return;
  if (state.vaultMainTab === 'graph') {
    el.sidebar.hidden = true;
    return;
  }
  el.sidebar.hidden = false;
  el.sidebar.classList.remove('sidebar--collapsed');
}

function switchVaultTab(tab) {
  if (tab !== 'editor' && tab !== 'graph') return;
  state.vaultMainTab = tab;
  if (el.tabEditor)
    el.tabEditor.classList.toggle('is-active', tab === 'editor');
  if (el.tabGraph) el.tabGraph.classList.toggle('is-active', tab === 'graph');
  if (el.panelEditor) el.panelEditor.hidden = tab !== 'editor';
  if (el.panelGraph) el.panelGraph.hidden = tab !== 'graph';

  syncVaultSidebarForTab();

  if (tab === 'editor') {
    clearHeaderGraphStatus();
    syncEditorChromeVisibility();
  } else {
    clearHeaderGraphStatus();
    ensureVaultGraphResizeObserver();
    void refreshVaultGraphView().then(() => {
      if (state.vaultMainTab === 'graph') scheduleVaultGraphFit();
    });
  }
}

function switchToEditorAndOpenNote(fileId) {
  const f = state.lastFileList.find((x) => x.id === fileId);
  if (!f) return;
  switchVaultTab('editor');
  void selectFile(f, null);
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
  let file = state.currentFile;
  const content = state.easyMDE.value();
  const stem = sanitizeNoteFileStem(el.noteTitleInput?.value ?? '');
  const targetName = `${stem}.md`;

  if (targetName !== file.name) {
    setSaveStatus('Renomeando…');
    await renameDriveFile(file.id, targetName);
    const label = file._listLabel;
    let newLabel = label;
    if (label && label.includes('/')) {
      const parts = label.split('/');
      parts[parts.length - 1] = targetName;
      newLabel = parts.join('/');
    } else {
      newLabel = targetName;
    }
    file = {
      ...file,
      name: targetName,
      _listLabel: newLabel,
    };
    updateFileInLastList(file);
    state.currentFile = file;
    setEditorFileTitle(file._listLabel || file.name);
    rerenderFileTreeFromState();
  }

  setSaveStatus('Salvando…');
  await patchFileContents(file.id, file.name, content);
  invalidateVaultGraphLinkCache();
  state.dirty = false;
  setSaveStatus('Salvo', { autoClearMs: 3200 });
}

function closeCurrentNote() {
  if (state.dirty) {
    const ok = window.confirm(
      'Esta nota tem alterações não salvas. Fechar mesmo assim?'
    );
    if (!ok) return;
  }
  state.currentFile = null;
  state.dirty = false;
  setEditorFileTitle(null);
  if (el.noteTitleInput) el.noteTitleInput.value = '';
  if (state.easyMDE) {
    state.loadingFile = true;
    state.easyMDE.value('');
    queueMicrotask(() => {
      state.loadingFile = false;
    });
  }
  el.btnSave.disabled = true;
  if (el.btnReloadFile) el.btnReloadFile.disabled = true;
  syncEditorChromeVisibility();
  if (el.fileTree) {
    el.fileTree.querySelectorAll('.tree-file button').forEach((b) =>
      b.classList.remove('is-active')
    );
  }
  setSaveStatus('');
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
    if (el.noteTitleInput)
      el.noteTitleInput.value = noteStemFromFile(state.currentFile);
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

    state.currentFile = file;
    setEditorFileTitle(file._listLabel || file.name);
    if (el.noteTitleInput)
      el.noteTitleInput.value = noteStemFromFile(file);
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
    syncEditorChromeVisibility();
    revealFileInSidebar(file);
    setSaveStatus('');
  } catch (e) {
    console.error(e);
    state.currentFile = null;
    setEditorFileTitle(null);
    if (el.noteTitleInput) el.noteTitleInput.value = '';
    syncEditorChromeVisibility();
    if (el.fileTree) {
      el.fileTree.querySelectorAll('.tree-file button').forEach((b) =>
        b.classList.remove('is-active')
      );
    }
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

  if (state.vaultMainTab === 'graph') {
    destroyVaultGraphNetwork();
    void refreshVaultGraphView();
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const onReady = () => {
    navigator.serviceWorker
      .register(new URL('./sw.js?v=28', window.location.href), {
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
  if (el.noteTitleInput) el.noteTitleInput.value = '';
  if (state.easyMDE) state.easyMDE.value('');
  syncEditorChromeVisibility();
  destroyVaultGraphNetwork();
  state.obsidianBookmarksRaw = null;
  state.obsidianGraphRaw = null;
  state.obsidianBookmarkPaths = new Set();
  invalidateVaultGraphLinkCache();
  invalidateObsidianConfigCache();
  switchVaultTab('editor');
}

function bindUi() {
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
  el.statusTtlBar = document.getElementById('status-ttl-bar');
  el.statusTtlFill = document.getElementById('status-ttl-fill');
  el.tabEditor = document.getElementById('tab-editor');
  el.tabGraph = document.getElementById('tab-graph');
  el.panelEditor = document.getElementById('panel-editor');
  el.panelGraph = document.getElementById('panel-graph');
  el.graphNetwork = document.getElementById('graph-network');
  el.graphLoading = document.getElementById('graph-loading');
  el.graphLoadingStatus = document.getElementById('graph-loading-status');
  el.headerGraphStatus = document.getElementById('header-graph-status');
  el.btnCloseNote = document.getElementById('btn-close-note');
  el.btnDuplicateNote = document.getElementById('btn-duplicate-note');
  el.btnDeleteNote = document.getElementById('btn-delete-note');
  el.noteTitleBlock = document.getElementById('note-title-block');
  el.noteTitleInput = document.getElementById('note-title-input');
  el.graphBookmarkSelect = document.getElementById('graph-bookmark-select');

  initTheme();
  updateSidebarSectionTitle();
  syncVaultSidebarForTab();

  if (el.tabEditor)
    el.tabEditor.addEventListener('click', () => switchVaultTab('editor'));
  if (el.tabGraph)
    el.tabGraph.addEventListener('click', () => switchVaultTab('graph'));

  if (el.btnCloseNote)
    el.btnCloseNote.addEventListener('click', () => closeCurrentNote());
  if (el.btnDuplicateNote)
    el.btnDuplicateNote.addEventListener('click', () =>
      void duplicateCurrentNote()
    );
  if (el.btnDeleteNote)
    el.btnDeleteNote.addEventListener('click', () => void deleteCurrentNote());

  if (el.graphBookmarkSelect) {
    el.graphBookmarkSelect.addEventListener('change', () => {
      void refreshVaultGraphView();
    });
  }

  if (el.noteTitleInput) {
    el.noteTitleInput.addEventListener('input', () => {
      if (state.loadingFile || !state.currentFile) return;
      state.dirty = true;
      setSaveStatus('Alterações não salvas');
    });
  }

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
    toolbar: [
      'bold',
      'italic',
      'heading',
      '|',
      'quote',
      'unordered-list',
      'ordered-list',
      '|',
      'link',
      'image',
      '|',
      'preview',
      'side-by-side',
      'fullscreen',
      '|',
      'guide',
      '|',
      {
        name: 'duplicate',
        action: () => {
          void duplicateCurrentNote();
        },
        className: 'fa fa-files-o easymde-btn-duplicate',
        title: 'Duplicar nota',
      },
    ],
    placeholder: 'Abra uma nota pelo Mapa ou na lista ao lado.',
    /* Font Awesome 4 já é carregado no index.html (CDN); evita duplicar ou falhar no auto-download */
    autoDownloadFontAwesome: false,
  });

  state.easyMDE.codemirror.on('change', () => {
    if (state.loadingFile || !state.currentFile) return;
    state.dirty = true;
    setSaveStatus('Alterações não salvas');
  });

  attachWikiLinkAutocomplete(state.easyMDE.codemirror);

  syncEditorChromeVisibility();
  queueMicrotask(() => syncEditorChromeVisibility());

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
