// ─────────────────────────────────────────────────
// JukeSync — room.js
// ─────────────────────────────────────────────────

const params = new URLSearchParams(window.location.search);
const ROOM_ID = params.get('id');
const NICKNAME = sessionStorage.getItem('nickname') || 'Guest';
let isHost = false;
let roomState = null;
let ytPlayer = null;
let ytReady = false;
let pendingPlay = null; // { videoId, time }
let addSongTargetPlaylistId = null; // null = queue
let moveSongData = null; // { songId, fromPlaylistId }
let dragSource = null;

if (!ROOM_ID) window.location.href = '/';

// ── Socket setup ──────────────────────────────────
const socket = io();

socket.on('connect', () => {
  socket.emit('join-room', { roomId: ROOM_ID, nickname: NICKNAME });
});

socket.on('error', msg => toast(msg, 'error'));

socket.on('room-state', state => {
  roomState = state;
  isHost = state.isHost;
  document.getElementById('room-name').textContent = state.name;
  document.getElementById('room-code').textContent = state.code;
  document.getElementById('my-nickname').textContent = NICKNAME;
  if (isHost) {
    document.getElementById('host-badge').style.display = '';
    document.getElementById('player-bar').classList.remove('hidden');
    document.getElementById('player-bar-guest').classList.add('hidden');
  } else {
    document.getElementById('player-bar').classList.add('hidden');
    document.getElementById('player-bar-guest').classList.remove('hidden');
  }
  applyVolume(state.volume);
  document.getElementById('volume-slider').value = state.volume;
  document.getElementById('vol-label').textContent = state.volume;
  updateShuffleBtn(state.shuffle);
  updateRepeatBtn(state.repeat);
  renderPlaylists(state.playlists);
  renderQueue(state.queue);
  if (state.currentSong) {
    updateNowPlaying(state.currentSong);
    if (state.isPlaying) {
      schedulePlay(state.currentSong.videoId, state.currentTime + (Date.now() - 0) / 1000);
    }
  }
  log(`🎵 "${state.name}" 방에 입장했습니다. 코드: ${state.code}`, 'system');
});

socket.on('became-host', () => {
  isHost = true;
  document.getElementById('host-badge').style.display = '';
  document.getElementById('player-bar').classList.remove('hidden');
  document.getElementById('player-bar-guest').classList.add('hidden');
  log('🎛 당신이 새로운 호스트가 되었습니다.', 'system');
  toast('호스트 권한을 받았습니다!', 'success');
});

socket.on('user-joined', ({ nickname }) => log(`👋 ${nickname}님이 입장했습니다.`, 'system'));
socket.on('user-left', ({ nickname }) => log(`👋 ${nickname}님이 퇴장했습니다.`, 'system'));
socket.on('host-changed', () => log('🎛 호스트가 변경되었습니다.', 'system'));

socket.on('play-song', ({ song }) => {
  updateNowPlaying(song);
  if (roomState) roomState.currentSong = song;
  playYT(song.videoId, 0);
  log(`▶ "${song.title}" 재생 중`, 'play');
});

socket.on('play', ({ videoId, time }) => {
  if (ytPlayer && ytReady) { if (videoId) ytPlayer.loadVideoById(videoId, time || 0); else ytPlayer.seekTo(time || 0, true), ytPlayer.playVideo(); }
  updatePlayBtn(true);
  document.getElementById('guest-playing-icon').textContent = '▶';
});

socket.on('pause', ({ time }) => {
  if (ytPlayer && ytReady) { ytPlayer.pauseVideo(); if (time !== undefined) ytPlayer.seekTo(time, true); }
  updatePlayBtn(false);
  document.getElementById('guest-playing-icon').textContent = '⏸';
});

socket.on('seek', ({ time }) => {
  if (ytPlayer && ytReady) ytPlayer.seekTo(time, true);
});

socket.on('volume', ({ volume }) => applyVolume(volume));

