// ══════════════════════════════════════════════════════
//  Second Brain — Service Worker  v2.0
//  功能：
//   1. 快取資源（離線可用）
//   2. 接收主頁面傳來的筆記資料
//   3. 每天 08:00 自動推送到期 Project 通知
//   4. 處理通知點擊 → 開啟對應筆記
// ══════════════════════════════════════════════════════

const CACHE_NAME = 'second-brain-v2';
const URLS_TO_CACHE = [
  './',
  './second-brain.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── Storage key (mirror of main app) ──
const LS_KEY = 'secondbrain_notes_v2';
const NOTIF_TIME_KEY = 'sb_notif_time';  // "08:00"
const LAST_CHECK_KEY = 'sb_sw_last_check';

// ══════════════════════════════════════════
//  INSTALL — cache static assets
// ══════════════════════════════════════════
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Try to cache, but don't fail install if some files missing
        return cache.addAll(URLS_TO_CACHE).catch(e => {
          console.warn('[SW] Cache addAll partial fail:', e);
        });
      })
      .then(() => self.skipWaiting())
  );
});

// ══════════════════════════════════════════
//  ACTIVATE — clean old caches
// ══════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ══════════════════════════════════════════
//  FETCH — serve from cache, fallback network
// ══════════════════════════════════════════
self.addEventListener('fetch', event => {
  // Only cache GET requests for our own origin
  if(event.request.method !== 'GET') return;
  if(!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses
        if(response && response.status === 200 && response.type === 'basic'){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for HTML
        if(event.request.destination === 'document'){
          return caches.match('./second-brain.html');
        }
      });
    })
  );
});

// ══════════════════════════════════════════
//  MESSAGE — receive notes from main page
// ══════════════════════════════════════════
let cachedNotes = [];

self.addEventListener('message', event => {
  const { type, notes, todayStr } = event.data || {};

  if(type === 'SYNC_NOTES' || type === 'SCHEDULE_CHECK'){
    try {
      cachedNotes = JSON.parse(notes || '[]');
      console.log('[SW] Synced', cachedNotes.length, 'notes');

      // After syncing, check if we should send notifications today
      if(todayStr) {
        checkAndNotify(cachedNotes, todayStr);
      }
    } catch(e) {
      console.warn('[SW] Failed to parse notes:', e);
    }
  }
});

// ══════════════════════════════════════════
//  NOTIFICATION CLICK — open app to note
// ══════════════════════════════════════════
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const noteId = event.notification.data?.noteId;
  const action  = event.action;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it and send message to open note
      for(const client of clientList){
        if(client.url.includes('second-brain') && 'focus' in client){
          client.focus();
          if(noteId) client.postMessage({ type: 'OPEN_NOTE', id: noteId });
          return;
        }
      }
      // Otherwise open a new window
      const url = noteId
        ? `./second-brain.html#note=${noteId}`
        : './second-brain.html';
      if(clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ══════════════════════════════════════════
//  PUSH EVENT (for future server-push)
// ══════════════════════════════════════════
self.addEventListener('push', event => {
  if(!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || '⏰ Second Brain', {
        body: data.body || '',
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: data.tag || 'sb-push',
        data: { noteId: data.noteId },
        actions: data.noteId ? [
          { action: 'open', title: '開啟筆記' },
          { action: 'dismiss', title: '稍後再說' }
        ] : []
      })
    );
  } catch(e) {
    console.warn('[SW] Push parse error:', e);
  }
});

// ══════════════════════════════════════════
//  PERIODIC BACKGROUND SYNC (Chrome/Android)
// ══════════════════════════════════════════
self.addEventListener('periodicsync', event => {
  if(event.tag === 'sb-daily-check'){
    event.waitUntil(backgroundDailyCheck());
  }
});

async function backgroundDailyCheck(){
  // Try to get fresh notes from clients
  const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  if(clientList.length > 0){
    clientList[0].postMessage({ type: 'REQUEST_NOTES' });
    // Give time for the response
    await new Promise(r => setTimeout(r, 500));
  }

  const todayStr = new Date().toISOString().slice(0,10);
  await checkAndNotify(cachedNotes, todayStr);
}

// ══════════════════════════════════════════
//  CORE: CHECK NOTES AND SEND NOTIFICATIONS
// ══════════════════════════════════════════
async function checkAndNotify(notes, todayStr){
  if(!notes || !notes.length) return;

  const today = new Date(todayStr);
  today.setHours(0,0,0,0);

  // Avoid duplicate notifications on same day
  const lastCheck = await getStore(LAST_CHECK_KEY);
  if(lastCheck === todayStr){
    console.log('[SW] Already checked today');
    return;
  }

  const urgent   = [];  // overdue or today
  const upcoming = [];  // within reminder window

  notes.forEach(note => {
    if(note.cat !== 'project' || !note.dueDate) return;

    const due = new Date(note.dueDate);
    due.setHours(0,0,0,0);
    const diff = Math.round((due - today) / 86400000);

    const remindDays = Array.isArray(note.reminderDays) && note.reminderDays.length
      ? note.reminderDays
      : [1, 3, 7];

    if(diff < 0){
      urgent.push({ ...note, diff, label: `已逾期 ${Math.abs(diff)} 天` });
    } else if(diff === 0){
      urgent.push({ ...note, diff, label: '今天到期' });
    } else if(remindDays.includes(diff)){
      upcoming.push({ ...note, diff, label: `${diff} 天後到期` });
    }
  });

  const allHits = [...urgent, ...upcoming];
  if(!allHits.length){
    await setStore(LAST_CHECK_KEY, todayStr);
    return;
  }

  // Send individual notifications for urgent items (max 3)
  for(const note of urgent.slice(0, 3)){
    await self.registration.showNotification(
      `⏰ ${note.title}`, {
        body: `Project「${note.title}」${note.label}！點擊立即處理`,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: `sb-due-${note.id}`,
        requireInteraction: true,
        data: { noteId: note.id },
        actions: [
          { action: 'open',    title: '開啟筆記' },
          { action: 'dismiss', title: '我知道了' }
        ]
      }
    );
  }

  // Bundle upcoming items into one notification
  if(upcoming.length > 0){
    const titles = upcoming.slice(0,3).map(n => `· ${n.title} (${n.label})`).join('\n');
    const extra  = upcoming.length > 3 ? `\n還有 ${upcoming.length - 3} 個...` : '';
    await self.registration.showNotification(
      `📅 Second Brain — ${upcoming.length} 個 Project 提醒`, {
        body: titles + extra,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'sb-upcoming',
        data: { noteId: upcoming[0]?.id }
      }
    );
  }

  await setStore(LAST_CHECK_KEY, todayStr);
  console.log('[SW] Notifications sent:', allHits.length);
}

// ══════════════════════════════════════════
//  SIMPLE KEY-VALUE STORE (IndexedDB-lite via Cache API)
//  用 CacheStorage 存少量設定，不需要 IndexedDB
// ══════════════════════════════════════════
const META_CACHE = 'sb-meta-v1';

async function setStore(key, value){
  try {
    const cache = await caches.open(META_CACHE);
    const resp  = new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put(`/sb-meta/${key}`, resp);
  } catch(e){ console.warn('[SW] setStore error:', e); }
}

async function getStore(key){
  try {
    const cache = await caches.open(META_CACHE);
    const resp  = await cache.match(`/sb-meta/${key}`);
    if(!resp) return null;
    return await resp.json();
  } catch(e){ return null; }
}
