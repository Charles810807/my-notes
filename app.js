
// --- 本地伺服器同步模組 ---
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const SYNC_SERVER_URL = isLocalhost 
  ? window.location.origin 
  : 'http://127.0.0.1:8766';
let isServerOnline = false;
let currentMobileUrl = '';

async function checkSyncServer() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${SYNC_SERVER_URL}/api/sync?_t=${Date.now()}`, { 
      method: 'GET', 
      cache: 'no-store',
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      isServerOnline = true;
      const data = await res.json();
      if (data && data.mobile_url) {
        currentMobileUrl = data.mobile_url;
      }
      updateSyncStatusUI(true);
      return data;
    }
  } catch (e) {
    clearTimeout(timeoutId);
    isServerOnline = false;
    updateSyncStatusUI(false);
  }
  return null;
}


function updateSyncStatusUI(online) {
  // 若非 localhost 本地環境 (如 GitHub Pages)，完全不需要顯示本地 Access MDB 狀態列
  if (!isLocalhost) {
    const existing = document.getElementById('sync-status-indicator');
    if (existing) existing.remove();
    return;
  }

  let indicator = document.getElementById('sync-status-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'sync-status-indicator';
    indicator.className = 'sync-status-badge';
    const footer = document.querySelector('.sidebar-footer');
    if (footer) footer.prepend(indicator);
  }
  if (online) {
    indicator.innerHTML = '<span class="sync-dot online"></span><span>Access MDB 連結同步中</span>';
    indicator.title = '所有文字與圖片已 1:1 即時存入 data/notes.mdb 與 data/images/！';
  } else {
    indicator.innerHTML = '<span class="sync-dot offline"></span><span>純本機模式 (IndexedDB)</span>';
    indicator.title = '若要同步實體檔案到資料夾，請執行 open_notes.bat 啟動同步服務';
  }
}

async function syncNoteToServer(note) {
  // 只在本地伺服器模式 (localhost / 127.0.0.1) 才將圖片轉存為硬碟 data/images/ 實體檔案
  // 若在 GitHub Pages 或雲端環境，維持完整的圖片資料以供跨設備與 Google Drive 同步
  if (!isLocalhost) return;

  // 如果尚未連線，先嘗試連線一次
  if (!isServerOnline) {
    await checkSyncServer();
  }
  if (!isServerOnline) return;
  try {
    const res = await fetch(`${SYNC_SERVER_URL}/api/save_note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.note) {
        if (data.note.images) note.images = data.note.images;
        if (data.note.comments) note.comments = data.note.comments;
        await state.db.saveNote(note); // 確保在 IndexedDB 中也是最新實體路徑
      }
    }
  } catch (e) {
    console.warn('同步到本地伺服器失敗:', e);
  }
}

async function syncDeleteToServer(noteId) {
  if (!isServerOnline) {
    await checkSyncServer();
  }
  if (!isServerOnline) return;
  try {
    await fetch(`${SYNC_SERVER_URL}/api/delete_note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: noteId })
    });
  } catch (e) {
    console.warn('同步刪除到本地伺服器失敗:', e);
  }
}

async function syncCategoriesToServer(categories) {
  if (!isServerOnline) {
    await checkSyncServer();
  }
  if (!isServerOnline) return;
  try {
    await fetch(`${SYNC_SERVER_URL}/api/save_categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories })
    });
  } catch (e) {
    console.warn('同步分類到本地伺服器失敗:', e);
  }
}

async function syncRestoreToServer(notes, categories) {
  if (!isServerOnline) {
    await checkSyncServer();
  }
  if (!isServerOnline) return null;
  try {
    const res = await fetch(`${SYNC_SERVER_URL}/api/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes, categories })
    });
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (e) {
    console.warn('同步備份還原到伺服器失敗:', e);
  }
  return null;
}

// 雲端同步防抖 (已改為全手動同步模式，平常操作不再自動上傳)
function triggerCloudSync() {
  // 全手動模式：由使用者手動點擊 🔄 同步按鈕時才執行
  return;
}

/**
 * 個人圖文記事本 (LINE 記事本替代軟體)
 * 核心功能：IndexedDB 本地儲存、剪貼簿圖片貼上、拖曳上傳、即時搜尋、分類標籤、備份匯出與還原
 */

// --- 1. IndexedDB 資料庫管理模組 ---
const DB_NAME = 'PersonalNotesDB';
const DB_VERSION = 2; // 升級版本以清除舊的亂碼預設資料
const STORE_NOTES = 'notes';
const STORE_SETTINGS = 'settings';

class NotesDB {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          const noteStore = db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
          noteStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          noteStore.createIndex('category', 'category', { unique: false });
          noteStore.createIndex('isPinned', 'isPinned', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error('IndexedDB 打開失敗:', e);
        reject(e);
      };
    });
  }

  async getAllNotes() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_NOTES], 'readonly');
      const store = tx.objectStore(STORE_NOTES);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = (e) => reject(e);
    });
  }

  async saveNote(note) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_NOTES], 'readwrite');
      const store = tx.objectStore(STORE_NOTES);
      const request = store.put(note);
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e);
    });
  }

  async deleteNote(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_NOTES], 'readwrite');
      const store = tx.objectStore(STORE_NOTES);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  async getCategories() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_SETTINGS], 'readonly');
      const store = tx.objectStore(STORE_SETTINGS);
      const request = store.get('categories');
      request.onsuccess = () => {
        if (request.result && Array.isArray(request.result.value)) {
          resolve(request.result.value.filter(c => !c.includes('?')));
        } else {
          resolve([]);
        }
      };
      request.onerror = () => resolve(defaultCats);
    });
  }

  async saveCategories(categories) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_SETTINGS], 'readwrite');
      const store = tx.objectStore(STORE_SETTINGS);
      const request = store.put({ key: 'categories', value: categories });
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }
}

// --- 2. 狀態管理 ---
const state = {
  db: new NotesDB(),
  notes: [],
  categories: [],
  currentCategory: 'all',
  searchQuery: '',
  sortBy: 'updated-desc',
  selectedNoteId: null,
  editingNoteId: null,
  editingCommentId: null,
  currentEditImages: [],
  lightboxImages: [],
  currentLightboxIndex: 0,
  isRestoring: false
};

// DOM 元素快取
const dom = {
  btnNewNote: document.getElementById('btn-new-note'),
  searchInput: document.getElementById('search-input'),
  btnClearSearch: document.getElementById('btn-clear-search'),
  categoryList: document.getElementById('category-list'),
  btnAddCategory: document.getElementById('btn-add-category'),
  countAll: document.getElementById('count-all'),
  countPinned: document.getElementById('count-pinned'),
  btnExportData: document.getElementById('btn-export-data'),
  btnImportTrigger: document.getElementById('btn-import-trigger'),
  fileImport: document.getElementById('file-import'),

  currentViewTitle: document.getElementById('current-view-title'),
  filteredCount: document.getElementById('filtered-count'),
  sortSelect: document.getElementById('sort-select'),
  notesGrid: document.getElementById('notes-grid'),
  emptyState: document.getElementById('empty-state'),

  noteViewPane: document.getElementById('note-view-pane'),

  editorModal: document.getElementById('editor-modal'),
  modalTitle: document.getElementById('modal-title'),
  editPinned: document.getElementById('edit-pinned'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  editTitle: document.getElementById('edit-title'),
  editCategory: document.getElementById('edit-category'),
  btnQuickNewCategory: document.getElementById('btn-quick-new-category'),
  editTags: document.getElementById('edit-tags'),
  editContent: document.getElementById('edit-content'),
  imagesCount: document.getElementById('images-count'),
  btnAddImages: document.getElementById('btn-add-images'),
  fileImagesInput: document.getElementById('file-images-input'),
  dropZone: document.getElementById('drop-zone'),
  imagesPreviewGrid: document.getElementById('images-preview-grid'),
  dropPrompt: document.getElementById('drop-prompt'),
  editTimeTip: document.getElementById('edit-time-tip'),
  btnCancelEdit: document.getElementById('btn-cancel-edit'),
  btnSaveNote: document.getElementById('btn-save-note'),

  lightboxModal: document.getElementById('lightbox-modal'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxClose: document.getElementById('lightbox-close'),
  lightboxDownload: document.getElementById('lightbox-download'),
  lightboxPrev: document.getElementById('lightbox-prev'),
  lightboxNext: document.getElementById('lightbox-next'),
  lightboxCounter: document.getElementById('lightbox-counter'),

  editCommentModal: document.getElementById('edit-comment-modal'),
  editCommentTextarea: document.getElementById('edit-comment-textarea'),
  btnSaveEditComment: document.getElementById('btn-save-edit-comment'),
  btnCancelEditComment: document.getElementById('btn-cancel-edit-comment'),
  btnCloseCommentModal: document.getElementById('btn-close-comment-modal'),
  editCommentBackdrop: document.getElementById('edit-comment-backdrop'),

  toast: document.getElementById('toast'),

  btnMobileConnect: document.getElementById('btn-mobile-connect'),
  mobileModal: document.getElementById('mobile-modal'),
  btnCloseMobileModal: document.getElementById('btn-close-mobile-modal'),
  mobileModalBackdrop: document.getElementById('mobile-modal-backdrop'),
  qrcodeContainer: document.getElementById('qrcode-container'),
  mobileUrlInput: document.getElementById('mobile-url-input'),
  btnCopyMobileUrl: document.getElementById('btn-copy-mobile-url'),

  sidebar: document.querySelector('.sidebar'),
  sidebarOverlay: document.getElementById('sidebar-overlay'),
  btnMobileMenu: document.getElementById('btn-mobile-menu'),
  btnMobileFab: document.getElementById('btn-mobile-fab'),
  notesListSection: document.getElementById('notes-list-section')
};


// --- 3. 工具函式 ---
function generateId() {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (isToday) {
    return `今天 ${hh}:${mm}`;
  }
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function showToast(message, duration = 2500) {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden');
  clearTimeout(dom.toast._timer);
  dom.toast._timer = setTimeout(() => {
    dom.toast.classList.add('hidden');
  }, duration);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}

async function compressImage(dataUrl, maxWidth = 1920, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// --- 4. 渲染邏輯 ---
function renderCategories() {
  const categoryUl = dom.categoryList;
  const fixedItems = Array.from(categoryUl.querySelectorAll('[data-category="all"], [data-category="pinned"]'));
  categoryUl.innerHTML = '';
  fixedItems.forEach(item => categoryUl.appendChild(item));

  state.categories.forEach(cat => {
    const li = document.createElement('li');
    li.className = `category-item ${state.currentCategory === cat ? 'active' : ''}`;
    li.setAttribute('data-category', cat);

    const count = state.notes.filter(n => n.category === cat).length;

    li.innerHTML = `
      <span class="material-symbols-rounded">folder</span>
      <span class="category-name" title="${escapeHtml(cat)}">${escapeHtml(cat)}</span>
      <span class="category-count">${count}</span>
      <span class="material-symbols-rounded category-action-btn category-edit-btn" title="編輯分類名稱">edit</span>
      <span class="material-symbols-rounded category-action-btn category-delete-btn" title="刪除此分類">delete</span>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('category-edit-btn')) {
        e.stopPropagation();
        editCategoryPrompt(cat);
        return;
      }
      if (e.target.classList.contains('category-delete-btn')) {
        e.stopPropagation();
        confirmDeleteCategory(cat);
        return;
      }
      setCategory(cat);
    });

    categoryUl.appendChild(li);
  });

  dom.editCategory.innerHTML = '';
  if (state.categories.length === 0) {
    const opt = document.createElement('option');
    opt.value = '未分類';
    opt.textContent = '未分類';
    dom.editCategory.appendChild(opt);
  } else {
    state.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      dom.editCategory.appendChild(opt);
    });
  }

  dom.countAll.textContent = state.notes.length;
  dom.countPinned.textContent = state.notes.filter(n => n.isPinned).length;
}