socket.on('stop', () => {
  if (ytPlayer && ytReady) ytPlayer.stopVideo();
  updatePlayBtn(false);
  updateNowPlaying(null);
  log('⏹ 재생 종료', 'system');
});

socket.on('state-update', (patch) => {
  if (!roomState) return;
  Object.assign(roomState, patch);
  if (patch.shuffle !== undefined) updateShuffleBtn(patch.shuffle);
  if (patch.repeat !== undefined) updateRepeatBtn(patch.repeat);
});

socket.on('playlists-update', (playlists) => {
  if (roomState) roomState.playlists = playlists;
  renderPlaylists(playlists);
});

socket.on('queue-update', (queue) => {
  if (roomState) roomState.queue = queue;
  renderQueue(queue);
});

// ── YouTube API ───────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('yt-player', {
    height: '1', width: '1',
    playerVars: { autoplay: 0, controls: 0 },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingPlay) { playYT(pendingPlay.videoId, pendingPlay.time); pendingPlay = null; }
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && isHost) socket.emit('song-ended');
        if (e.data === YT.PlayerState.PLAYING) updatePlayBtn(true);
        if (e.data === YT.PlayerState.PAUSED) updatePlayBtn(false);
      }
    }
  });
};

const ytScript = document.createElement('script');
ytScript.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytScript);

function playYT(videoId, time) {
  if (!ytReady) { pendingPlay = { videoId, time }; return; }
  ytPlayer.loadVideoById({ videoId, startSeconds: time || 0 });
  if (!isHost) applyVolume(roomState?.volume ?? 80);
}

function schedulePlay(videoId, time) {
  playYT(videoId, time);
}

function applyVolume(vol) {
  if (ytPlayer && ytReady) ytPlayer.setVolume(vol);
  document.getElementById('vol-label').textContent = vol;
  document.getElementById('volume-slider').value = vol;
}

// ── Host Controls ─────────────────────────────────
document.getElementById('btn-playpause').onclick = () => {
  if (!isHost) return;
  const playing = ytPlayer && ytReady && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
  if (playing) {
    const t = ytPlayer.getCurrentTime();
    socket.emit('pause', { time: t });
  } else {
    const t = ytPlayer && ytReady ? ytPlayer.getCurrentTime() : 0;
    socket.emit('play', { time: t });
  }
};

document.getElementById('btn-next').onclick = () => isHost && socket.emit('next-song');
document.getElementById('btn-prev').onclick = () => {
  if (!isHost) return;
  if (ytPlayer && ytReady && ytPlayer.getCurrentTime() > 5) {
    socket.emit('seek', { time: 0 });
  } else {
    socket.emit('next-song');
  }
};

document.getElementById('btn-shuffle').onclick = () => isHost && socket.emit('toggle-shuffle');
document.getElementById('btn-repeat').onclick = () => isHost && socket.emit('toggle-repeat');

document.getElementById('volume-slider').oninput = (e) => {
  if (!isHost) return;
  socket.emit('volume', { volume: parseInt(e.target.value) });
  applyVolume(parseInt(e.target.value));
};

function updatePlayBtn(playing) {
  document.getElementById('btn-playpause').textContent = playing ? '⏸' : '▶';
}

function updateShuffleBtn(on) {
  document.getElementById('btn-shuffle').classList.toggle('active', on);
}

function updateRepeatBtn(mode) {
  const btn = document.getElementById('btn-repeat');
  btn.classList.toggle('active', mode !== 'none');
  btn.textContent = mode === 'one' ? '↻¹' : '↻';
  btn.title = { none: '반복 없음', all: '전체 반복', one: '한 곡 반복' }[mode];
}

