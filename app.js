/* ═══════════════════════════════════════════════════════════════
   BrainKaizen — app.js
   Módulos: Timer, Tarefas (tags/subtarefas/recorrência),
            Notas (múltiplos cadernos + PDF), Sono, Temas (PWA-ready)
   Arquitectura: cache em memória para UI,
                 Supabase (cloud) como fonte de verdade dos dados,
                 localForage como cache offline.
════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────────
//  SUPABASE CLIENT
//  — autenticação + base de dados + storage de avatares
// ─────────────────────────────────────────────────────────────
// Credenciais carregadas de config.js (ver config.example.js)

// [SEGURANÇA] persistSession com sessionStorage — sessão existe enquanto
// o separador estiver aberto. Ao fechar a aba/browser, a sessão termina.
// Usar sessionStorage em vez de false evita o loop de login causado pelo
// beforeunload a disparar durante o redirect normal de login.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession:     true,
    storage:            window.sessionStorage, // limpa ao fechar o tab
    autoRefreshToken:   true,
    detectSessionInUrl: true,
  }
});

// Camada extra: se o utilizador trocar de aba por muito tempo (ex: 30min),
// fazer logout automático quando voltar
let inactivityTimer = null;
const INACTIVITY_LIMIT = 2 * 60 * 60 * 1000; // 2 horas (evita logout durante sessões de estudo)

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Utilizador saiu da aba — iniciar contagem
    inactivityTimer = setTimeout(async () => {
      await sb.auth.signOut();
      window.location.href = 'login.html';
    }, INACTIVITY_LIMIT);
  } else {
    // Utilizador voltou — cancelar contagem se ainda está dentro do limite
    clearTimeout(inactivityTimer);
    // Verificar se a sessão ainda é válida
    sb.auth.getSession().then(({ data: { session } }) => {
      if (!session) window.location.href = 'login.html';
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  CACHE EM MEMÓRIA  (evita leituras repetidas ao IndexedDB)
// ─────────────────────────────────────────────────────────────
let MEM = {
  tasks:        [],   // array de tarefas
  notebooks:    [],   // [ {id, name, content} ]
  activeNoteId: null, // id do caderno activo
  sessions:     0,
  minutes:      0,
  history:      {},   // { 'YYYY-MM-DD': minutos }
  sleepHistory: {},
  theme:        'coffee',
};

// ─────────────────────────────────────────────────────────────
//  ESTADO DA UI
// ─────────────────────────────────────────────────────────────
let enableSound         = true;
let enableNotifications = false;
let quillEditor         = null;
let currentFocusTaskId  = null;
let sortableInstance    = null;
let taskFilter          = 'all';
let activeTagFilter     = null;
let activeSubtaskId     = null;  // id da tarefa cujo modal de subtarefas está aberto

// ─────────────────────────────────────────────────────────────
//  MIGRAÇÃO (localStorage → localForage)
// ─────────────────────────────────────────────────────────────
async function runMigration() {
  const done = await localforage.getItem('migrated_v2');
  if (done) return;
  const keys = ['acadOS_tasks','acadOS_note','acadOS_sleep','acadOS_sessions',
                'acadOS_minutes','acadOS_history','acadOS_sleep_history'];
  for (const k of keys) {
    const val = localStorage.getItem(k);
    if (val) {
      try { await localforage.setItem(k, JSON.parse(val)); }
      catch { await localforage.setItem(k, val); }
    }
  }
  await localforage.setItem('migrated_v2', true);
}

// ─────────────────────────────────────────────────────────────
//  MODAIS DE TEXTO E CONFIRMAÇÃO  (substituem prompt/confirm)
// ─────────────────────────────────────────────────────────────

/** Modal de input de texto (substitui prompt()) */
function openTextModal({ title, placeholder, initial = '', confirmText = 'OK', onConfirm }) {
  // Criar overlay + modal dinamicamente
  let overlay = document.getElementById('_textModalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = '_textModalOverlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);
      z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div style="background:var(--glass-bg,rgba(62,39,35,.95));border:1px solid var(--glass-border,rgba(255,255,255,.18));
                border-radius:18px;padding:28px 28px 22px;max-width:380px;width:100%;
                box-shadow:0 20px 60px rgba(0,0,0,.4);backdrop-filter:blur(24px);">
      <div style="font-size:15px;font-weight:600;color:var(--text-main,#f5f5dc);margin-bottom:16px;">${title}</div>
      <input id="_textModalInput" type="text" value="${escapeHtml(initial)}"
             placeholder="${placeholder}"
             style="width:100%;padding:10px 14px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.2);
                    border-radius:10px;color:var(--text-main,#f5f5dc);font-size:14px;font-family:inherit;
                    outline:none;margin-bottom:16px;"
             onkeydown="if(event.key==='Enter'){document.getElementById('_textModalOk').click();}
                        if(event.key==='Escape'){document.getElementById('_textModalCancel').click();}">
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="_textModalCancel"
                style="padding:8px 18px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);
                       border-radius:25px;color:var(--text-main,#f5f5dc);font-size:13px;cursor:pointer;font-family:inherit;">
          Cancelar
        </button>
        <button id="_textModalOk"
                style="padding:8px 18px;background:var(--btn-primary,linear-gradient(90deg,#5d4037,#8d6e63));
                       border:none;border-radius:25px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">
          ${confirmText}
        </button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  const input  = document.getElementById('_textModalInput');
  const cancel = document.getElementById('_textModalCancel');
  const ok     = document.getElementById('_textModalOk');
  // Selecionar texto existente
  setTimeout(() => { input.focus(); input.select(); }, 50);
  const close = () => { overlay.style.display = 'none'; };
  cancel.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  ok.onclick = () => { close(); onConfirm(input.value); };
}

/** Modal de confirmação (substitui confirm()) */
function openConfirmModal({ title, message, confirmText = 'Confirmar', danger = true, onConfirm }) {
  let overlay = document.getElementById('_confirmModalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = '_confirmModalOverlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);
      z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    document.body.appendChild(overlay);
  }
  const btnStyle = danger
    ? 'background:rgba(239,83,80,.8);border:none;color:#fff;'
    : 'background:var(--btn-primary,linear-gradient(90deg,#5d4037,#8d6e63));border:none;color:#fff;';
  overlay.innerHTML = `
    <div style="background:var(--glass-bg,rgba(62,39,35,.95));border:1px solid var(--glass-border,rgba(255,255,255,.18));
                border-radius:18px;padding:28px 28px 22px;max-width:360px;width:100%;
                box-shadow:0 20px 60px rgba(0,0,0,.4);backdrop-filter:blur(24px);">
      <div style="font-size:15px;font-weight:600;color:var(--text-main,#f5f5dc);margin-bottom:8px;">${title}</div>
      ${message ? `<div style="font-size:13px;color:rgba(245,245,220,.65);margin-bottom:18px;line-height:1.5;">${message}</div>` : '<div style="margin-bottom:18px;"></div>'}
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="_confirmModalCancel"
                style="padding:8px 18px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);
                       border-radius:25px;color:var(--text-main,#f5f5dc);font-size:13px;cursor:pointer;font-family:inherit;">
          Cancelar
        </button>
        <button id="_confirmModalOk"
                style="padding:8px 18px;${btnStyle}border-radius:25px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">
          ${confirmText}
        </button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  const close   = () => { overlay.style.display = 'none'; };
  document.getElementById('_confirmModalCancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.getElementById('_confirmModalOk').onclick = () => { close(); onConfirm(); };
}

// ─────────────────────────────────────────────────────────────
//  TOAST  (substitui alert())
// ─────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  document.getElementById('toastNotification')?.remove();
  const t = document.createElement('div');
  t.id = 'toastNotification';
  const icons = { info:'💡', success:'✓', warning:'⚡' };
  t.textContent = `${icons[type]||'💡'}  ${msg}`;
  Object.assign(t.style, {
    position:'fixed', bottom:'28px', left:'50%',
    transform:'translateX(-50%) translateY(20px)',
    background:'rgba(20,10,8,0.95)', color:'#f5f5dc',
    padding:'12px 24px', borderRadius:'25px',
    fontSize:'13px', fontFamily:"'DM Sans',sans-serif", fontWeight:'500',
    border:'1px solid rgba(255,255,255,0.2)',
    backdropFilter:'blur(14px)', boxShadow:'0 8px 32px rgba(0,0,0,.3)',
    zIndex:'99999', opacity:'0',
    transition:'opacity .3s ease, transform .3s ease',
    pointerEvents:'none', whiteSpace:'nowrap',
  });
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity='1'; t.style.transform='translateX(-50%) translateY(0)'; });
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(-50%) translateY(10px)'; setTimeout(()=>t.remove(),350); }, 3000);
}

// ─────────────────────────────────────────────────────────────
//  RELÓGIO — independente do init async para nunca parar
// ─────────────────────────────────────────────────────────────
function startClock() {
  // Limpar qualquer intervalo anterior
  if (window._clockInterval) clearInterval(window._clockInterval);

  function tick() {
    const el = document.getElementById('liveClock');
    if (!el) return; // DOM ainda não pronto — tentar na próxima tick
    const n = new Date();
    const p = v => String(v).padStart(2, '0');
    el.textContent = `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
  }

  tick(); // actualizar imediatamente
  window._clockInterval = setInterval(tick, 1000);
}