function setCategory(cat) {
  state.currentCategory = cat;
  document.querySelectorAll('.category-item').forEach(item => {
    if (item.getAttribute('data-category') === cat) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  if (cat === 'all') dom.currentViewTitle.textContent = '全部記事';
  else if (cat === 'pinned') dom.currentViewTitle.textContent = '已置頂記事';
  else dom.currentViewTitle.textContent = cat;

  renderNotesList();
}

function getFilteredNotes() {
  let list = [...state.notes];

  if (state.currentCategory === 'pinned') {
    list = list.filter(n => n.isPinned);
  } else if (state.currentCategory !== 'all') {
    list = list.filter(n => n.category === state.currentCategory);
  }

  const q = state.searchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(n => {
      const matchTitle = (n.title || '').toLowerCase().includes(q);
      const matchContent = (n.content || '').toLowerCase().includes(q);
      const matchTags = (n.tags || []).some(t => t.toLowerCase().includes(q));
      const matchCat = (n.category || '').toLowerCase().includes(q);
      const matchComments = (n.comments || []).some(c => (c.content || '').toLowerCase().includes(q));
      return matchTitle || matchContent || matchTags || matchCat || matchComments;
    });
  }

  list.sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }

    switch (state.sortBy) {
      case 'updated-desc':
        return b.updatedAt - a.updatedAt;
      case 'updated-asc':
        return a.updatedAt - b.updatedAt;
      case 'created-desc':
        return b.createdAt - a.createdAt;
      case 'created-asc':
        return a.createdAt - b.createdAt;
      case 'title-asc':
        return (a.title || '').localeCompare(b.title || '');
      default:
        return b.updatedAt - a.updatedAt;
    }
  });

  return list;
}

function renderNotesList() {
  const filtered = getFilteredNotes();
  dom.filteredCount.textContent = `${filtered.length} 則`;

  dom.notesGrid.innerHTML = '';
  if (filtered.length === 0) {
    dom.emptyState.classList.remove('hidden');
    return;
  }
  dom.emptyState.classList.add('hidden');

  filtered.forEach(note => {
    const card = document.createElement('div');
    card.className = `note-card ${state.selectedNoteId === note.id ? 'active' : ''}`;
    card.dataset.id = note.id;

    let thumbHtml = '';
    if (note.images && note.images.length > 0) {
      const maxThumb = 3;
      const displayThumbs = note.images.slice(0, maxThumb);
      const remaining = note.images.length - maxThumb;

      let thumbsImgs = displayThumbs.map(imgSrc => `<img class="card-thumb-item" src="${imgSrc}" loading="lazy" alt="縮圖">`).join('');
      if (remaining > 0) {
        thumbsImgs += `<div class="card-thumb-item card-thumb-more">+${remaining}</div>`;
      }
      thumbHtml = `<div class="card-thumb-grid">${thumbsImgs}</div>`;
    }

    let tagsHtml = '';
    if (note.tags && note.tags.length > 0) {
      tagsHtml = `<div class="card-tags">${note.tags.slice(0, 3).map(t => `<span class="tag-badge">#${escapeHtml(t)}</span>`).join('')}</div>`;
    }

    const titleText = note.title ? escapeHtml(note.title) : '無標題記事';
    const excerptText = note.content ? escapeHtml(note.content) : (note.images && note.images.length > 0 ? '[包含圖片記錄]' : '無內文');

    card.innerHTML = `
      <div class="card-top-row">
        <span class="card-category-badge">${escapeHtml(note.category || '未分類')}</span>
        ${note.isPinned ? '<span class="material-symbols-rounded card-pin-badge" title="已置頂">push_pin</span>' : ''}
      </div>
      <h4 class="card-title">${titleText}</h4>
      <p class="card-excerpt">${excerptText}</p>
      ${thumbHtml}
      <div class="card-footer-info">
        <span>${formatDate(note.updatedAt)}</span>
        ${tagsHtml}
      </div>
    `;

    card.addEventListener('click', () => {
      selectNote(note.id);
    });

    dom.notesGrid.appendChild(card);
  });
}


// --- 追加補充 (Comments / Timeline) 暫存狀態 ---
let currentCommentImages = [];

function renderCommentsTimeline(comments = []) {
  if (!comments || comments.length === 0) {
    return '<p style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 18px;">目前尚無追加補充記錄。可以在下方快速追加備忘、進展或新截圖！</p>';
  }

  return comments.map((c, cIdx) => {
    let cImgHtml = '';
    if (c.images && c.images.length > 0) {
      cImgHtml = '<div class="comment-images-grid">' + 
        c.images.map((imgSrc, imgIdx) => `
          <div class="comment-img-item" data-comment-idx="${cIdx}" data-img-idx="${imgIdx}">
            <img src="${imgSrc}" loading="lazy" alt="補充圖片">
          </div>
        `).join('') + '</div>';
    }

    return `
      <div class="comment-card">
        <div class="comment-card-header">
          <span class="comment-time">
            <span class="material-symbols-rounded" style="font-size: 15px;">schedule</span>
            <span>補充於 ${formatDate(c.createdAt)}</span>
          </span>
          <div style="display: flex; gap: 4px;">
            <button type="button" class="comment-edit-btn" data-comment-id="${c.id}" title="編輯此則補充">
              <span class="material-symbols-rounded" style="font-size: 15px;">edit</span>
              <span>編輯</span>
            </button>
            <button type="button" class="comment-delete-btn" data-comment-id="${c.id}" title="刪除此則補充">
              <span class="material-symbols-rounded" style="font-size: 15px;">delete</span>
              <span>刪除</span>
            </button>
          </div>
        </div>
        <div class="comment-content">${escapeHtml(c.content || '')}</div>
        ${cImgHtml}
      </div>
    `;
  }).join('');
}