function updateNowPlaying(song) {
  const title = document.getElementById('now-playing-title');
  const sub = document.getElementById('now-playing-sub');
  const art = document.getElementById('now-playing-art');
  const gTitle = document.getElementById('guest-title');
  const gSub = document.getElementById('guest-sub');
  const gArt = document.getElementById('guest-art');
  if (song) {
    title.textContent = song.title;
    sub.textContent = song.channelTitle || '—';
    art.innerHTML = `<img src="https://img.youtube.com/vi/${song.videoId}/default.jpg" alt="" />`;
    gTitle.textContent = song.title;
    gSub.textContent = song.channelTitle || '—';
    gArt.innerHTML = `<img src="https://img.youtube.com/vi/${song.videoId}/default.jpg" alt="" />`;
  } else {
    title.textContent = '재생 중인 곡 없음';
    sub.textContent = '—';
    art.innerHTML = '♪';
    gTitle.textContent = '재생 중인 곡 없음';
    gSub.textContent = '호스트의 제어를 기다리는 중...';
    gArt.innerHTML = '♪';
  }
}

// ── Playlist UI ────────────────────────────────────
function renderPlaylists(playlists) {
  const el = document.getElementById('playlist-list');
  el.innerHTML = '';
  playlists.forEach((pl, plIdx) => {
    const section = document.createElement('div');
    section.className = 'playlist-section';
    section.dataset.id = pl.id;
    section.dataset.idx = plIdx;

    section.innerHTML = `
      <div class="playlist-header" data-pl-id="${pl.id}">
        <div class="playlist-drag-handle" title="드래그해서 순서 변경">⠿</div>
        <span class="playlist-name">${esc(pl.name)}</span>
        <div class="playlist-actions">
          <button class="btn btn--icon" title="곡 추가" onclick="openAddSong('${pl.id}')">+</button>
          <button class="btn btn--icon btn--play-pl" title="플레이리스트 전체 재생" onclick="playPlaylist('${pl.id}')">▶</button>
          <button class="btn btn--icon btn--del" title="삭제" onclick="deletePlaylist('${pl.id}')">✕</button>
        </div>
      </div>
      <div class="song-list" id="songs-${pl.id}"></div>
    `;

    el.appendChild(section);
    renderSongs(pl.songs, pl.id, `songs-${pl.id}`);
    setupPlaylistDrag(section, plIdx);
  });
}