// Iniciar o relógio assim que o DOM estiver pronto (não espera pelo init async)
document.addEventListener('DOMContentLoaded', () => startClock());

// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await runMigration();

  // ── Obter sessão e user_id ──────────────────────────────────
  const { data: { session } } = await sb.auth.getSession();
  _currentUserId = session?.user?.id || null;

  // Carregar nome do utilizador da sessão Supabase
  const userName = session?.user?.user_metadata?.name || 'Estudante';
  const userInitial = userName.charAt(0).toUpperCase();
  const nameEl = document.getElementById('sidebarName');
  if (nameEl) nameEl.textContent = userName;
  // Iniciais do avatar por omissão
  const sidebarAv = document.getElementById('sidebarAvatar');
  if (sidebarAv) sidebarAv.textContent = userInitial;
  const settingsAv = document.getElementById('settingsAvatar');
  if (settingsAv) settingsAv.textContent = userInitial;

  // ── Carregar dados: cloud primeiro, localForage como fallback ─
  // 1. Sempre carregar localForage para ter algo imediato
  MEM.tasks        = (await localforage.getItem('acadOS_tasks'))         || [];
  MEM.sessions     = (await localforage.getItem('acadOS_sessions'))      || 0;
  MEM.minutes      = (await localforage.getItem('acadOS_minutes'))       || 0;
  MEM.history      = (await localforage.getItem('acadOS_history'))       || {};
  MEM.sleepHistory = (await localforage.getItem('acadOS_sleep_history')) || {};
  MEM.theme        = (await localforage.getItem('acadOS_theme'))         || 'coffee';

  // Cadernos — migrar nota antiga para o primeiro caderno
  let notebooks = await localforage.getItem('acadOS_notebooks');
  if (!notebooks) {
    const oldNote = await localforage.getItem('acadOS_note') || '';
    notebooks = [{ id: Date.now(), name: 'Caderno 1', content: oldNote }];
    await localforage.setItem('acadOS_notebooks', notebooks);
  }
  MEM.notebooks    = notebooks;
  MEM.activeNoteId = MEM.notebooks[0]?.id || null;

  // Sono — restaurar do cache local
  const sleepLocal = await localforage.getItem('acadOS_sleep');
  if (sleepLocal) {
    const bedEl  = document.getElementById('sleepBedtime');
    const wakeEl = document.getElementById('sleepWake');
    if (bedEl)  bedEl.value  = sleepLocal.bed  || '';
    if (wakeEl) wakeEl.value = sleepLocal.wake || '';
    calcSleep();
  }

  // Aplicar tema guardado
  applyTheme(MEM.theme, false);

  // Avatar — carregar da cloud (async, não bloqueia)
  _loadAvatarFromCloud();

  // Relógio
  startClock();

  // Editor Quill
  document.querySelectorAll('.ql-toolbar').forEach(t => t.remove());
  document.querySelectorAll('.ql-container').forEach(t => t.remove());
  const wrapper = document.getElementById('quillWrapper');
  wrapper.innerHTML = '<div id="quillMount"></div>';
  quillEditor = new Quill('#quillMount', {
    theme: 'snow',
    placeholder: 'Escreva as suas notas aqui...',
    modules: { toolbar: [
      ['bold','italic','underline','strike'],
      [{ list:'ordered' },{ list:'bullet' }],
      [{ header:[1,2,3,false] }],
      ['clean']
    ]}
  });
  quillEditor.on('text-change', () => autoSaveNote());

  // Renderizar UI com dados locais (imediato)
  renderNotebooks();
  loadNoteContent();
  renderTasks();
  renderChart();
  renderSleepChart();
  loadTimerState();
  renderTimer();
  renderSessionDots();
  updateStats();
  updateStatSleep(); // Fix #3 — stat-sleep no arranque

  // 2. Sincronizar com a cloud em segundo plano
  //    Se cloudLoad devolver dados mais recentes, re-renderizar
  if (_currentUserId) {
    cloudLoad().then(loaded => {
      if (loaded) {
        // Cloud tinha dados — actualizar UI
        applyTheme(MEM.theme, false);
        MEM.activeNoteId = MEM.notebooks[0]?.id || null;
        renderNotebooks();
        loadNoteContent();
        renderTasks();
        renderChart();
        renderSleepChart();
        renderSessionDots();
        updateStats();
        updateStatSleep();
      }
    });
    // Iniciar sincronização em tempo real (Supabase Realtime)
    startRealtimeSync();
  }
});

// ─────────────────────────────────────────────────────────────
//  CLOUD SYNC — Supabase como fonte de verdade
//
//  Tabela necessária no Supabase (executar no SQL Editor):
//  ─────────────────────────────────────────────────────────
//  create table if not exists user_data (
//    user_id uuid primary key references auth.users(id) on delete cascade,
//    tasks        jsonb default '[]',
//    notebooks    jsonb default '[]',
//    sessions     integer default 0,
//    minutes      integer default 0,
//    history      jsonb default '{}',
//    sleep_history jsonb default '{}',
//    sleep        jsonb default null,
//    theme        text default 'coffee',
//    updated_at   timestamptz default now()
//  );
//  alter table user_data enable row level security;
//  create policy "own data" on user_data
//    using (auth.uid() = user_id)
//    with check (auth.uid() = user_id);
//
//  Bucket de avatares (Storage → New bucket → "avatars", public: true)
// ─────────────────────────────────────────────────────────────

let _cloudSyncTimer  = null;  // debounce para não fazer push a cada tecla
let _currentUserId   = null;  // user_id da sessão activa