function renderCommentsSection(note) {
  const comments = note.comments || [];
  const timelineHtml = renderCommentsTimeline(comments);

  return `
    <div class="note-comments-section">
      <div class="comments-header">
        <div class="comments-title">
          <span class="material-symbols-rounded" style="color: var(--primary);">forum</span>
          <span>追加補充記錄</span>
          <span class="comments-count-badge" id="comments-count-badge">${comments.length} 則</span>
        </div>
      </div>

      <div class="comments-timeline" id="comments-timeline-container">
        ${timelineHtml}
      </div>

      <!-- 快速追加留言與貼圖輸入框 -->
      <div class="add-comment-box" id="comment-box">
        <textarea id="comment-input" class="comment-textarea" placeholder="在此輸入補充備忘 (支援直接 Ctrl+V 貼上截圖)..."></textarea>
        
        <div id="comment-preview-bar" class="comment-preview-bar"></div>

        <div class="comment-box-footer">
          <div class="comment-actions-left">
            <button type="button" id="btn-comment-add-img" class="btn btn-secondary btn-sm" title="選擇補充圖片">
              <span class="material-symbols-rounded" style="font-size: 18px;">add_photo_alternate</span>
              <span>加圖</span>
            </button>
            <input type="file" id="comment-file-input" multiple accept="image/*" style="display: none;">
            <span style="font-size: 0.78rem; color: var(--text-muted);">可直接 Ctrl+V 貼上截圖</span>
          </div>
          <button type="button" id="btn-submit-comment" class="btn btn-primary btn-sm">
            <span class="material-symbols-rounded" style="font-size: 18px;">send</span>
            <span>送出補充</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function bindCommentsEvents(note) {
  currentCommentImages = [];
  const commentInput = document.getElementById('comment-input');
  const commentFileInput = document.getElementById('comment-file-input');
  const btnAddImg = document.getElementById('btn-comment-add-img');
  const previewBar = document.getElementById('comment-preview-bar');
  const btnSubmit = document.getElementById('btn-submit-comment');

  function updateCommentPreview() {
    previewBar.innerHTML = '';
    currentCommentImages.forEach((src, idx) => {
      const div = document.createElement('div');
      div.className = 'comment-thumb-preview';
      div.innerHTML = `
        <img src="${src}" alt="預覽">
        <button type="button" class="comment-thumb-remove" title="移除">×</button>
      `;
      div.querySelector('.comment-thumb-remove').addEventListener('click', () => {
        currentCommentImages.splice(idx, 1);
        updateCommentPreview();
      });
      previewBar.appendChild(div);
    });
  }

  // 加圖選檔
  btnAddImg.addEventListener('click', () => commentFileInput.click());
  commentFileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      for (let f of e.target.files) {
        if (f.type.startsWith('image/')) {
          const raw = await readFileAsDataURL(f);
          const comp = await compressImage(raw);
          currentCommentImages.push(comp);
        }
      }
      updateCommentPreview();
      e.target.value = '';
    }
  });

  // 在輸入框內直接貼上截圖 (Ctrl+V)
  commentInput.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) {
          const raw = await readFileAsDataURL(file);
          const comp = await compressImage(raw);
          currentCommentImages.push(comp);
          updateCommentPreview();
        }
      }
    }
  });

  // 提交追加補充
  btnSubmit.addEventListener('click', async () => {
    const text = commentInput.value.trim();
    if (!text && currentCommentImages.length === 0) {
      alert('請輸入補充內容或貼上圖片！');
      return;
    }

    const newComment = {
      id: 'comment_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      content: text,
      images: [...currentCommentImages],
      createdAt: Date.now()
    };

    if (!note.comments) note.comments = [];
    note.comments.push(newComment);
    note.updatedAt = Date.now();

    await state.db.saveNote(note);
    currentCommentImages = [];
    commentInput.value = '';
    previewBar.innerHTML = '';
    await syncNoteToServer(note);
    triggerCloudSync();
    renderNotesList();
    selectNote(note.id);
    showToast('已成功追加補充記錄！');
  });

  // 綁定個別補充記錄之編輯、刪除與圖片點擊
  function bindTimelineItemsEvents(activeNote) {
    document.querySelectorAll('.comment-edit-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const cid = btn.dataset.commentId;
        const targetComment = (activeNote.comments || []).find(c => c.id === cid);
        if (!targetComment) return;
        openEditCommentModal(activeNote, targetComment);
      };
    });

    document.querySelectorAll('.comment-delete-btn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const cid = btn.dataset.commentId;
        if (confirm('確定要刪除這筆補充記錄嗎？')) {
          activeNote.comments = (activeNote.comments || []).filter(c => c.id !== cid);
          activeNote.updatedAt = Date.now();
          await state.db.saveNote(activeNote);
          await syncNoteToServer(activeNote);
          triggerCloudSync();
          renderNotesList();
          selectNote(activeNote.id);
          showToast('已刪除該筆補充');
        }
      };
    });

    document.querySelectorAll('.comment-img-item').forEach(item => {
      item.onclick = () => {
        const cIdx = parseInt(item.dataset.commentIdx, 10);
        const iIdx = parseInt(item.dataset.imgIdx, 10);
        const cImages = activeNote.comments[cIdx].images;
        openLightbox(cImages, iIdx);
      };
    });
  }

  bindTimelineItemsEvents(note);
}

// 局部更新時間軸 (保持手機與電腦輸入框不被重繪中斷)
function updateCommentsTimelineOnly(note) {
  const container = document.getElementById('comments-timeline-container');
  const countBadge = document.getElementById('comments-count-badge');
  if (container) {
    container.innerHTML = renderCommentsTimeline(note.comments || []);
    if (countBadge) {
      countBadge.textContent = `${(note.comments || []).length} 則`;
    }
    // 重新綁定時間軸按鈕事件
    document.querySelectorAll('.comment-edit-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const cid = btn.dataset.commentId;
        const targetComment = (note.comments || []).find(c => c.id === cid);
        if (!targetComment) return;
        openEditCommentModal(note, targetComment);
      };
    });

    document.querySelectorAll('.comment-delete-btn').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const cid = btn.dataset.commentId;
        if (confirm('確定要刪除這筆補充記錄嗎？')) {
          note.comments = (note.comments || []).filter(c => c.id !== cid);
          note.updatedAt = Date.now();
          await state.db.saveNote(note);
          await syncNoteToServer(note);
          triggerCloudSync();
          renderNotesList();
          selectNote(note.id);
          showToast('已刪除該筆補充');
        }
      };
    });

    document.querySelectorAll('.comment-img-item').forEach(item => {
      item.onclick = () => {
        const cIdx = parseInt(item.dataset.commentIdx, 10);
        const iIdx = parseInt(item.dataset.imgIdx, 10);
        const cImages = note.comments[cIdx].images;
        openLightbox(cImages, iIdx);
      };
    });
  }
}

// 多行追加記錄編輯視窗管理
function openEditCommentModal(note, comment) {
  state.editingNoteId = note.id;
  state.editingCommentId = comment.id;
  dom.editCommentTextarea.value = comment.content || '';
  dom.editCommentModal.classList.remove('hidden');
  setTimeout(() => dom.editCommentTextarea.focus(), 50);
}

function closeEditCommentModal() {
  dom.editCommentModal.classList.add('hidden');
  state.editingCommentId = null;
}

async function saveEditedComment() {
  if (!state.editingNoteId || !state.editingCommentId) return;
  const note = state.notes.find(n => n.id === state.editingNoteId);
  if (!note || !note.comments) return;

  const comment = note.comments.find(c => c.id === state.editingCommentId);
  if (!comment) return;

  const newText = dom.editCommentTextarea.value.trim();
  comment.content = newText;
  comment.updatedAt = Date.now();
  note.updatedAt = Date.now();

  await state.db.saveNote(note);
  await syncNoteToServer(note);
  triggerCloudSync();

  closeEditCommentModal();
  renderNotesList();
  selectNote(note.id);
  showToast('追加記錄已成功更新！');
}

function closeMobileDetailView() {
  if (dom.noteViewPane) {
    dom.noteViewPane.classList.remove('mobile-active');
  }
  if (dom.notesListSection) {
    dom.notesListSection.classList.remove('mobile-hidden');
  }
}

function selectNote(noteId) {

  state.selectedNoteId = noteId;
  const note = state.notes.find(n => n.id === noteId);

  document.querySelectorAll('.note-card').forEach(c => {
    c.classList.toggle('active', c.dataset.id === noteId);
  });

  if (!note) {
    dom.noteViewPane.className = 'note-view-pane empty';
    dom.noteViewPane.innerHTML = `
      <div class="select-note-prompt">
        <span class="material-symbols-rounded">description</span>
        <h3>選擇一則記事檢視或點擊「新增記事」</h3>
        <p>支援直接貼上截圖 (Ctrl+V)、多圖上傳與分類管理</p>
      </div>
    `;
    return;
  }

  dom.noteViewPane.className = 'note-view-pane mobile-active';
  if (window.innerWidth <= 768 && dom.notesListSection) {
    dom.notesListSection.classList.add('mobile-hidden');
  }
  
  let galleryHtml = '';
  if (note.images && note.images.length > 0) {
    const imgItems = note.images.map((src, index) => `
      <div class="gallery-item" data-index="${index}">
        <img src="${src}" alt="記事圖片 ${index + 1}">
        <div class="gallery-item-overlay">
          <span class="material-symbols-rounded">zoom_in</span>
        </div>
      </div>
    `).join('');

    galleryHtml = `
      <div class="detail-gallery">
        <div class="gallery-title" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="material-symbols-rounded">photo_library</span>
            <span>附加照片 (${note.images.length} 張) - 點擊放大</span>
          </div>
          <button type="button" id="btn-download-all-images" class="btn btn-secondary btn-sm" title="一鍵打包下載此記事所有照片 (ZIP)">
            <span class="material-symbols-rounded" style="font-size: 16px;">download</span>
            <span>一鍵下載所有照片 (ZIP)</span>
          </button>
        </div>
        <div class="gallery-grid">
          ${imgItems}
        </div>
      </div>
    `;
  }

  const tagsHtml = (note.tags || []).map(t => `<span class="tag-badge">#${escapeHtml(t)}</span>`).join('');

  dom.noteViewPane.innerHTML = `
    <div class="note-detail-wrapper">
      <div class="note-detail-card">
        <!-- 手機版頂部導航列 (返回清單按鈕) -->
        <div class="mobile-nav-header">
          <button class="mobile-back-btn" id="btn-mobile-back" title="返回記事清單">
            <span class="material-symbols-rounded">arrow_back</span>
            <span>返回清單</span>
          </button>
        </div>

        <div class="detail-header">
          <div class="detail-meta-row">
            <div class="detail-tags-category">
              <span class="card-category-badge">${escapeHtml(note.category)}</span>
              ${tagsHtml}
            </div>
            <div class="detail-actions">
              <button class="btn btn-secondary btn-sm" id="btn-export-image" title="匯出教學長圖 (圖文合一分享)">
                <span class="material-symbols-rounded" style="color: var(--primary)">photo</span>
                <span>匯出長圖</span>
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-toggle-pin" title="${note.isPinned ? '取消置頂' : '置頂'}">
                <span class="material-symbols-rounded" style="color: ${note.isPinned ? 'var(--warning)' : 'inherit'}">push_pin</span>
                <span>${note.isPinned ? '已置頂' : '置頂'}</span>
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-edit-current">
                <span class="material-symbols-rounded">edit</span>
                <span>編輯</span>
              </button>
              <button class="btn btn-secondary btn-sm" id="btn-delete-current" style="color: var(--danger)">
                <span class="material-symbols-rounded">delete</span>
                <span>刪除</span>
              </button>
            </div>
          </div>
          <h1 class="detail-title">${escapeHtml(note.title || '無標題記事')}</h1>
          <div class="detail-timestamps">
            <span>建立時間: ${formatDate(note.createdAt)}</span>
            <span>最後更新: ${formatDate(note.updatedAt)}</span>
          </div>
        </div>

        <div class="detail-content">${escapeHtml(note.content || '')}</div>

        ${galleryHtml}

        ${renderCommentsSection(note)}
      </div>
    </div>
  `;

  const btnMobileBack = document.getElementById('btn-mobile-back');
  if (btnMobileBack) {
    btnMobileBack.addEventListener('click', () => {
      closeMobileDetailView();
    });
  }


  const btnExportImage = document.getElementById('btn-export-image');
  if (btnExportImage) {
    btnExportImage.addEventListener('click', () => generateLongImage(note));
  }

  document.getElementById('btn-edit-current').addEventListener('click', () => openEditor(note));
  document.getElementById('btn-delete-current').addEventListener('click', () => confirmDeleteNote(note.id));
  document.getElementById('btn-toggle-pin').addEventListener('click', () => togglePinNote(note.id));

  const btnDownloadAll = document.getElementById('btn-download-all-images');
  if (btnDownloadAll) {
    btnDownloadAll.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadAllImagesAsZip(note);
    });
  }

  const galleryItems = dom.noteViewPane.querySelectorAll('.gallery-item');
  galleryItems.forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index, 10);
      openLightbox(note.images, idx);
    });
  });

  bindCommentsEvents(note);
}

