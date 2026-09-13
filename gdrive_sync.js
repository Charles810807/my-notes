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
   * 1. 備份至雲端 (上傳)：將當前本機所有的記事與圖片完整覆蓋儲存到 Google 雲端硬碟
   */
  async backupToCloud() {
    if (!this.isLoggedIn()) {
      this.signIn();
      return;
    }

    if (this.isSyncing) return;
    this.isSyncing = true;
    this.updateStatusBadge('syncing', '正在備份至雲端...');

    const btnUpload = document.getElementById('btn-top-cloud-upload');
    if (btnUpload) {
      const icon = btnUpload.querySelector('.material-symbols-rounded');
      if (icon) icon.classList.add('sync-spin');
    }

    try {
      const fileId = await this.findOrCreateDriveFile();
      if (!fileId) throw new Error('無法存取 Google 雲端硬碟檔案');

      const allNotes = await state.db.getAllNotes();
      const allCategories = await state.db.getCategories();

      const payload = {
        version: '1.2.0',
        exportedAt: new Date().toISOString(),
        categories: allCategories,
        notes: allNotes
      };

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

      this.lastSyncTime = Date.now();
      this.updateStatusBadge('online', '已成功備份至雲端');
      showToast(`已成功將 ${allNotes.length} 則記事完整備份至 Google Drive！`, 'success');

    } catch (err) {
      console.error('Google Drive 備份失敗:', err);
      if (err.message && err.message.includes('401')) {
        this.signOut();
      } else {
        this.updateStatusBadge('offline', '備份失敗');
        showToast('備份失敗，請檢查網路連線', 'error');
      }
    } finally {
      this.isSyncing = false;
      if (btnUpload) {
        const icon = btnUpload.querySelector('.material-symbols-rounded');
        if (icon) icon.classList.remove('sync-spin');
      }
    }
  }

  /**
   * 2. 從雲端還原 (下載)：從 Google 雲端硬碟下載最新的備份，並完全覆蓋本機記事
   */
  async restoreFromCloud() {
    if (!this.isLoggedIn()) {
      this.signIn();
      return;
    }

    if (this.isSyncing) return;

    if (!confirm('確定要從 Google Drive 下載並還原嗎？\n這將會以雲端上的最新檔案覆蓋目前本機的記事資料。')) {
      return;
    }

    this.isSyncing = true;
    this.updateStatusBadge('syncing', '正在從雲端下載還原...');

    const btnDownload = document.getElementById('btn-top-cloud-download');
    if (btnDownload) {
      const icon = btnDownload.querySelector('.material-symbols-rounded');
      if (icon) icon.classList.add('sync-spin');
    }

    try {
      const fileId = await this.findOrCreateDriveFile();
      if (!fileId) throw new Error('無法找到 Google 雲端硬碟檔案');

      const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&_t=${Date.now()}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });

      if (!downloadRes.ok) {
        throw new Error(`下載 Google Drive 檔案失敗: ${downloadRes.statusText}`);
      }

      const text = await downloadRes.text();
      if (!text || text.trim().length === 0) {
        throw new Error('雲端上的備份檔案為空！');
      }

      const cloudData = JSON.parse(text);
      if (!cloudData || !Array.isArray(cloudData.notes)) {
        throw new Error('雲端資料格式不符');
      }

      // 1. 清空本機現有筆記並全面寫入雲端筆記
      const currentLocal = await state.db.getAllNotes();
      for (let ln of currentLocal) {
        await state.db.deleteNote(ln.id);
      }
      for (let cn of cloudData.notes) {
        await state.db.saveNote(cn);
      }

      // 2. 還原分類
      if (cloudData.categories && Array.isArray(cloudData.categories)) {
        await state.db.saveCategories(cloudData.categories);
        state.categories = cloudData.categories;
      }

      // 3. 重繪畫面
      state.notes = await state.db.getAllNotes();
      renderCategories();
      renderNotesList();

      if (state.notes.length > 0) {
        selectNote(state.notes[0].id);
      } else {
        selectNote(null);
        closeMobileDetailView();
      }

      this.lastSyncTime = Date.now();
      this.updateStatusBadge('online', '已從雲端還原');
      showToast(`還原成功！已完整還原 ${cloudData.notes.length} 則記事`, 'success');

    } catch (err) {
      console.error('從 Google Drive 還原失敗:', err);
      if (err.message && err.message.includes('401')) {
        this.signOut();
      } else {
        this.updateStatusBadge('offline', '還原失敗');
        showToast('還原失敗: ' + err.message, 'error');
      }
    } finally {
      this.isSyncing = false;
      if (btnDownload) {
        const icon = btnDownload.querySelector('.material-symbols-rounded');
        if (icon) icon.classList.remove('sync-spin');
      }
    }
  }

  // 保留相容函式
  async syncNow() {
    await this.backupToCloud();
  }

  updateStatusBadge(status, text) {
    const badge = document.getElementById('gdrive-sync-badge');
    if (!badge) return;

    if (status === 'online') {
      badge.innerHTML = `<span class="sync-dot online"></span><span style="font-weight: 600; color: #15803d;">${text}</span>`;
      badge.title = `最後操作時間: ${new Date().toLocaleTimeString()} (檔案保存在您的 Google 雲端硬碟)`;
    } else if (status === 'syncing') {
      badge.innerHTML = `<span class="sync-dot syncing"></span><span style="color: #b45309;">${text}</span>`;
    } else {
      badge.innerHTML = `<span class="sync-dot offline"></span><span>${text}</span>`;
    }
  }

  updateUI() {
    const btnSignIn = document.getElementById('btn-gdrive-login');
    const actionsGroup = document.getElementById('gdrive-actions-group');
    const badge = document.getElementById('gdrive-sync-badge');
    const userLabel = document.getElementById('gdrive-user-label');
    const topUpload = document.getElementById('btn-top-cloud-upload');
    const topDownload = document.getElementById('btn-top-cloud-download');

    if (!btnSignIn) return;

    if (this.isLoggedIn()) {
      btnSignIn.innerHTML = '<span class="material-symbols-rounded">logout</span><span>登出 Google</span>';
      btnSignIn.title = `已登入: ${this.userEmail || 'Google 帳號'}`;
      btnSignIn.classList.remove('btn-gdrive-connect');
      btnSignIn.classList.add('btn-gdrive-disconnect');

      if (actionsGroup) actionsGroup.style.display = 'flex';
      if (badge) badge.style.display = 'flex';
      if (userLabel) {
        userLabel.style.display = 'block';
        userLabel.textContent = this.userEmail ? `帳號: ${this.userEmail}` : 'Google 雲端已連結';
      }
      if (topUpload) topUpload.style.display = 'inline-flex';
      if (topDownload) topDownload.style.display = 'inline-flex';
      this.updateStatusBadge('online', '已連結 Google Drive');
    } else {
      btnSignIn.innerHTML = '<span class="material-symbols-rounded">cloud_sync</span><span>連結 Google Drive</span>';
      btnSignIn.title = '登入 Google 帳號，達成手機與電腦隨時備份與還原';
      btnSignIn.classList.add('btn-gdrive-connect');
      btnSignIn.classList.remove('btn-gdrive-disconnect');

      if (actionsGroup) actionsGroup.style.display = 'none';
      if (badge) badge.style.display = 'none';
      if (userLabel) userLabel.style.display = 'none';
      if (topUpload) topUpload.style.display = 'none';
      if (topDownload) topDownload.style.display = 'none';
    }
  }
}

// 建立全域實例
window.gDriveSync = new GoogleDriveSync();