/** Carrega dados da cloud para MEM. Se não existir registo, cria um novo. */
async function cloudLoad() {
  if (!_currentUserId) return false;
  try {
    const { data, error } = await sb
      .from('user_data')
      .select('*')
      .eq('user_id', _currentUserId)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = "not found" — não é erro fatal
      console.warn('[cloud] load error:', error.message);
      return false;
    }

    if (data) {
      // Merge cloud → MEM (cloud ganha)
      if (Array.isArray(data.tasks))         MEM.tasks        = data.tasks;
      if (Array.isArray(data.notebooks))     MEM.notebooks    = data.notebooks;
      if (typeof data.sessions === 'number') MEM.sessions     = data.sessions;
      if (typeof data.minutes  === 'number') MEM.minutes      = data.minutes;
      if (data.history)                      MEM.history      = data.history;
      if (data.sleep_history)                MEM.sleepHistory = data.sleep_history;
      if (data.theme)                        MEM.theme        = data.theme;

      // Restaurar campos do sono
      if (data.sleep) {
        const bedEl  = document.getElementById('sleepBedtime');
        const wakeEl = document.getElementById('sleepWake');
        if (bedEl)  bedEl.value  = data.sleep.bed  || '';
        if (wakeEl) wakeEl.value = data.sleep.wake || '';
        calcSleep();
      }

      // Sincronizar localForage como cache offline
      await _persistLocal();
      return true;
    } else {
      // Primeira vez — criar registo com dados locais
      await cloudSave({ immediate: true });
      return true;
    }
  } catch (e) {
    console.warn('[cloud] load exception:', e);
    return false;
  }
}

/** Envia MEM para a cloud (upsert). Debounced por omissão. */
async function cloudSave({ immediate = false } = {}) {
  if (!_currentUserId) return;

  const doSave = async () => {
    setSyncState('syncing');
    try {
      const sleepBed  = document.getElementById('sleepBedtime')?.value || '';
      const sleepWake = document.getElementById('sleepWake')?.value    || '';
      const payload = {
        user_id:       _currentUserId,
        tasks:         MEM.tasks,
        notebooks:     MEM.notebooks,
        sessions:      MEM.sessions,
        minutes:       MEM.minutes,
        history:       MEM.history,
        sleep_history: MEM.sleepHistory,
        sleep:         (sleepBed || sleepWake) ? { bed: sleepBed, wake: sleepWake } : null,
        theme:         MEM.theme,
        updated_at:    new Date().toISOString(),
      };
      const { error } = await sb.from('user_data').upsert(payload, { onConflict: 'user_id' });
      if (error) { console.warn('[cloud] save error:', error.message); setSyncState('error'); }
      else setSyncState('synced');
    } catch (e) {
      console.warn('[cloud] save exception:', e);
      setSyncState('error');
    }
  };

  if (immediate) {
    await doSave();
  } else {
    clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(doSave, 1500); // debounce 1.5s
  }
}

/** Persiste MEM no localForage (cache offline). */
async function _persistLocal() {
  await Promise.allSettled([
    localforage.setItem('acadOS_tasks',         MEM.tasks),
    localforage.setItem('acadOS_notebooks',      MEM.notebooks),
    localforage.setItem('acadOS_sessions',       MEM.sessions),
    localforage.setItem('acadOS_minutes',        MEM.minutes),
    localforage.setItem('acadOS_history',        MEM.history),
    localforage.setItem('acadOS_sleep_history',  MEM.sleepHistory),
    localforage.setItem('acadOS_theme',          MEM.theme),
  ]);
}

/** Substitui localforage.setItem — guarda localmente E agenda sync na cloud */
function persist(key, value) {
  localforage.setItem(key, value).catch(e => console.warn('persist local error:', e));
  cloudSave(); // debounced
}

// ─────────────────────────────────────────────────────────────
//  AVATAR — Supabase Storage (bucket "avatars", acesso público)
// ─────────────────────────────────────────────────────────────

async function uploadAvatar(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!_currentUserId) { showToast('Sessão inválida.', 'warning'); return; }
  if (file.size > 2 * 1024 * 1024) { showToast('Imagem demasiado grande (máx 2MB).', 'warning'); return; }

  showToast('A carregar foto...', 'info');

  // Converter para JPEG para uniformidade (reduz tamanho)
  const canvas = document.createElement('canvas');
  const img    = new Image();
  const reader = new FileReader();

  reader.onload = async (e) => {
    img.onload = async () => {
      const MAX = 256;
      const ratio = Math.min(MAX / img.width, MAX / img.height);
      canvas.width  = Math.round(img.width  * ratio);
      canvas.height = Math.round(img.height * ratio);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(async (blob) => {
        const path = `${_currentUserId}/avatar.jpg`;
        const { error } = await sb.storage
          .from('avatars')
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });

        if (error) {
          console.warn('[avatar] upload error:', error.message);
          // Fallback: guardar em localStorage como base64
          const b64 = canvas.toDataURL('image/jpeg', 0.85);
          localStorage.setItem('_bk_avatar', b64);
          _refreshAvatarUI();
          showToast('Foto guardada localmente.', 'info');
        } else {
          // Guardar URL pública + timestamp para invalidar cache CDN
          const { data: { publicUrl } } = sb.storage
            .from('avatars')
            .getPublicUrl(path);
          const urlWithBust = `${publicUrl}?t=${Date.now()}`;
          localStorage.setItem('_bk_avatar', urlWithBust);
          _refreshAvatarUI();
          showToast('Foto actualizada! ✓', 'success');
        }
      }, 'image/jpeg', 0.85);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function removeAvatar() {
  if (_currentUserId) {
    await sb.storage.from('avatars').remove([`${_currentUserId}/avatar.jpg`]);
  }
  localStorage.removeItem('_bk_avatar');
  _refreshAvatarUI();
  showToast('Foto removida.', 'info');
}

async function _loadAvatarFromCloud() {
  if (!_currentUserId) return;
  // Verificar se já temos em cache local
  const cached = localStorage.getItem('_bk_avatar');
  if (cached) { _refreshAvatarUI(); return; }
  // Tentar buscar do Storage
  const path = `${_currentUserId}/avatar.jpg`;
  const { data: { publicUrl } } = sb.storage.from('avatars').getPublicUrl(path);
  // Verificar se o ficheiro existe (HEAD request)
  try {
    const res = await fetch(publicUrl, { method: 'HEAD' });
    if (res.ok) {
      const url = `${publicUrl}?t=${Date.now()}`;
      localStorage.setItem('_bk_avatar', url);
    }
  } catch (_) { /* sem avatar na cloud */ }
  _refreshAvatarUI();
}

// ─────────────────────────────────────────────────────────────
//  INDICADOR DE SINCRONIZAÇÃO
// ─────────────────────────────────────────────────────────────
function setSyncState(state) {
  // state: 'synced' | 'syncing' | 'error'
  const el = document.getElementById('syncIndicator');
  if (!el) return;
  el.className = 'sync-indicator' + (state !== 'synced' ? ` ${state}` : '');
  if (state === 'syncing') {
    el.innerHTML = '<i class="ph ph-arrows-clockwise"></i><span>A sincronizar...</span>';
  } else if (state === 'error') {
    el.innerHTML = '<i class="ph ph-warning-circle"></i><span>Erro sync</span>';
  } else {
    el.innerHTML = '<i class="ph ph-check-circle"></i><span>Sincronizado</span>';
  }
}


// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
//  ALTERAR NOME DE UTILIZADOR
// ─────────────────────────────────────────────────────────────
async function saveDisplayName() {
  const input = document.getElementById('displayNameInput');
  const name  = input?.value?.trim();
  if (!name) { showToast('Escreve um nome primeiro.', 'warning'); return; }

  const { error } = await sb.auth.updateUser({ data: { name } });
  if (error) { showToast('Erro ao guardar nome.', 'warning'); return; }

  const nameEl = document.getElementById('sidebarName');
  const initial = name.charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = name;

  const saved = localStorage.getItem('_bk_avatar');
  if (!saved) {
    const sidebarAv  = document.getElementById('sidebarAvatar');
    const settingsAv = document.getElementById('settingsAvatar');
    if (sidebarAv)  sidebarAv.textContent  = initial;
    if (settingsAv) settingsAv.textContent = initial;
  }

  if (input) input.value = '';
  showToast('Nome actualizado! ✓', 'success');
}