// --- 5. 編輯 Modal 視窗邏輯 ---
function openEditor(note = null) {
  state.editingNoteId = note ? note.id : null;
  state.currentEditImages = note && note.images ? [...note.images] : [];

  if (note) {
    dom.modalTitle.textContent = '編輯記事';
    dom.editTitle.value = note.title || '';
    dom.editCategory.value = note.category || state.categories[0];
    dom.editTags.value = (note.tags || []).join(', ');
    dom.editContent.value = note.content || '';
    dom.editPinned.checked = !!note.isPinned;
    dom.editTimeTip.textContent = `最後更新: ${formatDate(note.updatedAt)}`;
  } else {
    dom.modalTitle.textContent = '新增記事';
    dom.editTitle.value = '';
    if (state.currentCategory !== 'all' && state.currentCategory !== 'pinned') {
      dom.editCategory.value = state.currentCategory;
    } else {
      dom.editCategory.value = state.categories[0] || '生活記事';
    }
    dom.editTags.value = '';
    dom.editContent.value = '';
    dom.editPinned.checked = false;
    dom.editTimeTip.textContent = '';
  }

  renderEditImagesPreview();
  dom.editorModal.classList.remove('hidden');
  dom.editContent.focus();
}

function closeEditor() {
  dom.editorModal.classList.add('hidden');
  state.editingNoteId = null;
  state.currentEditImages = [];
}

function renderEditImagesPreview() {
  dom.imagesPreviewGrid.innerHTML = '';
  dom.imagesCount.textContent = state.currentEditImages.length;

  if (state.currentEditImages.length === 0) {
    dom.dropPrompt.style.display = 'flex';
  } else {
    dom.dropPrompt.style.display = 'none';
  }

  state.currentEditImages.forEach((imgSrc, index) => {
    const div = document.createElement('div');
    div.className = 'preview-item';
    div.innerHTML = `
      <img src="${imgSrc}" alt="預覽 ${index + 1}">
      <button type="button" class="btn-remove-img" title="移除圖片" data-index="${index}">
        <span class="material-symbols-rounded">close</span>
      </button>
    `;
    div.querySelector('.btn-remove-img').addEventListener('click', (e) => {
      e.stopPropagation();
      state.currentEditImages.splice(index, 1);
      renderEditImagesPreview();
    });
    dom.imagesPreviewGrid.appendChild(div);
  });
}

async function handleImageFiles(files) {
  if (!files || files.length === 0) return;
  const fileArray = Array.from(files).filter(f => f.type && f.type.startsWith('image/'));
  if (fileArray.length === 0) return;
  
  showToast(`正在載入 1/${fileArray.length} 張圖片...`);
  let loadedCount = 0;
  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];
    try {
      const rawDataUrl = await readFileAsDataURL(file);
      const compressed = await compressImage(rawDataUrl);
      state.currentEditImages.push(compressed);
      loadedCount++;
      renderEditImagesPreview();
      if (fileArray.length > 1) {
        showToast(`正在載入 (${loadedCount}/${fileArray.length}) 張圖片...`);
      }
    } catch (err) {
      console.error('讀取圖片錯誤:', err);
    }
  }
  renderEditImagesPreview();
  showToast(`成功加入 ${loadedCount} 張圖片！`, 'success');
}

async function saveCurrentNote() {
  let title = dom.editTitle.value.trim();
  const content = dom.editContent.value.trim();
  const category = dom.editCategory.value;
  const isPinned = dom.editPinned.checked;
  const tags = dom.editTags.value
    .split(/[,，\s]+/)
    .map(t => t.trim())
    .filter(t => t.length > 0);

  if (!title) {
    if (content) {
      title = content.split('\n')[0].substring(0, 35);
    } else if (state.currentEditImages.length > 0) {
      title = '未命名照片記事';
    } else {
      title = '空白記事';
    }
  }

  const now = Date.now();
  let noteObj;

  if (state.editingNoteId) {
    const existing = state.notes.find(n => n.id === state.editingNoteId);
    noteObj = {
      ...existing,
      title,
      content,
      category,
      tags,
      isPinned,
      images: state.currentEditImages,
      updatedAt: now
    };
  } else {
    noteObj = {
      id: generateId(),
      title,
      content,
      category,
      tags,
      isPinned,
      images: state.currentEditImages,
      createdAt: now,
      updatedAt: now
    };
  }

  try {
    await state.db.saveNote(noteObj);
    await syncNoteToServer(noteObj);
    await state.db.saveNote(noteObj); // 儲存更新後的圖片路徑

    const existingIndex = state.notes.findIndex(n => n.id === noteObj.id);
    if (existingIndex >= 0) {
      state.notes[existingIndex] = noteObj;
    } else {
      state.notes.unshift(noteObj);
    }

    triggerCloudSync();
    closeEditor();
    renderCategories();
    renderNotesList();
    selectNote(noteObj.id);
    showToast('記事已儲存！');
  } catch (err) {
    console.error('儲存失敗:', err);
    alert('儲存失敗，請重試: ' + err.message);
  }
}

async function confirmDeleteNote(noteId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;

  const noteName = note.title || '這則記事';
  if (confirm(`確定要刪除「${noteName}」嗎？刪除後無法復原。`)) {
    try {
      await state.db.deleteNote(noteId);
      if (window.gDriveSync) {
        window.gDriveSync.recordDeletion(noteId);
      }
      if (isServerOnline) {
        await syncDeleteToServer(noteId);
      }
      state.notes = state.notes.filter(n => n.id !== noteId);
      if (state.selectedNoteId === noteId) {
        state.selectedNoteId = null;
      }
      triggerCloudSync();
      renderCategories();
      renderNotesList();
      selectNote(null);
      closeMobileDetailView();
      showToast('已刪除記事');

    } catch (err) {
      alert('刪除失敗: ' + err.message);
    }
  }
}

async function togglePinNote(noteId) {
  const note = state.notes.find(n => n.id === noteId);
  if (!note) return;

  note.isPinned = !note.isPinned;
  note.updatedAt = Date.now();
  await state.db.saveNote(note);
  triggerCloudSync();
  renderCategories();
  renderNotesList();
  selectNote(note.id);
  showToast(note.isPinned ? '已將記事置頂' : '已取消置頂');
}

