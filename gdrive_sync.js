/**
 * Google Drive 同步模組 (Google Drive Sync Module)
 * 使用 Google Identity Services (token client) + Google Drive API (v3)
 * 自動在使用者個人的 Google 雲端硬碟建立「my_notes_backup.json」，達成電腦關機隨時隨地多端同步
 */

const GOOGLE_CLIENT_ID = '480584912115-1fe1svhaf80lfpdg667i9mmu0b38o175.apps.googleusercontent.com';
const DRIVE_FILE_NAME = 'my_notes_backup.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

class GoogleDriveSync {
  constructor() {
    this.accessToken = localStorage.getItem('gdrive_token') || null;
    this.tokenExpiry = parseInt(localStorage.getItem('gdrive_token_expiry') || '0', 10);
    this.fileId = localStorage.getItem('gdrive_file_id') || null;
    this.userEmail = localStorage.getItem('gdrive_user_email') || null;
    this.tokenClient = null;
    this.isSyncing = false;
    this.lastSyncTime = 0;
    this.syncInterval = null;
  }

  init() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      try {
        this.tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
              this.accessToken = tokenResponse.access_token;
              // tokenResponse.expires_in 通常為 3599 秒
              this.tokenExpiry = Date.now() + ((tokenResponse.expires_in || 3600) - 120) * 1000;
              localStorage.setItem('gdrive_token', this.accessToken);
              localStorage.setItem('gdrive_token_expiry', this.tokenExpiry.toString());
              this.fetchUserInfo().then(() => {
                this.updateUI();
                this.syncNow();
              });
            }
          }
        });
      } catch (err) {
        console.warn('Google Token Client 初始化異常:', err);
      }
    }

    this.updateUI();

    // 如果先前有 Token 且尚未過期，嘗試立即觸發一次同步
    if (this.isLoggedIn()) {
      this.syncNow();
    }

    // 每 15 秒檢查一次是否有雲端最新更新
    this.syncInterval = setInterval(() => {
      if (this.isLoggedIn() && !this.isSyncing) {
        this.syncNow(true); // background silent sync
      }
    }, 15000);
  }

  isLoggedIn() {
    return !!(this.accessToken && Date.now() < this.tokenExpiry);
  }

  signIn() {
    if (!this.tokenClient) {
      this.init();
    }
    if (this.tokenClient) {
      this.tokenClient.requestAccessToken({ prompt: '' });
    } else {
      alert('Google 服務載入中，請稍候重試或檢查網路連線。');
    }
  }

  signOut() {
    if (this.accessToken && window.google && window.google.accounts && window.google.accounts.oauth2) {
      google.accounts.oauth2.revoke(this.accessToken, () => {
        console.log('Google token revoked');
      });
    }
    this.accessToken = null;
    this.tokenExpiry = 0;
    this.fileId = null;
    this.userEmail = null;
    localStorage.removeItem('gdrive_token');
    localStorage.removeItem('gdrive_token_expiry');
    localStorage.removeItem('gdrive_file_id');
    localStorage.removeItem('gdrive_user_email');
    this.updateUI();
  }

  async fetchUserInfo() {
    if (!this.accessToken) return;
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      if (res.ok) {
        const info = await res.json();
        this.userEmail = info.email || '已連結 Google';
        localStorage.setItem('gdrive_user_email', this.userEmail);
      }
    } catch (e) {
      console.warn('取得 Google 使用者資訊失敗:', e);
    }
  }

  recordDeletion(noteId) {
    try {
      const deleted = new Set(JSON.parse(localStorage.getItem('gdrive_deleted_ids') || '[]'));
      deleted.add(noteId);
      localStorage.setItem('gdrive_deleted_ids', JSON.stringify(Array.from(deleted)));
    } catch (e) {
      console.warn('記錄刪除標記失敗:', e);
    }
  }

  async findOrCreateDriveFile() {
    if (this.fileId) {
      // 驗證一下 fileId 是否依然有效存在
      try {
        const checkRes = await fetch(`https://www.googleapis.com/drive/v3/files/${this.fileId}?fields=id,name,trashed`, {
          headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (checkRes.ok) {
          const fileData = await checkRes.json();
          if (!fileData.trashed) return this.fileId;
        }
      } catch (e) {
        console.warn('檢查既有 Drive 檔案失敗:', e);
      }
    }

    // 搜尋現有檔名
    try {
      const query = encodeURIComponent(`name = '${DRIVE_FILE_NAME}' and trashed = false`);
      const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive&fields=files(id,name)`, {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      if (searchRes.ok) {
        const list = await searchRes.json();
        if (list.files && list.files.length > 0) {
          this.fileId = list.files[0].id;
          localStorage.setItem('gdrive_file_id', this.fileId);
          return this.fileId;
        }
      }
    } catch (e) {
      console.warn('搜尋 Drive 檔案失敗:', e);
    }

    // 如果沒有，建立新檔案
    try {
      const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: DRIVE_FILE_NAME,
          mimeType: 'application/json'
        })
      });
      if (createRes.ok) {
        const created = await createRes.json();
        this.fileId = created.id;
        localStorage.setItem('gdrive_file_id', this.fileId);
        return this.fileId;
      }
    } catch (e) {
      console.error('在 Google Drive 建立檔案失敗:', e);
    }
    return null;
  }

  /**
   * 雙向智能同步：比對雲端與本機最新時間戳記
   */
  async syncNow(isSilent = false) {
    if (!this.isLoggedIn()) {
      if (!isSilent) this.signIn();
      return;
    }

    if (this.isSyncing) return;
    this.isSyncing = true;
    this.updateStatusBadge('syncing', 'Google Drive 同步中...');

    try {
      const fileId = await this.findOrCreateDriveFile();
      if (!fileId) throw new Error('無法存取 Google 雲端硬碟檔案');

      // 1. 從 Google Drive 讀取雲端內容
      let cloudData = null;
      try {
        const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&_t=${Date.now()}`, {
          headers: { Authorization: `Bearer ${this.accessToken}` }
        });
        if (downloadRes.ok) {
          const text = await downloadRes.text();
          if (text && text.trim().length > 0) {
            cloudData = JSON.parse(text);
          }
        }
      } catch (e) {
        console.warn('下載 Google Drive 檔案失敗:', e);
      }

      // 2. 取得本機 IndexedDB 資料與刪除墓碑 (tombstones)
      const localNotes = await state.db.getAllNotes();
      const localCategories = await state.db.getCategories();
      let localDeletedIds = new Set(JSON.parse(localStorage.getItem('gdrive_deleted_ids') || '[]'));
      let stateChanged = false;

      // 3. 雙向合併 (Merge)
      if (cloudData && Array.isArray(cloudData.notes)) {
        const cloudNotes = cloudData.notes;
        const cloudDeletedIds = new Set(Array.isArray(cloudData.deletedNoteIds) ? cloudData.deletedNoteIds : []);

        // 合併雙方的刪除清單
        const mergedDeletedIds = new Set([...localDeletedIds, ...cloudDeletedIds]);

        // A. 處理刪除：如果在合併後的刪除清單中，本機必須刪除
        for (let ln of localNotes) {
          if (mergedDeletedIds.has(ln.id)) {
            await state.db.deleteNote(ln.id);
            stateChanged = true;
          }
        }

        // B. 處理新增與更新：排除已刪除的記事
        for (let cn of cloudNotes) {
          if (mergedDeletedIds.has(cn.id)) continue;

          const lm = localNotes.find(ln => ln.id === cn.id);
          const cnTime = new Date(cn.updatedAt || 0).getTime();
          const lmTime = lm ? new Date(lm.updatedAt || 0).getTime() : 0;
          const cnCommentsLen = (cn.comments || []).length;
          const lmCommentsLen = (lm && lm.comments) ? lm.comments.length : 0;

          if (!lm || cnTime > lmTime || cnCommentsLen > lmCommentsLen) {
            await state.db.saveNote(cn);
            stateChanged = true;
          }
        }

        // 更新本機記錄的刪除清單
        localStorage.setItem('gdrive_deleted_ids', JSON.stringify(Array.from(mergedDeletedIds)));
        localDeletedIds = mergedDeletedIds;

        // 分類合併
        if (cloudData.categories && Array.isArray(cloudData.categories)) {
          const mergedCats = Array.from(new Set([...localCategories, ...cloudData.categories])).filter(c => !c.includes('?'));
          if (mergedCats.length !== localCategories.length) {
            await state.db.saveCategories(mergedCats);
            state.categories = mergedCats;
            stateChanged = true;
          }
        }
      }

      // 4. 合併完後，取得本地最新完整資料並將雲端同步更新上去 (排除已刪除)
      const allCurrentNotes = await state.db.getAllNotes();
      const finalNotes = allCurrentNotes.filter(n => !localDeletedIds.has(n.id));
      const finalCategories = await state.db.getCategories();

      const payload = {
        version: '1.2.0',
        exportedAt: new Date().toISOString(),
        categories: finalCategories,
        deletedNoteIds: Array.from(localDeletedIds),
        notes: finalNotes
      };

      // 上傳更新至 Google Drive
      const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8'
        },
        body: JSON.stringify(payload)
      });

      if (!uploadRes.ok) {
        throw new Error(`上傳更新至 Drive 失敗: ${uploadRes.statusText}`);
      }

      if (stateChanged) {
        state.notes = finalNotes;
        renderCategories();
        renderNotesList();
        if (state.selectedNoteId) {
          const current = state.notes.find(n => n.id === state.selectedNoteId);
          if (current) {
            selectNote(current.id);
          } else {
            selectNote(null);
            closeMobileDetailView();
          }
        }
      }

      this.lastSyncTime = Date.now();
      this.updateStatusBadge('online', '已與 Google Drive 同步');
      if (!isSilent) {
        showToast('Google Drive 雲端同步完成！', 'success');
      }

    } catch (err) {
      console.error('Google Drive 同步過程發生錯誤:', err);
      if (err.message && err.message.includes('401')) {
        this.signOut();
      } else {
        this.updateStatusBadge('offline', 'Google Drive 同步失敗');
        if (!isSilent) {
          showToast('Google Drive 同步失敗，請檢查網路連線', 'error');
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  updateStatusBadge(status, text) {
    const badge = document.getElementById('gdrive-sync-badge');
    if (!badge) return;

    if (status === 'online') {
      badge.innerHTML = `<span class="sync-dot online"></span><span style="font-weight: 600; color: #15803d;">${text}</span>`;
      badge.title = `最後同步時間: ${new Date().toLocaleTimeString()} (檔案保存在您的 Google 雲端硬碟)`;
    } else if (status === 'syncing') {
      badge.innerHTML = `<span class="sync-dot syncing"></span><span style="color: #b45309;">${text}</span>`;
    } else {
      badge.innerHTML = `<span class="sync-dot offline"></span><span>${text}</span>`;
    }
  }

  updateUI() {
    const btnSignIn = document.getElementById('btn-gdrive-login');
    const btnSyncNow = document.getElementById('btn-gdrive-sync');
    const badge = document.getElementById('gdrive-sync-badge');
    const userLabel = document.getElementById('gdrive-user-label');

    if (!btnSignIn || !btnSyncNow) return;

    if (this.isLoggedIn()) {
      btnSignIn.innerHTML = '<span class="material-symbols-rounded">logout</span><span>登出 Google</span>';
      btnSignIn.title = `已登入: ${this.userEmail || 'Google 帳號'}`;
      btnSignIn.classList.remove('btn-gdrive-connect');
      btnSignIn.classList.add('btn-gdrive-disconnect');

      btnSyncNow.style.display = 'flex';
      if (badge) badge.style.display = 'flex';
      if (userLabel) {
        userLabel.style.display = 'block';
        userLabel.textContent = this.userEmail ? `帳號: ${this.userEmail}` : 'Google 雲端已連結';
      }
      this.updateStatusBadge('online', '已連結 Google Drive');
    } else {
      btnSignIn.innerHTML = '<span class="material-symbols-rounded">cloud_sync</span><span>連結 Google Drive 自動同步</span>';
      btnSignIn.title = '登入 Google 帳號，達成手機與電腦全自動無縫雲端同步';
      btnSignIn.classList.add('btn-gdrive-connect');
      btnSignIn.classList.remove('btn-gdrive-disconnect');

      btnSyncNow.style.display = 'none';
      if (badge) badge.style.display = 'none';
      if (userLabel) userLabel.style.display = 'none';
    }
  }
}

// 建立全域實例
window.gDriveSync = new GoogleDriveSync();