// ─────────────────────────────────────────────────────────────
//  SUPABASE REALTIME — sincronização entre dispositivos
// ─────────────────────────────────────────────────────────────
let _realtimeChannel = null;

function startRealtimeSync() {
  if (!_currentUserId) return;
  if (_realtimeChannel) { sb.removeChannel(_realtimeChannel); }

  _realtimeChannel = sb
    .channel('user_data_changes')
    .on(
      'postgres_changes',
      {
        event:  'UPDATE',
        schema: 'public',
        table:  'user_data',
        filter: `user_id=eq.${_currentUserId}`,
      },
      async (payload) => {
        console.log('[realtime] dados actualizados noutro dispositivo');
        const d = payload.new;
        if (!d) return;

        if (Array.isArray(d.tasks))         MEM.tasks        = d.tasks;
        if (Array.isArray(d.notebooks))     MEM.notebooks    = d.notebooks;
        if (typeof d.sessions === 'number') MEM.sessions     = d.sessions;
        if (typeof d.minutes  === 'number') MEM.minutes      = d.minutes;
        if (d.history)                      MEM.history      = d.history;
        if (d.sleep_history)                MEM.sleepHistory = d.sleep_history;
        if (d.theme)                        MEM.theme        = d.theme;

        if (d.sleep) {
          const bedEl  = document.getElementById('sleepBedtime');
          const wakeEl = document.getElementById('sleepWake');
          if (bedEl)  bedEl.value  = d.sleep.bed  || '';
          if (wakeEl) wakeEl.value = d.sleep.wake || '';
          calcSleep();
        }

        await _persistLocal();

        applyTheme(MEM.theme, false);
        renderTasks();
        renderNotebooks();
        loadNoteContent();
        renderChart();
        renderSleepChart();
        renderSessionDots();
        updateStats();
        updateStatSleep();

        showToast('Dados actualizados de outro dispositivo 🔄', 'info');
      }
    )
    .subscribe((status) => {
      console.log('[realtime] status:', status);
    });
}

const SECTION_META = {
  overview: { title:'Visão Geral',    sub:'Bem-vindo de volta!' },
  timer:    { title:'Timer Pomodoro', sub:'Foco total — sem distrações.' },
  tasks:    { title:'Tarefas',        sub:'Arraste para reordenar. Use #tag para categorizar.' },
  notes:    { title:'Bloco de Notas', sub:'Múltiplos cadernos, salvos automaticamente.' },
  sleep:    { title:'Sono',           sub:'Monitorize a sua qualidade de sono.' },
};

function navigate(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(`sec-${el.dataset.section}`).classList.add('active');
  const m = SECTION_META[el.dataset.section];
  if (m) {
    document.getElementById('sectionTitle').textContent = m.title;
    document.getElementById('sectionSub').textContent   = m.sub;
  }
  closeSidebar();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

// ─────────────────────────────────────────────────────────────
//  LOGOUT MANUAL (botão nas Definições)
// ─────────────────────────────────────────────────────────────
async function handleLogout() {
  closeSettings();
  showToast('A terminar sessão...', 'info');
  // Limpar tokens residuais
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('sb-') || k.includes('supabase')) localStorage.removeItem(k);
  });
  await sb.auth.signOut();
  window.location.href = 'login.html';
}

// ─────────────────────────────────────────────────────────────
//  TEMAS
// ─────────────────────────────────────────────────────────────
const THEME_COLORS = {
  coffee:   '#3e2723',
  ocean:    '#0d1b2a',
  forest:   '#1b2a1e',
  midnight: '#000000',
};

function setTheme(name, el) {
  applyTheme(name, true);
  // Actualizar botões no modal
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  else document.querySelector(`[data-theme="${name}"]`)?.classList.add('active');
}

function applyTheme(name, save = true) {
  document.body.setAttribute('data-theme', name === 'coffee' ? '' : name);
  // Actualizar theme-color meta tag (PWA)
  document.getElementById('themeColorMeta').setAttribute('content', THEME_COLORS[name] || '#3e2723');
  MEM.theme = name;
  if (save) persist('acadOS_theme', name);
  // Marcar botão correcto
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === name);
  });
}

// ─────────────────────────────────────────────────────────────
//  DEFINIÇÕES
// ─────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settingsOverlay').classList.add('show');
  document.getElementById('settingsModal').classList.add('show');
  // Pré-preencher nome actual
  const nameEl = document.getElementById('sidebarName');
  const nameInput = document.getElementById('displayNameInput');
  if (nameInput && nameEl) nameInput.value = nameEl.textContent !== 'Estudante' ? nameEl.textContent : '';
  // Carregar avatar guardado
  _refreshAvatarUI();
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('show');
  document.getElementById('settingsModal').classList.remove('show');
}

function _refreshAvatarUI() {
  const saved = localStorage.getItem('_bk_avatar');
  const previewEl = document.getElementById('settingsAvatar');
  const sidebarEl = document.getElementById('sidebarAvatar');
  const removeBtn = document.getElementById('btnRemoveAvatar');
  if (saved) {
    // Mostrar foto
    const imgStyle = `background-image:url(${saved});background-size:cover;background-position:center;font-size:0;`;
    if (previewEl) previewEl.style.cssText = imgStyle;
    if (sidebarEl) { sidebarEl.style.cssText = imgStyle; sidebarEl.textContent = ''; }
    if (removeBtn) removeBtn.style.display = '';
  } else {
    // Iniciais
    if (previewEl) { previewEl.removeAttribute('style'); }
    if (sidebarEl) { sidebarEl.removeAttribute('style'); }
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function toggleSoundStatus(el) {
  enableSound = el.checked;
  document.getElementById('soundSelectRow').style.opacity = enableSound ? '1' : '0.5';
  document.getElementById('soundType').disabled = !enableSound;
}

function toggleNotifications(el) {
  if (!el.checked) { enableNotifications = false; return; }
  if (!('Notification' in window)) { showToast('Navegador não suporta notificações.','warning'); el.checked=false; return; }
  Notification.requestPermission().then(p => { enableNotifications = p==='granted'; if (!enableNotifications) el.checked=false; });
}

function playAlertSound() {
  if (!enableSound) return;
  const type = document.getElementById('soundType').value;
  try {
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    if (type==='bell') {
      const o=ctx.createOscillator(),g=ctx.createGain(); o.connect(g); g.connect(ctx.destination);
      o.frequency.value=660; g.gain.setValueAtTime(.2,ctx.currentTime); g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+1.2);
      o.start(); o.stop(ctx.currentTime+1.2);
    } else if (type==='digital') {
      for (let i=0;i<3;i++) {
        const o=ctx.createOscillator(),g=ctx.createGain(); o.type='square'; o.connect(g); g.connect(ctx.destination);
        o.frequency.value=800; g.gain.setValueAtTime(.1,ctx.currentTime+i*.25); g.gain.setValueAtTime(0,ctx.currentTime+i*.25+.1);
        o.start(ctx.currentTime+i*.25); o.stop(ctx.currentTime+i*.25+.1);
      }
    } else if (type==='gong') {
      const o=ctx.createOscillator(),g=ctx.createGain(); o.connect(g); g.connect(ctx.destination);
      o.frequency.value=220; g.gain.setValueAtTime(.3,ctx.currentTime); g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+2.5);
      o.start(); o.stop(ctx.currentTime+2.5);
    }
  } catch(e) {}
}
function testSound() { playAlertSound(); }