async function addNewCategoryPrompt() {
  const name = prompt('請輸入新分類名稱 (例如: 料理筆記、旅行安排、收據發票):');
  if (!name || !name.trim()) return;
  const cleanName = name.trim();
  if (state.categories.includes(cleanName)) {
    alert('該分類已存在！');
    return;
  }
  state.categories.push(cleanName);
  await state.db.saveCategories(state.categories);
  localStorage.setItem('cats_updated_at', Date.now().toString());
  if (isServerOnline) {
    await syncCategoriesToServer(state.categories);
  }
  triggerCloudSync();
  renderCategories();
  setCategory(cleanName);
  showToast(`已建立新分類「${cleanName}」`);
}

async function editCategoryPrompt(oldName) {
  const newName = prompt(`請輸入「${oldName}」的新名稱:`, oldName);
  if (!newName || !newName.trim()) return;
  const cleanNew = newName.trim();
  if (cleanNew === oldName) return;

  if (state.categories.includes(cleanNew)) {
    alert('該分類名稱已存在！');
    return;
  }

  // 1. 更新分類清單中的名稱
  const catIdx = state.categories.indexOf(oldName);
  if (catIdx !== -1) {
    state.categories[catIdx] = cleanNew;
  }
  await state.db.saveCategories(state.categories);
  localStorage.setItem('cats_updated_at', Date.now().toString());

  // 2. 將所有屬於原分類的記事自動轉換至新分類
  for (let note of state.notes) {
    if (note.category === oldName) {
      note.category = cleanNew;
      note.updatedAt = Date.now();
      await state.db.saveNote(note);
      if (isServerOnline) {
        await syncNoteToServer(note);
      }
    }
  }

  if (isServerOnline) {
    await syncCategoriesToServer(state.categories);
  }

  // 3. 同步當前選中的分類狀態
  if (state.currentCategory === oldName) {
    state.currentCategory = cleanNew;
  }

  triggerCloudSync();
  renderCategories();
  renderNotesList();
  if (state.selectedNoteId) selectNote(state.selectedNoteId);
  showToast(`分類已更名為「${cleanNew}」`);
}

async function confirmDeleteCategory(cat) {
  if (confirm(`確定要刪除「${cat}」分類標籤嗎？（屬於此分類的記事不會被刪除，會改歸類至預設分類）`)) {
    state.categories = state.categories.filter(c => c !== cat);
    await state.db.saveCategories(state.categories);
    localStorage.setItem('cats_updated_at', Date.now().toString());
    if (isServerOnline) {
      await syncCategoriesToServer(state.categories);
    }
    triggerCloudSync();

    const defaultCat = state.categories[0];
    for (let note of state.notes) {
      if (note.category === cat) {
        note.category = defaultCat;
        await state.db.saveNote(note);
      }
    }

    if (state.currentCategory === cat) {
      state.currentCategory = 'all';
    }
    renderCategories();
    renderNotesList();
    if (state.selectedNoteId) selectNote(state.selectedNoteId);
    showToast(`已移除分類「${cat}」`);
  }
}

// --- 6. 燈箱檢視 (Lightbox) ---
function openLightbox(images, startIndex = 0) {
  if (!images || images.length === 0) return;
  state.lightboxImages = images;
  state.currentLightboxIndex = startIndex;
  updateLightboxView();
  dom.lightboxModal.classList.remove('hidden');
}

function updateLightboxView() {
  const total = state.lightboxImages.length;
  const current = state.currentLightboxIndex;
  dom.lightboxImg.src = state.lightboxImages[current];
  dom.lightboxCounter.textContent = `${current + 1} / ${total}`;
  dom.lightboxPrev.style.display = total > 1 ? 'flex' : 'none';
  dom.lightboxNext.style.display = total > 1 ? 'flex' : 'none';
}

function closeLightbox() {
  dom.lightboxModal.classList.add('hidden');
}

function prevLightbox() {
  if (state.lightboxImages.length <= 1) return;
  state.currentLightboxIndex = (state.currentLightboxIndex - 1 + state.lightboxImages.length) % state.lightboxImages.length;
  updateLightboxView();
}

function nextLightbox() {
  if (state.lightboxImages.length <= 1) return;
  state.currentLightboxIndex = (state.currentLightboxIndex + 1) % state.lightboxImages.length;
  updateLightboxView();
}

function downloadCurrentLightboxImage() {
  const current = state.currentLightboxIndex;
  const imgSrc = state.lightboxImages[current];
  if (!imgSrc) return;

  const a = document.createElement('a');
  a.href = imgSrc;
  const ext = imgSrc.includes('image/png') ? 'png' : (imgSrc.includes('image/webp') ? 'webp' : 'jpg');
  a.download = `記事圖片_${Date.now()}_${current + 1}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('照片已開始下載！');
}

// 一鍵打包下載該記事的所有照片 (ZIP 壓縮包)
async function downloadAllImagesAsZip(note) {
  if (!note) return;
  const images = [];

  // 主照片
  if (note.images && note.images.length > 0) {
    note.images.forEach((img, i) => images.push({ src: img, name: `主照片_${i + 1}` }));
  }

  // 追加補充記錄中的照片
  if (note.comments && note.comments.length > 0) {
    note.comments.forEach((c, cIdx) => {
      if (c.images && c.images.length > 0) {
        c.images.forEach((cImg, ci) => {
          images.push({ src: cImg, name: `補充${cIdx + 1}_照片_${ci + 1}` });
        });
      }
    });
  }

  if (images.length === 0) {
    alert('這則記事中沒有任何照片可供下載！');
    return;
  }

  showToast(`正在打包 ${images.length} 張照片，請稍候...`);

  try {
    if (!window.JSZip) {
      // 若 JSZip 尚未載入，依序觸發單張下載
      for (let item of images) {
        const a = document.createElement('a');
        a.href = item.src;
        const ext = item.src.includes('image/png') ? 'png' : (item.src.includes('image/webp') ? 'webp' : 'jpg');
        a.download = `${sanitizeFilename(note.title || '記事')}_${item.name}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        await new Promise(r => setTimeout(r, 200));
      }
      showToast('所有照片已逐張下載完成！');
      return;
    }

    const zip = new JSZip();
    const folder = zip.folder(sanitizeFilename(note.title || '記事照片'));

    for (let i = 0; i < images.length; i++) {
      const item = images[i];
      let base64Data = '';
      let ext = 'jpg';

      if (item.src.startsWith('data:image/')) {
        const parts = item.src.split(',');
        base64Data = parts[1];
        if (parts[0].includes('image/png')) ext = 'png';
        else if (parts[0].includes('image/webp')) ext = 'webp';
      } else {
        // 若為相對路徑，抓取轉 base64
        try {
          const res = await fetch(item.src);
          const blob = await res.blob();
          base64Data = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
          if (item.src.endsWith('.png')) ext = 'png';
        } catch (e) {
          console.warn('讀取圖片失敗:', item.src);
        }
      }

      if (base64Data) {
        folder.file(`${item.name}.${ext}`, base64Data, { base64: true });
      }
    }

    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(note.title || '記事照片')}_共${images.length}張照片.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`成功打包下載 ${images.length} 張照片！`, 'success');

  } catch (err) {
    console.error('打包下載失敗:', err);
    alert('打包下載照片失敗: ' + err.message);
  }
}