function renderSongs(songs, playlistId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  songs.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'song-item';
    item.dataset.id = song.id;
    item.dataset.idx = idx;
    item.draggable = true;
    item.innerHTML = `
      <div class="song-drag-handle">⠿</div>
      <img class="song-thumb" src="https://img.youtube.com/vi/${song.videoId}/default.jpg" alt="" />
      <div class="song-info">
        <p class="song-title">${esc(song.title)}</p>
        <p class="song-ch">${esc(song.channelTitle || '')}</p>
      </div>
      <div class="song-actions">
        ${isHost ? `<button class="btn btn--icon btn--play-song" title="재생" onclick="playSong('${JSON.stringify(song).replace(/'/g,"&#39;").replace(/"/g,'&quot;')}')">▶</button>` : ''}
        <button class="btn btn--icon" title="이동" onclick="openMoveSong('${song.id}','${playlistId || ''}')">⇄</button>
        <button class="btn btn--icon btn--del" title="삭제" onclick="removeSong('${song.id}','${playlistId || ''}')">✕</button>
      </div>
    `;
    setupSongDrag(item, idx, playlistId, el);
    el.appendChild(item);
  });
  if (songs.length === 0) el.innerHTML = '<p class="empty-hint" style="padding:0.5rem 1rem;font-size:0.8rem;">곡이 없습니다. + 버튼으로 추가하세요.</p>';
}

function renderQueue(queue) {
  renderSongs(queue, null, 'queue-list');
}

function playSong(songJson) {
  if (!isHost) return;
  const song = JSON.parse(songJson.replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
  socket.emit('play-song', { song });
}

function playPlaylist(playlistId) {
  if (!isHost || !roomState) return;
  const pl = roomState.playlists.find(p => p.id === playlistId);
  if (pl && pl.songs.length > 0) socket.emit('play-song', { song: pl.songs[0] });
}

function deletePlaylist(id) {
  if (confirm('플레이리스트를 삭제할까요?')) socket.emit('delete-playlist', { playlistId: id });
}

function removeSong(songId, playlistId) {
  socket.emit('remove-song', { playlistId: playlistId || null, songId });
}

// ── Add Song Modal ────────────────────────────────
function openAddSong(playlistId) {
  addSongTargetPlaylistId = playlistId || null;
  const title = playlistId
    ? `곡 추가 — ${roomState?.playlists.find(p=>p.id===playlistId)?.name || ''}`
    : '곡 추가 — 대기열';
  document.getElementById('add-song-modal-title').textContent = title;
  document.getElementById('yt-url-input').value = '';
  document.getElementById('add-song-preview').classList.add('hidden');
  document.getElementById('add-song-modal').classList.remove('hidden');
  document.getElementById('yt-url-input').focus();
}

document.getElementById('add-queue-song-btn').onclick = () => openAddSong(null);

document.getElementById('add-song-cancel').onclick = () => {
  document.getElementById('add-song-modal').classList.add('hidden');
};

document.getElementById('yt-url-input').oninput = debounce(async (e) => {
  const videoId = extractVideoId(e.target.value);
  const preview = document.getElementById('add-song-preview');
  if (!videoId) { preview.classList.add('hidden'); return; }
  preview.classList.remove('hidden');
  preview.innerHTML = `
    <img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg" style="width:100%;border-radius:6px;" />
    <p style="margin-top:0.5rem;font-size:0.85rem;color:var(--text-muted);">Video ID: ${videoId}</p>
  `;
}, 400);

document.getElementById('add-song-confirm').onclick = async () => {
  const url = document.getElementById('yt-url-input').value.trim();
  const videoId = extractVideoId(url);
  if (!videoId) { toast('올바른 YouTube 링크를 입력해주세요.', 'error'); return; }

  // Fetch title via oEmbed
  let title = 'Unknown Title', channelTitle = '';
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    const d = await r.json();
    title = d.title || title;
    channelTitle = d.author_name || '';
  } catch {}

  socket.emit('add-song', {
    playlistId: addSongTargetPlaylistId,
    song: { videoId, title, channelTitle }
  });
  document.getElementById('add-song-modal').classList.add('hidden');
  toast(`"${title}" 추가됨`, 'success');
};

// ── Add Playlist Modal ────────────────────────────
document.getElementById('add-playlist-btn').onclick = () => {
  document.getElementById('new-playlist-name').value = '';
  document.getElementById('add-playlist-modal').classList.remove('hidden');
  document.getElementById('new-playlist-name').focus();
};

document.getElementById('create-playlist-cancel').onclick = () => {
  document.getElementById('add-playlist-modal').classList.add('hidden');
};

document.getElementById('create-playlist-confirm').onclick = () => {
  const name = document.getElementById('new-playlist-name').value.trim();
  if (!name) { toast('이름을 입력해주세요.', 'error'); return; }
  socket.emit('create-playlist', { name });
  document.getElementById('add-playlist-modal').classList.add('hidden');
};

document.getElementById('new-playlist-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('create-playlist-confirm').click();
});

// ── Move Song Modal ───────────────────────────────
function openMoveSong(songId, fromPlaylistId) {
  moveSongData = { songId, fromPlaylistId: fromPlaylistId || null };
  const list = document.getElementById('move-target-list');
  list.innerHTML = '';

  // Option: move to queue
  if (fromPlaylistId) {
    const btn = document.createElement('button');
    btn.className = 'move-target-btn';
    btn.textContent = '📋 개별 대기열';
    btn.onclick = () => { socket.emit('move-song-to-playlist', { ...moveSongData, toPlaylistId: null }); document.getElementById('move-song-modal').classList.add('hidden'); };
    list.appendChild(btn);
  }

  // Option: move to each playlist
  (roomState?.playlists || []).forEach(pl => {
    if (pl.id === fromPlaylistId) return;
    const btn = document.createElement('button');
    btn.className = 'move-target-btn';
    btn.textContent = `🎵 ${pl.name}`;
    btn.onclick = () => { socket.emit('move-song-to-playlist', { ...moveSongData, toPlaylistId: pl.id }); document.getElementById('move-song-modal').classList.add('hidden'); };
    list.appendChild(btn);
  });

  if (list.children.length === 0) list.innerHTML = '<p style="color:var(--text-muted);">이동할 수 있는 플레이리스트가 없습니다.</p>';
  document.getElementById('move-song-modal').classList.remove('hidden');
}

document.getElementById('move-song-cancel').onclick = () => {
  document.getElementById('move-song-modal').classList.add('hidden');
};

// ── Drag & Drop for playlists ─────────────────────
function setupPlaylistDrag(section, idx) {
  const handle = section.querySelector('.playlist-drag-handle');
  handle.addEventListener('mousedown', () => { section.draggable = true; });
  section.addEventListener('dragstart', (e) => {
    dragSource = { type: 'playlist', idx };
    e.dataTransfer.effectAllowed = 'move';
  });
  section.addEventListener('dragend', () => { section.draggable = false; });
  section.addEventListener('dragover', (e) => {
    if (!dragSource || dragSource.type !== 'playlist') return;
    e.preventDefault();
    section.classList.add('drag-over');
  });
  section.addEventListener('dragleave', () => section.classList.remove('drag-over'));
  section.addEventListener('drop', (e) => {
    e.preventDefault();
    section.classList.remove('drag-over');
    if (!dragSource || dragSource.type !== 'playlist') return;
    const toIdx = parseInt(section.dataset.idx);
    if (dragSource.idx !== toIdx) socket.emit('reorder-playlists', { fromIndex: dragSource.idx, toIndex: toIdx });
    dragSource = null;
  });
}

function setupSongDrag(item, idx, playlistId, container) {
  item.addEventListener('dragstart', (e) => {
    dragSource = { type: 'song', idx, playlistId };
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  });
  item.addEventListener('dragover', (e) => {
    if (!dragSource || dragSource.type !== 'song' || dragSource.playlistId !== playlistId) return;
    e.preventDefault();
    e.stopPropagation();
    item.classList.add('drag-over');
  });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove('drag-over');
    if (!dragSource || dragSource.type !== 'song' || dragSource.playlistId !== playlistId) return;
    const toIdx = parseInt(item.dataset.idx);
    if (dragSource.idx !== toIdx) socket.emit('reorder-songs', { playlistId: playlistId || null, fromIndex: dragSource.idx, toIndex: toIdx });
    dragSource = null;
  });
}

// ── Copy buttons ──────────────────────────────────
document.getElementById('copy-code').onclick = () => {
  const code = document.getElementById('room-code').textContent;
  navigator.clipboard.writeText(code).then(() => toast('코드 복사됨!', 'success'));
};

document.getElementById('copy-link-btn').onclick = () => {
  navigator.clipboard.writeText(window.location.href).then(() => toast('링크 복사됨!', 'success'));
};

// ── Chat log ──────────────────────────────────────
function log(msg, type = 'info') {
  const el = document.getElementById('chat-log');
  const item = document.createElement('p');
  item.className = `log-item log-item--${type}`;
  item.textContent = `[${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}] ${msg}`;
  el.appendChild(item);
  el.scrollTop = el.scrollHeight;
}

// ── Toast ─────────────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300); }, 2500);
}

// ── Utils ─────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function debounce(fn, delay) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}

// Close modals on backdrop click
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
});

// Enter key for add song
document.getElementById('yt-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-song-confirm').click();
});