// ─────────────────────────────────────────────────────────────
//  TIMER POMODORO
// ─────────────────────────────────────────────────────────────
const TIMER_MODES = { focus:25, short:5, long:15 };
let timerMode='focus', timerDuration=1500, timerRemaining=1500, timerInterval=null, timerRunning=false;

// Persistir estado do timer (sobrevive a reload durante sessão)
function saveTimerState() {
  sessionStorage.setItem('_bk_timer', JSON.stringify({
    mode: timerMode, duration: timerDuration, remaining: timerRemaining,
    running: timerRunning, ts: Date.now()
  }));
}

function loadTimerState() {
  try {
    const s = JSON.parse(sessionStorage.getItem('_bk_timer') || 'null');
    if (!s) return;
    timerMode     = s.mode     || 'focus';
    timerDuration = s.duration || 1500;
    // Corrigir o tempo passado desde o último save (se estava a correr)
    if (s.running) {
      const elapsed = Math.floor((Date.now() - s.ts) / 1000);
      timerRemaining = Math.max(0, s.remaining - elapsed);
      if (timerRemaining > 0) {
        // Restaurar tab activa
        document.querySelectorAll('.timer-tab').forEach(t => t.classList.remove('active'));
        document.querySelector(`.timer-tab[onclick*="${timerMode}"]`)?.classList.add('active');
        document.getElementById('timerLabel').textContent = {focus:'FOCO',short:'PAUSA CURTA',long:'PAUSA LONGA'}[timerMode];
        startTimer(); // retomar
      }
    } else {
      timerRemaining = s.remaining || timerDuration;
    }
    // Restaurar tab visual
    document.querySelectorAll('.timer-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.timer-tab[onclick*="${timerMode}"]`)?.classList.add('active');
    document.getElementById('timerLabel').textContent = {focus:'FOCO',short:'PAUSA CURTA',long:'PAUSA LONGA'}[timerMode];
  } catch(e) { /* ignorar state corrompido */ }
}

function updateTimerConfig() {
  TIMER_MODES.focus = parseInt(document.getElementById('cfg-focus').value)||25;
  TIMER_MODES.short = parseInt(document.getElementById('cfg-short').value)||5;
  TIMER_MODES.long  = parseInt(document.getElementById('cfg-long').value) ||15;
  if (!timerRunning) { timerDuration=timerRemaining=TIMER_MODES[timerMode]*60; renderTimer(); }
}

function setTimerMode(mode,el) {
  if (timerRunning) return;
  timerMode=mode; timerDuration=timerRemaining=TIMER_MODES[mode]*60;
  document.querySelectorAll('.timer-tab').forEach(t=>t.classList.remove('active')); el.classList.add('active');
  document.getElementById('timerLabel').textContent={focus:'FOCO',short:'PAUSA CURTA',long:'PAUSA LONGA'}[mode];
  renderTimer();
  saveTimerState(); // Fix #5 — guardar modo mesmo sem iniciar
}

function renderTimer() {
  const mm=String(Math.floor(timerRemaining/60)).padStart(2,'0');
  const ss=String(timerRemaining%60).padStart(2,'0');
  document.getElementById('timerDisplay').textContent=`${mm}:${ss}`;
  document.getElementById('timerRingFg').style.strokeDashoffset=(2*Math.PI*80)*(1-timerRemaining/timerDuration);
}

function toggleTimer() { timerRunning?pauseTimer():startTimer(); }

function startTimer() {
  timerRunning=true;
  document.getElementById('startPauseIcon').className='ph ph-pause';
  document.getElementById('startPauseText').textContent='Pausar';
  timerInterval=setInterval(()=>{
    timerRemaining--; renderTimer(); saveTimerState();
    if (timerRemaining<=0) { clearInterval(timerInterval); timerRunning=false; saveTimerState(); onTimerComplete(); }
  },1000);
  saveTimerState();
}

function pauseTimer() {
  clearInterval(timerInterval); timerRunning=false;
  document.getElementById('startPauseIcon').className='ph ph-play';
  document.getElementById('startPauseText').textContent='Continuar';
  saveTimerState();
}

function resetTimer() {
  clearInterval(timerInterval); timerRunning=false; timerRemaining=timerDuration;
  document.getElementById('startPauseIcon').className='ph ph-play';
  document.getElementById('startPauseText').textContent='Iniciar';
  renderTimer(); saveTimerState();
}

function skipTimer() { clearInterval(timerInterval); timerRunning=false; timerRemaining=0; renderTimer(); onTimerComplete(); }

function onTimerComplete() {
  document.getElementById('startPauseIcon').className='ph ph-play';
  document.getElementById('startPauseText').textContent='Iniciar';
  playAlertSound();
  if (enableNotifications && Notification.permission==='granted') new Notification('Timer Concluído!',{body:'O seu tempo acabou.'});
  if (timerMode==='focus') {
    MEM.sessions++; MEM.minutes+=TIMER_MODES.focus;
    persist('acadOS_sessions', MEM.sessions);
    persist('acadOS_minutes',  MEM.minutes);
    const todayKey=new Date().toISOString().split('T')[0];
    MEM.history[todayKey]=(MEM.history[todayKey]||0)+TIMER_MODES.focus;
    persist('acadOS_history', MEM.history);
    showToast('Sessão de foco concluída! 🎉','success');
    updateStats(); renderSessionDots(); renderChart();
  } else {
    showToast('Pausa terminada. Vamos continuar!','info');
  }
  timerRemaining=timerDuration;
  renderTimer();
  // Fix #5 — limpar estado após conclusão (evita restaurar remaining:0 num reload)
  sessionStorage.removeItem('_bk_timer');
}

function renderSessionDots() {
  const c=document.getElementById('sessionDots'); c.innerHTML='';
  for (let i=0;i<4;i++) {
    const d=document.createElement('div');
    d.className='session-dot'+(i<(MEM.sessions%4)?' done':'');
    c.appendChild(d);
  }
}

// Vincular tarefa ao Pomodoro
function setFocusTask(id, text) {
  currentFocusTaskId=id;
  document.getElementById('focusTaskLabel').textContent='A focar em: '+text;
  document.getElementById('clearFocusBtn').style.display='';
  navigate(document.querySelector('[data-section="timer"]'));
}

function clearFocusTask() {
  currentFocusTaskId=null;
  document.getElementById('focusTaskLabel').textContent='Nenhuma tarefa vinculada (Foco Livre)';
  document.getElementById('clearFocusBtn').style.display='none';
}

// ─────────────────────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const d=document.createElement('div'); d.textContent=String(str||''); return d.innerHTML;
}