function sanitizeFilename(name) {
  return (name || '記事').replace(/[\\/:*?"<>|]/g, '_').trim();
}

// 產生圖文教學長圖 (高畫質合成)
async function generateLongImage(note) {
  if (!note) return;
  if (!window.html2canvas) {
    alert('正在載入圖形繪製模組，請稍後重試！');
    return;
  }

  const modal = document.getElementById('export-image-modal');
  const loading = document.getElementById('export-image-loading');
  const previewContainer = document.getElementById('export-image-preview-container');
  const previewImg = document.getElementById('export-image-preview');

  modal.classList.remove('hidden');
  loading.style.display = 'block';
  previewContainer.classList.add('hidden');

  // 建立渲染容器 (使用 position: fixed 且移出螢幕可視區，避免在手機版撐大 document 寬度導致畫面縮小變形)
  const renderDiv = document.createElement('div');
  renderDiv.style.position = 'fixed';
  renderDiv.style.left = '-9999px';
  renderDiv.style.top = '0px';
  renderDiv.style.width = '750px';
  renderDiv.style.maxWidth = '750px';
  renderDiv.style.minWidth = '750px';
  renderDiv.style.zIndex = '-99999';
  renderDiv.style.pointerEvents = 'none';
  renderDiv.style.overflow = 'hidden';
  renderDiv.style.backgroundColor = '#ffffff';
  renderDiv.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Noto Sans TC', sans-serif";
  renderDiv.style.color = '#1e293b';
  renderDiv.style.padding = '36px';
  renderDiv.style.boxSizing = 'border-box';

  const loadingTitle = document.getElementById('export-loading-title');
  const loadingDetail = document.getElementById('export-loading-detail');
  const progressBar = document.getElementById('export-progress-bar');
  const progressPercent = document.getElementById('export-progress-percent');

  function updateExportProgress(percent, title, detail) {
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressPercent) progressPercent.textContent = `${percent}%`;
    if (title && loadingTitle) loadingTitle.textContent = title;
    if (detail && loadingDetail) loadingDetail.textContent = detail;
  }

  updateExportProgress(15, '正在排版教學卡片...', '解析文字與標籤排版 (15%)');
  await new Promise(r => setTimeout(r, 60));

  // 1. 標頭
  const categoryText = note.category || '生活記事';
  const tagsText = (note.tags || []).map(t => `#${t}`).join('  ');
  const timeText = `建立時間: ${formatDate(note.createdAt)}   最後更新: ${formatDate(note.updatedAt)}`;

  // 2. 附加照片
  let imagesHtml = '';
  if (note.images && note.images.length > 0) {
    updateExportProgress(35, '正在載入附加照片...', `處理附圖 1~${note.images.length} 張 (35%)`);
    await new Promise(r => setTimeout(r, 60));

    const imgCards = note.images.map((src, i) => {
      const isDataOrBlob = typeof src === 'string' && (src.startsWith('data:') || src.startsWith('blob:'));
      const crossAttr = isDataOrBlob ? '' : 'crossorigin="anonymous"';
      return `
        <div style="background:#f8fafc; border-radius:10px; overflow:hidden; border:1px solid #e2e8f0; display:flex; flex-direction:column; align-items:center; margin-bottom: 20px;">
          <img src="${src}" ${crossAttr} style="width:100%; height:auto; display:block;" />
          <div style="font-size:13px; color:#64748b; padding:8px 0; font-weight:600;">附圖 ${i + 1}</div>
        </div>
      `;
    }).join('');

    imagesHtml = `
      <div style="margin-top:28px; padding-top:24px; border-top:1px dashed #cbd5e1;">
        <div style="font-size:16px; font-weight:700; color:#334155; margin-bottom:14px; display:flex; align-items:center; gap:8px;">
          <span>📷 附加照片紀錄 (${note.images.length} 張)</span>
        </div>
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${imgCards}
        </div>
      </div>
    `;
  }

  // 3. 追加補充記錄
  let commentsHtml = '';
  if (note.comments && note.comments.length > 0) {
    updateExportProgress(50, '正在整理補充紀錄...', `整理 ${note.comments.length} 則時間軸補充 (50%)`);
    await new Promise(r => setTimeout(r, 60));

    const cItems = note.comments.map((c, idx) => {
      let cImgHtml = '';
      if (c.images && c.images.length > 0) {
        cImgHtml = `
          <div style="display:flex; flex-direction:column; gap:12px; margin-top:12px;">
            ${c.images.map((img, cImgIdx) => {
              const isDataOrBlob = typeof img === 'string' && (img.startsWith('data:') || img.startsWith('blob:'));
              const crossAttr = isDataOrBlob ? '' : 'crossorigin="anonymous"';
              return `
                <div style="background:#ffffff; border-radius:8px; overflow:hidden; border:1px solid #e2e8f0;">
                  <img src="${img}" ${crossAttr} style="width:100%; height:auto; display:block;" />
                  <div style="font-size:12px; color:#64748b; padding:6px 0; text-align:center; font-weight:600;">補充附圖 ${cImgIdx + 1}</div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
      return `
        <div style="background:#f8fafc; border-left:4px solid #6366f1; border-radius:4px 8px 8px 4px; padding:16px 20px; margin-bottom:16px;">
          <div style="font-size:12px; color:#64748b; font-weight:600; margin-bottom:8px;">⏱️ 補充紀錄 #${idx + 1} (${formatDate(c.createdAt)})</div>
          <div style="font-size:15px; color:#1e293b; white-space:pre-wrap; line-height:1.7;">${escapeHtml(c.content || '')}</div>
          ${cImgHtml}
        </div>
      `;
    }).join('');

    commentsHtml = `
      <div style="margin-top:28px; padding-top:24px; border-top:1px dashed #cbd5e1;">
        <div style="font-size:16px; font-weight:700; color:#334155; margin-bottom:14px;">
          💬 追加補充備忘 (${note.comments.length} 則)
        </div>
        ${cItems}
      </div>
    `;
  }

  renderDiv.innerHTML = `
    <div style="border-bottom: 2px solid #e2e8f0; padding-bottom: 18px;">
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
        <span style="background: #e0e7ff; color: #4338ca; font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 6px;">${escapeHtml(categoryText)}</span>
        <span style="font-size: 13px; color: #6366f1; font-weight: 600;">${escapeHtml(tagsText)}</span>
      </div>
      <h1 style="font-size: 26px; font-weight: 800; color: #0f172a; margin: 8px 0; line-height: 1.35;">${escapeHtml(note.title || '未命名記事')}</h1>
      <div style="font-size: 13px; color: #94a3b8; font-weight: 500;">${timeText}</div>
    </div>

    <div style="margin-top: 24px; font-size: 15px; line-height: 1.8; color: #334155; white-space: pre-wrap; word-break: break-word;">
      ${escapeHtml(note.content || '（本記事無詳細內文）')}
    </div>

    ${imagesHtml}
    ${commentsHtml}

    <div style="margin-top: 36px; padding-top: 18px; border-top: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; color: #94a3b8; font-size: 12px;">
      <span>📖 個人圖文記事本 • SOP 教學匯出</span>
      <span>${new Date().toLocaleDateString()}</span>
    </div>
  `;

  document.body.appendChild(renderDiv);

  try {
    // 等待 renderDiv 內的所有圖片真正解碼完成，避免 html2canvas 渲染時阻塞或失敗卡住
    const imgs = Array.from(renderDiv.querySelectorAll('img'));
    if (imgs.length > 0) {
      updateExportProgress(60, '正在等待圖片解碼...', `預載 ${imgs.length} 張圖片 (60%)`);
      await Promise.all(imgs.map(img => {
        if (img.complete) {
          return (img.decode ? img.decode().catch(() => {}) : Promise.resolve());
        }
        return new Promise(resolve => {
          img.onload = () => { if (img.decode) img.decode().catch(() => {}).then(resolve); else resolve(); };
          img.onerror = resolve;
          setTimeout(resolve, 3000); // 3秒超時防呆
        });
      }));
    }

    // 檢查是否為行動裝置 (iPhone / Android)
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;
    // 手機端避免 Canvas 超過 Safari 記憶體限制 (超過易全黑或卡住)，設定合適比例
    const targetScale = isMobile ? 1.0 : 2.0;

    updateExportProgress(75, '正在高畫質渲染圖像...', '產生點陣圖檔 (75%)');
    await new Promise(r => setTimeout(r, 60));

    const canvasOptions = {
      scale: targetScale,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      scrollX: 0,
      scrollY: 0,
      windowWidth: 750,
      logging: false
    };

    // 帶超時保護的 html2canvas 執行
    const runCanvasWithTimeout = (options, timeoutMs = 15000) => {
      return Promise.race([
        html2canvas(renderDiv, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('長圖渲染逾時，自動降級處理')), timeoutMs))
      ]);
    };

    let canvas;
    try {
      canvas = await runCanvasWithTimeout(canvasOptions, 15000);
    } catch (renderErr) {
      console.warn('初次渲染遇到限制或逾時，自動以 scale=1 重試:', renderErr);
      updateExportProgress(80, '正在自適應調整渲染...', '調整繪圖比例 (80%)');
      canvasOptions.scale = 1.0;
      canvasOptions.useCORS = false;
      canvas = await runCanvasWithTimeout(canvasOptions, 15000);
    }

    updateExportProgress(95, '正在生成圖像檔案...', '輸出 PNG 影像資料 (95%)');
    await new Promise(r => setTimeout(r, 50));

    // 產生 Blob 與 Object URL（相比巨大 base64 DataURL，Blob 更節省 iPhone 記憶體且下載相容性最佳）
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('無法產生圖片二進位資料');

    const objectUrl = URL.createObjectURL(blob);
    previewImg.src = objectUrl;
    updateExportProgress(100, '長圖合成完成！', '長圖已準備完畢 (100%)');

    setTimeout(() => {
      loading.style.display = 'none';
      previewContainer.classList.remove('hidden');
    }, 150);

    const safeFilename = `【教學】${sanitizeFilename(note.title || '記事')}.png`;

    // 下載按鈕事件 (針對 iOS / 手機深度優化：支援 Web Share API 直接存入相簿)
    const btnDownload = document.getElementById('btn-download-export-image');
    btnDownload.onclick = async () => {
      // 判斷是否支援 Web Share API 檔案分享 (iOS Safari 最佳體驗：點擊即可選「儲存影像」直接進相簿)
      const file = new File([blob], safeFilename, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            title: note.title || '個人筆記',
            text: '匯出長圖片'
          });
          showToast('已開啟分享選單，可直接點選「儲存影像」至相簿！');
          return;
        } catch (shareErr) {
          if (shareErr.name !== 'AbortError') {
            console.log('Web Share 失敗，轉為常規下載:', shareErr);
          } else {
            return; // 使用者主動取消分享
          }
        }
      }

      // 常規下載流程
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = safeFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast('長圖已開始下載！若使用 iPhone 請在跳出選單點「檢視」後長按儲存圖片');
    };

    // 複製圖片按鈕事件 (Clipboard Item)
    const btnCopy = document.getElementById('btn-copy-export-image');
    btnCopy.onclick = async () => {
      try {
        if (!navigator.clipboard || !window.ClipboardItem) {
          throw new Error('Clipboard API 不支援');
        }
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        showToast('長圖已複製！可直接至通訊軟體 (LINE/Teams) 按貼上！');
      } catch (err) {
        showToast('此瀏覽器不支援直接複製圖片，請直接點擊「下載長圖」或長按圖片儲存！');
      }
    };

  } catch (err) {
    console.error('合成長圖失敗:', err);
    alert('合成長圖失敗: ' + (err.message || err));
    modal.classList.add('hidden');
  } finally {
    if (renderDiv.parentNode) {
      document.body.removeChild(renderDiv);
    }
  }
}
async function urlToDataURL(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('data:image/')) return url;
  try {
    const res = await fetch(url);
    if (!res.ok) return url;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(url);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return url;
  }
}

async function exportAllData() {
  showToast('正在打包資料與完整圖片，請稍候...');
  
  // 深拷貝記事資料並將所有相對圖片路徑轉為 Base64 DataURL，保證換電腦也能 100% 還原圖片
  const exportedNotes = [];
  for (let n of state.notes) {
    const noteCopy = JSON.parse(JSON.stringify(n));
    if (noteCopy.images && Array.isArray(noteCopy.images)) {
      noteCopy.images = await Promise.all(noteCopy.images.map(img => urlToDataURL(img)));
    }
    if (noteCopy.comments && Array.isArray(noteCopy.comments)) {
      for (let c of noteCopy.comments) {
        if (c.images && Array.isArray(c.images)) {
          c.images = await Promise.all(c.images.map(img => urlToDataURL(img)));
        }
      }
    }
    exportedNotes.push(noteCopy);
  }

  const exportPayload = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    categories: state.categories,
    notes: exportedNotes
  };

  const jsonStr = JSON.stringify(exportPayload, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  a.href = url;
  a.download = `個人記事本備份_${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`已成功匯出備份檔案 (${state.notes.length} 則記事，內含圖文完整包)`);
}

async function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.notes || !Array.isArray(data.notes)) {
        alert('匯入失敗：備份檔格式不正確！');
        return;
      }

      const noteCount = data.notes.length;
      if (!confirm(`備份檔案包含 ${noteCount} 則記事。\n點擊「確定」進行還原與合併。`)) {
        return;
      }

      state.isRestoring = true;
      showToast('正在還原備份資料與圖片，請稍候...');

      // 1. 合併分類
      let mergedCats = [...state.categories];
      if (data.categories && Array.isArray(data.categories)) {
        mergedCats = Array.from(new Set([...state.categories, ...data.categories]));
        state.categories = mergedCats;
        await state.db.saveCategories(mergedCats);
      }

      // 2. 還原存入本地 IndexedDB
      for (let note of data.notes) {
        await state.db.saveNote(note);
      }

      // 3. 若後端伺服器在線，同步呼叫 /api/restore 將實體檔案、圖片與 Access MDB 全面還原
      const serverResult = await syncRestoreToServer(data.notes, mergedCats);
      if (serverResult && Array.isArray(serverResult.notes)) {
        // 以伺服器處理後具有實體路徑之資料為準
        for (let sn of serverResult.notes) {
          await state.db.saveNote(sn);
        }
      }

      state.notes = await state.db.getAllNotes();
      state.categories = await state.db.getCategories();
      renderCategories();
      renderNotesList();

      if (state.notes.length > 0) {
        selectNote(state.notes[0].id);
      }

      state.isRestoring = false;
      alert(`還原完成！共還原並更新 ${noteCount} 則記事，文字與圖片已同步存入實體資料庫。`);
    } catch (err) {
      state.isRestoring = false;
      alert('解析備份檔案錯誤: ' + err.message);
    }
  };
  reader.readAsText(file, 'utf-8');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- 8. 事件監聽綁定 ---
function initEventListeners() {
  dom.btnNewNote.addEventListener('click', () => openEditor());

  dom.searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    if (state.searchQuery) {
      dom.btnClearSearch.classList.remove('hidden');
    } else {
      dom.btnClearSearch.classList.add('hidden');
    }
    renderNotesList();
  });

  dom.btnClearSearch.addEventListener('click', () => {
    dom.searchInput.value = '';
    state.searchQuery = '';
    dom.btnClearSearch.classList.add('hidden');
    renderNotesList();
  });

  dom.sortSelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderNotesList();
  });

  document.querySelector('[data-category="all"]').addEventListener('click', () => setCategory('all'));
  document.querySelector('[data-category="pinned"]').addEventListener('click', () => setCategory('pinned'));
  dom.btnAddCategory.addEventListener('click', addNewCategoryPrompt);
  dom.btnQuickNewCategory.addEventListener('click', addNewCategoryPrompt);

  if (dom.btnExportData) dom.btnExportData.addEventListener('click', exportAllData);
  if (dom.btnImportTrigger) dom.btnImportTrigger.addEventListener('click', () => dom.fileImport && dom.fileImport.click());
  if (dom.fileImport) {
    dom.fileImport.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleImportFile(e.target.files[0]);
        e.target.value = '';
      }
    });
  }

  // Google Drive 同步按鈕事件
  const btnGDriveLogin = document.getElementById('btn-gdrive-login');
  if (btnGDriveLogin) {
    btnGDriveLogin.addEventListener('click', () => {
      if (window.gDriveSync) {
        if (window.gDriveSync.isLoggedIn()) {
          if (confirm('確定要登出 Google 帳號嗎？登出後將暫停自動雲端同步。')) {
            window.gDriveSync.signOut();
          }
        } else {
          window.gDriveSync.signIn();
        }
      }
    });
  }

  // 側邊欄「備份到雲端」按鈕
  const btnGDriveBackup = document.getElementById('btn-gdrive-backup');
  if (btnGDriveBackup) {
    btnGDriveBackup.addEventListener('click', () => {
      if (window.gDriveSync) window.gDriveSync.backupToCloud();
    });
  }

  // 側邊欄「從雲端還原」按鈕
  const btnGDriveRestore = document.getElementById('btn-gdrive-restore');
  if (btnGDriveRestore) {
    btnGDriveRestore.addEventListener('click', () => {
      if (window.gDriveSync) window.gDriveSync.restoreFromCloud();
    });
  }

  // 頂部「雲端上傳備份 ☁️⬆️」快捷按鈕
  const btnTopCloudUpload = document.getElementById('btn-top-cloud-upload');
  if (btnTopCloudUpload) {
    btnTopCloudUpload.addEventListener('click', () => {
      if (window.gDriveSync) window.gDriveSync.backupToCloud();
    });
  }

  // 頂部「雲端下載還原 ☁️⬇️」快捷按鈕
  const btnTopCloudDownload = document.getElementById('btn-top-cloud-download');
  if (btnTopCloudDownload) {
    btnTopCloudDownload.addEventListener('click', () => {
      if (window.gDriveSync) window.gDriveSync.restoreFromCloud();
    });
  }

  dom.btnCloseModal.addEventListener('click', closeEditor);
  dom.btnCancelEdit.addEventListener('click', closeEditor);
  dom.btnSaveNote.addEventListener('click', saveCurrentNote);

  dom.btnAddImages.addEventListener('click', () => dom.fileImagesInput.click());
  dom.fileImagesInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      await handleImageFiles(files);
      e.target.value = '';
    }
  });

  dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('drag-over');
  });
  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('drag-over');
  });
  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleImageFiles(e.dataTransfer.files);
    }
  });

  window.addEventListener('paste', (e) => {
    if (dom.editorModal.classList.contains('hidden')) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    const imageFiles = [];
    for (let item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      handleImageFiles(imageFiles);
    }
  });

  dom.lightboxClose.addEventListener('click', closeLightbox);
  if (dom.lightboxDownload) {
    dom.lightboxDownload.addEventListener('click', downloadCurrentLightboxImage);
  }
  dom.lightboxPrev.addEventListener('click', prevLightbox);
  dom.lightboxNext.addEventListener('click', nextLightbox);
  document.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);

  // 補充記錄編輯視窗事件
  dom.btnSaveEditComment.addEventListener('click', saveEditedComment);
  dom.btnCancelEditComment.addEventListener('click', closeEditCommentModal);
  dom.btnCloseCommentModal.addEventListener('click', closeEditCommentModal);
  dom.editCommentBackdrop.addEventListener('click', closeEditCommentModal);

  // 手機連線視窗事件
  function openMobileModal() {
    let mobileUrl = '';
    const isLocalHost = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || !window.location.hostname;
    
    if (!isLocalHost && !window.location.port) {
      // 部署在 GitHub Pages 或其他雲端靜態平台，直接使用當前完整網址 (包含路徑，絕不加 :8766)
      mobileUrl = window.location.href.split('#')[0];
    } else {
      // 本地電腦伺服器環境
      mobileUrl = currentMobileUrl || `http://${window.location.hostname || '127.0.0.1'}:8766/index.html`;
    }

    dom.mobileUrlInput.value = mobileUrl;
    dom.qrcodeContainer.innerHTML = '';
    if (window.QRCode) {
      new QRCode(dom.qrcodeContainer, {
        text: mobileUrl,
        width: 180,
        height: 180,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
      });
    } else {
      dom.qrcodeContainer.innerHTML = `<a href="${mobileUrl}" target="_blank" style="color:var(--primary);">${mobileUrl}</a>`;
    }
    dom.mobileModal.classList.remove('hidden');
  }

  function closeMobileModal() {
    dom.mobileModal.classList.add('hidden');
  }

  if (dom.btnMobileConnect) {
    dom.btnMobileConnect.addEventListener('click', openMobileModal);
  }
  if (dom.btnCloseMobileModal) {
    dom.btnCloseMobileModal.addEventListener('click', closeMobileModal);
  }
  if (dom.mobileModalBackdrop) {
    dom.mobileModalBackdrop.addEventListener('click', closeMobileModal);
  }

  // 匯出長圖視窗關閉事件
  const exportModal = document.getElementById('export-image-modal');
  const btnCloseExportModal = document.getElementById('btn-close-export-modal');
  const exportImageBackdrop = document.getElementById('export-image-backdrop');
  if (btnCloseExportModal && exportModal) {
    btnCloseExportModal.addEventListener('click', () => exportModal.classList.add('hidden'));
  }
  if (exportImageBackdrop && exportModal) {
    exportImageBackdrop.addEventListener('click', () => exportModal.classList.add('hidden'));
  }
  if (dom.btnCopyMobileUrl) {
    dom.btnCopyMobileUrl.addEventListener('click', () => {
      dom.mobileUrlInput.select();
      navigator.clipboard.writeText(dom.mobileUrlInput.value).then(() => {
        showToast('網址已複製到剪貼簿！');
      }).catch(() => {
        document.execCommand('copy');
        showToast('網址已複製到剪貼簿！');
      });
    });
  }


  // 手機抽屜選單與懸浮按鈕 (FAB) 事件
  function toggleMobileSidebar() {
    if (dom.sidebar) {
      dom.sidebar.classList.toggle('mobile-open');
    }
    if (dom.sidebarOverlay) {
      dom.sidebarOverlay.classList.toggle('active');
    }
  }

  function closeMobileSidebar() {
    if (dom.sidebar) {
      dom.sidebar.classList.remove('mobile-open');
    }
    if (dom.sidebarOverlay) {
      dom.sidebarOverlay.classList.remove('active');
    }
  }

  const btnCloseSidebar = document.getElementById('btn-close-sidebar');
  if (btnCloseSidebar) {
    btnCloseSidebar.addEventListener('click', closeMobileSidebar);
  }

  if (dom.btnMobileMenu) {
    dom.btnMobileMenu.addEventListener('click', toggleMobileSidebar);
  }
  if (dom.sidebarOverlay) {
    dom.sidebarOverlay.addEventListener('click', closeMobileSidebar);
    dom.sidebarOverlay.addEventListener('touchstart', closeMobileSidebar);
  }
  if (dom.btnMobileFab) {
    dom.btnMobileFab.addEventListener('click', () => {
      openEditor();
    });
  }

  // 手機端支援側邊欄向左滑動手勢直接關閉 (Touch Swipe)
  let touchStartX = 0;
  if (dom.sidebar) {
    dom.sidebar.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    dom.sidebar.addEventListener('touchend', (e) => {
      const touchEndX = e.changedTouches[0].clientX;
      if (touchStartX - touchEndX > 50) { // 向左滑動超過 50px
        closeMobileSidebar();
      }
    }, { passive: true });
  }


  // 點擊分類標籤後自動收合手機抽屜
  document.querySelectorAll('.category-item').forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        closeMobileSidebar();
        closeMobileDetailView();
      }
    });
  });


  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const exportModal = document.getElementById('export-image-modal');
      if (exportModal && !exportModal.classList.contains('hidden')) {
        exportModal.classList.add('hidden');
      } else if (!dom.lightboxModal.classList.contains('hidden')) {
        closeLightbox();
      } else if (!dom.mobileModal.classList.contains('hidden')) {
        closeMobileModal();
      } else if (!dom.editCommentModal.classList.contains('hidden')) {
        closeEditCommentModal();
      } else if (!dom.editorModal.classList.contains('hidden')) {
        closeEditor();
      }
    }
    if (!dom.lightboxModal.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') prevLightbox();
      if (e.key === 'ArrowRight') nextLightbox();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      if (!dom.editorModal.classList.contains('hidden')) {
        e.preventDefault();
        saveCurrentNote();
      }
    }
  });
}