// Extrair tags (#palavra) do texto
function extractTags(text) {
  return (text.match(/#\w+/g)||[]).map(t=>t.toLowerCase());
}

// Texto sem as tags para exibição
function stripTags(text) {
  return text.replace(/#\w+/g,'').trim();
}

// Data de hoje YYYY-MM-DD
function today() { return new Date().toISOString().split('T')[0]; }

// ─────────────────────────────────────────────────────────────
//  TAREFAS — operações sobre MEM.tasks (sem I/O extra)
// ─────────────────────────────────────────────────────────────

function saveTasks() {
  persist('acadOS_tasks', MEM.tasks);
}

function addTask() {
  const input   = document.getElementById('taskInput');
  const text    = input.value.trim();
  const dueDate = document.getElementById('taskDueDate').value;
  const recur   = document.getElementById('taskRecurrence').value;
  if (!text) return;
  const tags = extractTags(text);
  MEM.tasks.unshift({
    id:         Date.now(),
    text,
    tags,
    done:       false,
    priority:   document.getElementById('taskPriority').value,
    dueDate,
    recurrence: recur,
    subtasks:   [],
  });
  saveTasks();
  input.value='';
  renderTasks();
  updateStats();
}

function toggleTask(id) {
  const task = MEM.tasks.find(t=>t.id===id);
  if (!task) return;
  task.done = !task.done;

  // Recorrência: recriar a próxima instância ao concluir
  if (task.done && task.recurrence) {
    const nextDate = calcNextDate(task.dueDate, task.recurrence);
    MEM.tasks.unshift({
      ...task,
      id:       Date.now()+1,
      done:     false,
      dueDate:  nextDate,
      subtasks: task.subtasks.map(s=>({...s, done:false})),
    });
  }

  saveTasks(); renderTasks(); updateStats();
}

function editTask(id) {
  const task = MEM.tasks.find(t => t.id === id);
  if (!task) return;
  openTextModal({
    title:       'Editar Tarefa',
    placeholder: 'Texto da tarefa...',
    initial:     task.text,
    confirmText: 'Guardar',
    onConfirm:   (val) => {
      if (!val.trim()) return;
      task.text = val.trim();
      task.tags = extractTags(val);
      saveTasks();
      renderTasks();
      updateStats();
    }
  });
}

function deleteTask(id) {
  MEM.tasks = MEM.tasks.filter(t=>t.id!==id);
  saveTasks(); renderTasks(); updateStats();
}

function clearCompletedTasks() {
  const count = MEM.tasks.filter(t => t.done).length;
  if (count === 0) { showToast('Sem tarefas concluídas para remover.', 'info'); return; }
  openConfirmModal({
    title:       'Limpar Concluídas',
    message:     `Vai remover <strong>${count} tarefa${count !== 1 ? 's' : ''} concluída${count !== 1 ? 's' : ''}</strong>. Esta acção não pode ser desfeita.`,
    confirmText: 'Limpar',
    danger:      true,
    onConfirm:   () => {
      MEM.tasks = MEM.tasks.filter(t => !t.done);
      saveTasks(); renderTasks(); updateStats();
      showToast(`${count} tarefa${count !== 1 ? 's' : ''} removida${count !== 1 ? 's' : ''}.`, 'info');
    }
  });
}

function calcNextDate(dateStr, recurrence) {
  const base = dateStr ? new Date(dateStr) : new Date();
  if (recurrence==='daily')  base.setDate(base.getDate()+1);
  if (recurrence==='weekly') base.setDate(base.getDate()+7);
  return base.toISOString().split('T')[0];
}

function filterTasks(f, btn) {
  taskFilter    = f;
  activeTagFilter = null;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderTasks();
}

function filterByTag(tag, btn) {
  activeTagFilter = tag;
  taskFilter = 'all';
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderTasks();
}

function renderTasks() {
  const todayStr = today();

  // Filtrar lista
  let tasks = [...MEM.tasks];
  if (taskFilter==='pending') tasks = tasks.filter(t=>!t.done);
  if (taskFilter==='done')    tasks = tasks.filter(t=> t.done);
  if (activeTagFilter)        tasks = tasks.filter(t=>(t.tags||[]).includes(activeTagFilter));

  const listEl = document.getElementById('taskList');

  if (tasks.length===0) {
    listEl.innerHTML='<div style="text-align:center;padding:24px 0;color:rgba(255,255,255,.3);font-size:13px;">Sem tarefas para mostrar</div>';
  } else {
    listEl.innerHTML = tasks.map(task => {
      const tagsHtml = (task.tags||[]).map(tag=>`<span class="task-tag">${escapeHtml(tag)}</span>`).join('');
      const dateHtml = task.dueDate
        ? `<span class="task-due ${task.dueDate<todayStr&&!task.done?'due-late':''}">${task.dueDate.split('-').reverse().join('/')}</span>`
        : '';
      const recurHtml = task.recurrence
        ? `<span class="task-recurrence">↺ ${task.recurrence==='daily'?'diária':'semanal'}</span>`
        : '';
      // Barra de progresso das subtarefas
      const subs    = task.subtasks||[];
      const subDone = subs.filter(s=>s.done).length;
      const subBar  = subs.length>0
        ? `<div class="subtask-bar"><div class="subtask-fill" style="width:${Math.round(subDone/subs.length*100)}%"></div></div>`
        : '';

      return `
        <div class="task-item ${task.done?'completed':''}" data-id="${task.id}">
          <div class="task-main-row">
            <div class="task-check" data-action="toggle">${task.done?'<i class="ph ph-check"></i>':''}</div>
            <div class="task-priority p-${task.priority}"></div>
            <div class="task-body">
              <div class="task-text">${escapeHtml(stripTags(task.text))}</div>
              <div class="task-meta">${tagsHtml}${dateHtml}${recurHtml}</div>
              ${subBar}
            </div>
          </div>
          <div class="task-actions">
            <button class="btn-icon-small" data-action="edit" title="Editar">
              <i class="ph ph-pencil-simple"></i>
            </button>
            <button class="btn-icon-small" data-action="subtask" title="Subtarefas (${subDone}/${subs.length})">
              <i class="ph ph-list-checks"></i>
            </button>
            <button class="btn-icon-small" data-action="focus" data-text="${escapeHtml(stripTags(task.text))}" title="Focar">
              <i class="ph ph-target"></i>
            </button>
            <i class="ph ph-trash task-del btn-icon-small" data-action="delete" title="Apagar"></i>
          </div>
        </div>`;
    }).join('');
  }

  // Event delegation — um único listener para toda a lista
  listEl.onclick = (e) => {
    const item   = e.target.closest('.task-item');
    const btn    = e.target.closest('[data-action]');
    if (!item || !btn) return;
    const id     = parseInt(item.dataset.id);
    const action = btn.dataset.action;
    if (action==='toggle')  toggleTask(id);
    if (action==='edit')    editTask(id);
    if (action==='delete')  deleteTask(id);
    if (action==='focus')   setFocusTask(id, btn.dataset.text);
    if (action==='subtask') openSubtaskModal(id);
  };

  // Renderizar filtros de tags dinâmicos
  renderTagFilters();

  // Actualizar overview
  renderOverviewTasks();

  // SortableJS — destruir instância anterior
  if (sortableInstance) { sortableInstance.destroy(); sortableInstance=null; }
  sortableInstance = new Sortable(listEl, {
    animation: 150,
    ghostClass: 'sortable-ghost',
    // Ignorar cliques nos botões de acção
    filter: '[data-action]',
    onEnd: () => {
      const ids = Array.from(listEl.querySelectorAll('.task-item')).map(el=>parseInt(el.dataset.id));
      const reordered=[], remaining=[];
      ids.forEach(id=>{ const f=MEM.tasks.find(t=>t.id===id); if(f) reordered.push(f); });
      MEM.tasks.forEach(t=>{ if(!reordered.find(r=>r.id===t.id)) remaining.push(t); });
      MEM.tasks=[...reordered,...remaining];
      saveTasks();
    }
  });

  initSwipeGestures();
}

function renderTagFilters() {
  // Recolher todas as tags únicas
  const allTags = [...new Set(MEM.tasks.flatMap(t=>t.tags||[]))];
  const bar = document.getElementById('taskFilters');

  // Remover tags antigas, manter os primeiros 3 botões fixos
  bar.querySelectorAll('.filter-btn-tag').forEach(b=>b.remove());

  allTags.forEach(tag => {
    const btn=document.createElement('button');
    btn.className='filter-btn filter-btn-tag'+(activeTagFilter===tag?' active':'');
    btn.textContent=tag;
    btn.onclick=()=>filterByTag(tag,btn);
    bar.appendChild(btn);
  });
}

function renderOverviewTasks() {
  const el = document.getElementById('overviewTasks');
  const pending = MEM.tasks.filter(t=>!t.done).slice(0,4);
  if (!pending.length) { el.innerHTML='<div style="color:rgba(255,255,255,.3);font-size:13px;text-align:center;padding:12px 0">Sem tarefas pendentes</div>'; return; }
  el.innerHTML = pending.map(t=>`
    <div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.08)">
      <div class="task-priority p-${t.priority}"></div>
      ${escapeHtml(stripTags(t.text))}
    </div>`).join('');
}

function initSwipeGestures() {
  document.querySelectorAll('.task-item').forEach(item => {
    let sx=0;
    item.addEventListener('touchstart', e=>{ sx=e.changedTouches[0].screenX; },{ passive:true });
    item.addEventListener('touchend',   e=>{
      const dx=e.changedTouches[0].screenX-sx;
      if (dx<-40) item.classList.add('swiped-left');
      if (dx> 40) item.classList.remove('swiped-left');
    });
  });
}

// ─────────────────────────────────────────────────────────────
//  SUBTAREFAS
// ─────────────────────────────────────────────────────────────
function openSubtaskModal(taskId) {
  activeSubtaskId = taskId;
  const task = MEM.tasks.find(t=>t.id===taskId);
  if (!task) return;
  document.getElementById('subtaskParentTitle').textContent = stripTags(task.text);
  document.getElementById('subtaskInput').value='';
  renderSubtaskList(task);
  document.getElementById('subtaskOverlay').classList.add('show');
  document.getElementById('subtaskModal').classList.add('show');
  document.getElementById('subtaskInput').focus();
}

function closeSubtaskModal() {
  document.getElementById('subtaskOverlay').classList.remove('show');
  document.getElementById('subtaskModal').classList.remove('show');
  activeSubtaskId=null;
  renderTasks(); // actualizar barra de progresso
}

function addSubtask() {
  const text=document.getElementById('subtaskInput').value.trim();
  if (!text||!activeSubtaskId) return;
  const task=MEM.tasks.find(t=>t.id===activeSubtaskId);
  if (!task) return;
  if (!task.subtasks) task.subtasks=[];
  task.subtasks.push({ id:Date.now(), text, done:false });
  saveTasks();
  document.getElementById('subtaskInput').value='';
  renderSubtaskList(task);
}

function toggleSubtask(taskId, subId) {
  const task=MEM.tasks.find(t=>t.id===taskId);
  if (!task) return;
  const sub=task.subtasks.find(s=>s.id===subId);
  if (sub) sub.done=!sub.done;
  saveTasks();
  renderSubtaskList(task);
}

function deleteSubtask(taskId, subId) {
  const task=MEM.tasks.find(t=>t.id===taskId);
  if (!task) return;
  task.subtasks=task.subtasks.filter(s=>s.id!==subId);
  saveTasks();
  renderSubtaskList(task);
}

function renderSubtaskList(task) {
  const el=document.getElementById('subtaskList');
  const subs=task.subtasks||[];
  if (!subs.length) { el.innerHTML='<div style="color:rgba(255,255,255,.3);font-size:13px;text-align:center;padding:12px 0">Sem subtarefas</div>'; return; }
  el.innerHTML=subs.map(s=>`
    <div class="subtask-item ${s.done?'done':''}" style="margin-bottom:6px;">
      <div class="subtask-check" onclick="toggleSubtask(${task.id},${s.id})">${s.done?'<i class="ph ph-check"></i>':''}</div>
      <div class="subtask-text">${escapeHtml(s.text)}</div>
      <button class="btn-icon-small" onclick="deleteSubtask(${task.id},${s.id})"><i class="ph ph-x"></i></button>
    </div>`).join('');
}

// ─────────────────────────────────────────────────────────────
//  ESTATÍSTICAS
// ─────────────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-hours').textContent    = (MEM.minutes/60).toFixed(1)+'h';
  document.getElementById('stat-sessions').textContent = MEM.sessions;
  document.getElementById('stat-tasks').textContent    = MEM.tasks.filter(t=>!t.done).length;
}

// Fix #3 — stat-sleep calculado a partir do histórico no arranque
// (não requer o utilizador ir à secção Sono e carregar)
function updateStatSleep() {
  const el = document.getElementById('stat-sleep');
  if (!el) return;
  const todayMin = MEM.sleepHistory[today()];
  if (todayMin && todayMin > 0) {
    el.textContent = `${Math.floor(todayMin / 60)}h`;
  } else {
    // Tentar o dia anterior (o utilizador pode ter registado ontem à noite)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    const yMin = MEM.sleepHistory[yStr];
    el.textContent = (yMin && yMin > 0) ? `${Math.floor(yMin / 60)}h` : '—';
  }
}

async function renderChart() {
  const canvas = document.getElementById('focusChart');
  if (!canvas) return;

  // Aguardar Chart.js estar disponível (CDN pode demorar)
  if (typeof Chart === 'undefined') {
    setTimeout(renderChart, 300);
    return;
  }

  // Destruir instância anterior
  if (window._focusChart) {
    window._focusChart.destroy();
    window._focusChart = null;
  }

  const labels = [], data = [];
  for (let i = 6; i >= 0; i--) {
    const d  = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().split('T')[0];
    labels.push(`${d.getDate()}/${d.getMonth() + 1}`);
    data.push(MEM.history[ds] || 0);
  }

  Chart.defaults.color       = 'rgba(255,255,255,0.5)';
  Chart.defaults.font.family = "'DM Mono',monospace";

  const hasData = data.some(v => v > 0);

  window._focusChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label:           'Minutos',
        data,
        backgroundColor: 'rgba(255,255,255,0.75)',
        borderRadius:    4,
        // Altura mínima visível mesmo sem dados (1px) para o gráfico não ficar em branco
        minBarLength:    hasData ? 0 : 0,
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      animation:           { duration: 600 },
      plugins: {
        legend: { display: false },
        // Mensagem quando não há dados
        ...(hasData ? {} : {
          customCanvasBackgroundColor: { color: 'transparent' }
        })
      },
      scales: {
        y: {
          beginAtZero: true,
          border:      { display: false },
          min:         0,
          // Mostrar escala 0-60 mesmo sem dados para o gráfico ser visível
          suggestedMax: hasData ? undefined : 60,
          ticks: {
            stepSize: hasData ? undefined : 20,
            color: 'rgba(255,255,255,0.4)',
          },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: {
          grid:  { display: false },
          ticks: { color: 'rgba(255,255,255,0.4)' }
        },
      }
    }
  });

  // Se não há dados, mostrar texto de dica dentro do canvas
  if (!hasData) {
    const ctx2 = canvas.getContext('2d');
    ctx2.save();
    ctx2.font         = "13px 'DM Mono', monospace";
    ctx2.fillStyle    = 'rgba(255,255,255,0.25)';
    ctx2.textAlign    = 'center';
    ctx2.textBaseline = 'middle';
    ctx2.fillText('Complete uma sessão Pomodoro para ver o progresso',
                  canvas.width / 2, canvas.height / 2);
    ctx2.restore();
  }
}

// ─────────────────────────────────────────────────────────────
//  NOTAS — Múltiplos Cadernos
// ─────────────────────────────────────────────────────────────
let noteSaveTimer=null;

function autoSaveNote() {
  if (!MEM.activeNoteId) return;
  clearTimeout(noteSaveTimer);
  noteSaveTimer=setTimeout(()=>{
    const nb=MEM.notebooks.find(n=>n.id===MEM.activeNoteId);
    if (nb) {
      nb.content=quillEditor.root.innerHTML;
      persist('acadOS_notebooks', MEM.notebooks);
      const badge=document.getElementById('savedBadge');
      badge.style.opacity=1;
      setTimeout(()=>badge.style.opacity=0, 2000);
    }
  }, 600);
}

function renderNotebooks() {
  const list=document.getElementById('notebooksList');
  list.innerHTML=MEM.notebooks.map(nb=>`
    <button class="notebook-tab ${nb.id===MEM.activeNoteId?'active':''}"
            onclick="switchNotebook(${nb.id})">${escapeHtml(nb.name)}</button>`).join('');
}

function switchNotebook(id) {
  // Guardar conteúdo actual antes de trocar
  if (MEM.activeNoteId && quillEditor) {
    const cur=MEM.notebooks.find(n=>n.id===MEM.activeNoteId);
    if (cur) cur.content=quillEditor.root.innerHTML;
  }
  MEM.activeNoteId=id;
  persist('acadOS_notebooks', MEM.notebooks);
  loadNoteContent();
  renderNotebooks();
}