// --- 9. 預載範例資料 ---
async function seedInitialDataIfEmpty() {
  return;
}

// --- 10. 初始化啟動 ---
async function initApp() {
  try {
    await state.db.init();
    // 智慧合併實體檔案與本機 IndexedDB 資料 (以最新更新時間 updatedAt 為準，決不覆蓋遺失追加紀錄)
    if (window.__LOCAL_SYNC_DATA__ && Array.isArray(window.__LOCAL_SYNC_DATA__)) {
      for (let item of window.__LOCAL_SYNC_DATA__) {
        const localExisting = await new Promise((res) => {
          const tx = state.db.db.transaction(['notes'], 'readonly');
          const req = tx.objectStore('notes').get(item.id);
          req.onsuccess = () => res(req.result);
          req.onerror = () => res(null);
        });
        if (!localExisting || (item.updatedAt && item.updatedAt > (localExisting.updatedAt || 0))) {
          await state.db.saveNote(item);
        }
      }
    }
    if (window.__LOCAL_SYNC_CATS__ && Array.isArray(window.__LOCAL_SYNC_CATS__)) {
      await state.db.saveCategories(window.__LOCAL_SYNC_CATS__);
    }
    await state.db.deleteNote('note_welcome');
    state.notes = (await state.db.getAllNotes()).filter(n => n.id !== 'note_welcome');
    state.categories = await state.db.getCategories();

    // 1. 0 延遲立即渲染本機畫面 (分類目錄與記事卡片秒出，完全不卡頓)
    initEventListeners();
    renderCategories();
    renderNotesList();
    if (state.notes.length > 0 && window.innerWidth > 768) {
      selectNote(state.notes[0].id);
    }


    // 2. 雙向自動同步模組 (電腦與手機任何一方新增、修改、刪除，3秒內全自動即時同步)
    const doFullSync = async () => {
      if (state.isRestoring) return;
      const serverData = await checkSyncServer();
      if (!serverData || !Array.isArray(serverData.notes)) return;

      const serverNotes = serverData.notes;
      const serverIds = new Set(serverNotes.map(n => n.id));
      const localNotes = await state.db.getAllNotes();

      let stateChanged = false;

      // A. 同步伺服器端的刪除：若本機有的記事在伺服器上已被刪除，本機跟著刪除
      for (let ln of localNotes) {
        if (!serverIds.has(ln.id)) {
          await state.db.deleteNote(ln.id);
          stateChanged = true;
          if (state.selectedNoteId === ln.id) {
            state.selectedNoteId = null;
            selectNote(null);
            closeMobileDetailView();
          }
        }
      }

      // B. 同步伺服器端的新增與更新 (比對 updatedAt、留言數量及內容雜湊)
      for (let sn of serverNotes) {
        const localMatch = localNotes.find(ln => ln.id === sn.id);
        const serverCommentsLen = (sn.comments || []).length;
        const localCommentsLen = (localMatch && localMatch.comments) ? localMatch.comments.length : 0;
        
        const isNew = !localMatch;
        const isTimeUpdated = localMatch && sn.updatedAt && sn.updatedAt > (localMatch.updatedAt || 0);
        const isCommentsCountChanged = localMatch && serverCommentsLen !== localCommentsLen;
        const isCommentsContentChanged = localMatch && JSON.stringify(sn.comments || []) !== JSON.stringify(localMatch.comments || []);

        if (isNew || isTimeUpdated || isCommentsCountChanged || isCommentsContentChanged) {
          await state.db.saveNote(sn);
          stateChanged = true;
        }
      }

      // C. 同步分類
      if (serverData.categories && Array.isArray(serverData.categories)) {
        if (JSON.stringify(serverData.categories) !== JSON.stringify(state.categories)) {
          await state.db.saveCategories(serverData.categories);
          state.categories = serverData.categories;
          stateChanged = true;
        }
      }

      // 若有任何資料變動，即時重繪畫面
      if (stateChanged) {
        state.notes = await state.db.getAllNotes();
        renderCategories();
        renderNotesList();

        if (state.selectedNoteId) {
          const currentSelected = state.notes.find(n => n.id === state.selectedNoteId);
          if (currentSelected) {
            // 如果手機端使用者正在清單頁面 (未進入記事詳情)，不要突兀跳入詳情
            const isMobile = window.innerWidth <= 768;
            const isMobileInDetail = dom.noteViewPane && dom.noteViewPane.classList.contains('mobile-active');

            if (isMobile && !isMobileInDetail) {
              // 手機使用者在清單中，清單已透過 renderNotesList() 更新，不強制切換到詳情
            } else {
              // 檢查看是否只需局部更新補充時間軸 (如果使用者的輸入框正在輸入，避免重繪清空內容)
              const commentInput = document.getElementById('comment-input');
              const isTypingComment = commentInput && (document.activeElement === commentInput || commentInput.value.trim().length > 0);
              
              if (isTypingComment) {
                // 使用者正在輸入，僅更新上方補充列表，不重繪整頁輸入框
                updateCommentsTimelineOnly(currentSelected);
              } else {
                selectNote(currentSelected.id);
              }
            }
          }
        }
      }
    };

    // 若在本地環境 (Localhost/127.0.0.1) 才啟動 Python 本地伺服器 (MDB) 的即時輪詢同步
    if (isLocalhost) {
      doFullSync();
      setInterval(doFullSync, 2000);
    }


    // 初始化 Google Drive 雲端同步模組
    if (window.gDriveSync) {
      window.gDriveSync.init();
    }

  } catch (err) {
    console.error('應用程式初始化失敗:', err);
    alert('應用程式啟動失敗，請確認瀏覽器支援 IndexedDB。');
  }
}

window.addEventListener('DOMContentLoaded', initApp);