function loadNoteContent() {
  if (!quillEditor) return;
  const nb=MEM.notebooks.find(n=>n.id===MEM.activeNoteId);
  quillEditor.root.innerHTML=nb?nb.content:'';
}

function createNotebook() {
  openTextModal({
    title:       'Novo Caderno',
    placeholder: 'Nome do caderno...',
    confirmText: 'Criar',
    onConfirm:   (name) => {
      if (!name || !name.trim()) return;
      const nb = { id: Date.now(), name: name.trim(), content: '' };
      MEM.notebooks.push(nb);
      persist('acadOS_notebooks', MEM.notebooks);
      switchNotebook(nb.id);
    }
  });
}

function renameNotebook() {
  const nb = MEM.notebooks.find(n => n.id === MEM.activeNoteId);
  if (!nb) return;
  openTextModal({
    title:       'Renomear Caderno',
    placeholder: 'Nome do caderno...',
    initial:     nb.name,
    confirmText: 'Guardar',
    onConfirm:   (name) => {
      if (!name || !name.trim()) return;
      nb.name = name.trim();
      persist('acadOS_notebooks', MEM.notebooks);
      renderNotebooks();
    }
  });
}

function deleteNotebook() {
  if (MEM.notebooks.length <= 1) { showToast('Precisa de pelo menos um caderno.', 'warning'); return; }
  const nb = MEM.notebooks.find(n => n.id === MEM.activeNoteId);
  openConfirmModal({
    title:       'Apagar Caderno',
    message:     `Tem a certeza que quer apagar <strong>"${escapeHtml(nb?.name || '')}"</strong>? Esta acção não pode ser desfeita.`,
    confirmText: 'Apagar',
    danger:      true,
    onConfirm:   () => {
      MEM.notebooks = MEM.notebooks.filter(n => n.id !== MEM.activeNoteId);
      MEM.activeNoteId = MEM.notebooks[0].id;
      persist('acadOS_notebooks', MEM.notebooks);
      loadNoteContent();
      renderNotebooks();
      showToast('Caderno apagado.', 'info');
    }
  });
}

// ── Exportar nota activa para PDF via print
function exportNoteToPDF() {
  const nb=MEM.notebooks.find(n=>n.id===MEM.activeNoteId);
  if (!nb) return;
  const win=window.open('','_blank');
  win.document.write(`
    <!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${escapeHtml(nb.name)}</title>
    <style>
      body { font-family: 'Georgia',serif; max-width: 700px; margin: 40px auto; color: #111; line-height: 1.7; }
      h1 { font-size: 22px; margin-bottom: 24px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
    </style></head><body>
    <h1>${escapeHtml(nb.name)}</h1>
    ${nb.content}
    <script>window.onload=()=>{window.print();window.close();}<\/script>
    </body></html>`);
  win.document.close();
}

// ─────────────────────────────────────────────────────────────
//  SONO
// ─────────────────────────────────────────────────────────────
function calcSleep() {
  const bed=document.getElementById('sleepBedtime').value;
  const wak=document.getElementById('sleepWake').value;
  if (!bed||!wak) return 0;
  const [bh,bm]=bed.split(':').map(Number),[wh,wm]=wak.split(':').map(Number);
  let total=(wh*60+wm)-(bh*60+bm);
  if (total<=0) total+=1440;
  document.getElementById('sleepHoursDisplay').textContent=`${Math.floor(total/60)}h ${String(total%60).padStart(2,'0')}min`;
  document.getElementById('stat-sleep').textContent=`${Math.floor(total/60)}h`;
  const badge=document.getElementById('sleepQualityBadge');
  badge.className='sleep-quality';
  if (total>=420&&total<=540)     { badge.classList.add('sq-good'); badge.textContent='✓ Ideal'; }
  else if (total>=360)            { badge.classList.add('sq-ok');   badge.textContent='⚡ Razoável'; }
  else                             { badge.classList.add('sq-bad');  badge.textContent='⚠ Insuficiente'; }
  return total;
}

async function saveSleep() {
  const bed=document.getElementById('sleepBedtime').value;
  const wak=document.getElementById('sleepWake').value;
  persist('acadOS_sleep',{bed,wak});
  const total=calcSleep();
  MEM.sleepHistory[today()]=total;
  persist('acadOS_sleep_history', MEM.sleepHistory);
  updateStatSleep();
  showToast('Registo de sono guardado! 🌙','success');
  renderSleepChart();
}

function renderSleepChart() {
  const canvas=document.getElementById('sleepChart');
  if (!canvas) return;

  // Guard: aguardar Chart.js (igual ao renderChart de foco)
  if (typeof Chart === 'undefined') {
    setTimeout(renderSleepChart, 300);
    return;
  }

  const labels=[],data=[];
  for (let i=6;i>=0;i--) {
    const d=new Date(); d.setDate(d.getDate()-i);
    const ds=d.toISOString().split('T')[0];
    labels.push(`${d.getDate()}/${d.getMonth()+1}`);
    data.push(Number(((MEM.sleepHistory[ds]||0)/60).toFixed(1)));
  }
  if (window._sleepChart) window._sleepChart.destroy();
  window._sleepChart=new Chart(canvas.getContext('2d'),{
    type:'bar',
    data:{ labels, datasets:[{ label:'Horas', data, backgroundColor:'rgba(165,214,167,0.8)', borderRadius:4 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ y:{ beginAtZero:true, max:12, border:{ display:false } }, x:{ grid:{ display:false } } } }
  });
}

// ─────────────────────────────────────────────────────────────
//  EXPORTAR / IMPORTAR DADOS
// ─────────────────────────────────────────────────────────────
async function exportData() {
  const keys=['acadOS_tasks','acadOS_notebooks','acadOS_sleep','acadOS_sessions',
              'acadOS_minutes','acadOS_history','acadOS_sleep_history','acadOS_theme'];
  const obj={};
  for (const k of keys) obj[k]=await localforage.getItem(k);
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`brainkaizen_backup_${today()}.json`;
  a.click();
  showToast('Dados exportados!','success');
}

async function importData(event) {
  const file=event.target.files[0];
  if (!file) return;
  try {
    const data=JSON.parse(await file.text());
    for (const [k,v] of Object.entries(data)) if (v!==null) await localforage.setItem(k,v);
    showToast('Dados importados! A recarregar...','success');
    setTimeout(()=>location.reload(), 1500);
  } catch(e) {
    showToast('Erro ao importar. Ficheiro inválido.','warning');
  }
}
