// ─────────────────────────────────────────────────
// JukeSync — room.js  (v2)
// Changes:
//  1. Room rename (host only, click room name)
//  2. Add song → adds to list only, no auto-play
//  3. Light neutral theme support
// ─────────────────────────────────────────────────

const params   = new URLSearchParams(window.location.search);
const ROOM_ID  = params.get('id');
const NICKNAME = sessionStorage.getItem('nickname') || 'Guest';

let isHost      = false;
let roomState   = null;
let ytPlayer    = null;
let ytReady     = false;
let pendingPlay = null;
let addSongTargetPlaylistId = null; // null = standalone queue
let moveSongData = null;
let dragSource   = null;

if (!ROOM_ID) window.location.href = '/';

// ── Socket ────────────────────────────────────────
const socket = io();

socket.on('connect', () => socket.emit('join-room', { roomId: ROOM_ID, nickname: NICKNAME }));
socket.on('error', msg => toast(msg, 'error'));

socket.on('room-state', state => {
  roomState = state;
  isHost    = state.isHost;

  document.getElementById('room-name').textContent = state.name;
  document.getElementById('room-code').textContent = state.code;
  document.getElementById('my-nickname').textContent = NICKNAME;
  document.title = `${state.name} — JukeSync`;

  if (isHost) {
    document.getElementById('host-badge').style.display = '';
    document.getElementById('player-bar').style.display = 'flex';
    document.getElementById('player-bar-guest').style.display = 'none';
    document.getElementById('room-name-hint').style.display = '';
    document.getElementById('room-name').title = '클릭하여 이름 변경';
    document.getElementById('delete-room-btn').style.display = '';
    document.getElementById('sidebar').style.display = '';
    document.getElementById('chat-section').style.display = '';
  } else {
    document.getElementById('player-bar').style.display = 'none';
    document.getElementById('player-bar-guest').style.display = 'flex';
    document.getElementById('room-name').style.cursor = 'default';
    document.getElementById('room-name').title = '';
    document.getElementById('sidebar').style.display = 'none';
    document.getElementById('chat-section').style.display = 'none';
    document.getElementById('guest-main').style.display = '';
    document.querySelector('.room-layout').classList.add('guest-mode');
  }

  applyVolume(state.volume);
  document.getElementById('volume-slider').value = state.volume;
  updateShuffleBtn(state.shuffle);
  updateRepeatBtn(state.repeat);
  renderPlaylists(state.playlists);
  renderQueue(state.queue);
  if (state.currentSong) {
    updateNowPlaying(state.currentSong);
    if (state.isPlaying) playYT(state.currentSong.videoId, state.currentTime);
  }
  log(`"${state.name}" 방에 입장했습니다. 코드: ${state.code}`, 'system');
});

socket.on('room-renamed', ({ name }) => {
  if (roomState) roomState.name = name;
  document.getElementById('room-name').textContent = name;
  document.title = `${name} — JukeSync`;
  log(`방 이름이 "${name}"(으)로 변경되었습니다.`, 'system');
});

socket.on('became-host', () => {
  isHost = true;
  document.getElementById('host-badge').style.display = '';
  document.getElementById('player-bar').style.display = 'flex';
  document.getElementById('player-bar-guest').style.display = 'none';
  document.getElementById('room-name-hint').style.display = '';
  document.getElementById('room-name').title = '클릭하여 이름 변경';
  document.getElementById('delete-room-btn').style.display = '';
  document.getElementById('sidebar').style.display = '';
  document.getElementById('chat-section').style.display = '';
  log('당신이 새 호스트가 되었습니다.', 'system');
  toast('호스트 권한을 받았습니다!', 'success');
});

socket.on('user-joined', ({ nickname }) => log(`${nickname}님이 입장했습니다.`, 'system'));
socket.on('user-left',   ({ nickname }) => log(`${nickname}님이 퇴장했습니다.`, 'system'));
socket.on('host-changed', () => log('호스트가 변경되었습니다.', 'system'));

socket.on('play-song', ({ song }) => {
  updateNowPlaying(song);
  if (roomState) roomState.currentSong = song;
  playYT(song.videoId, 0);
  updatePlayBtn(true);
  document.getElementById('guest-playing-icon').textContent = '▶';
  log(`▶ "${song.title}" 재생 중`, 'play');
  highlightCurrentSong(song.id);
});

socket.on('play', ({ videoId, time }) => {
  if (ytPlayer && ytReady) {
    if (videoId) ytPlayer.loadVideoById(videoId, time || 0);
    else { ytPlayer.seekTo(time || 0, true); ytPlayer.playVideo(); }
  }
  updatePlayBtn(true);
  document.getElementById('guest-playing-icon').textContent = '▶';
});

socket.on('pause', ({ time }) => {
  if (ytPlayer && ytReady) { ytPlayer.pauseVideo(); if (time !== undefined) ytPlayer.seekTo(time, true); }
  updatePlayBtn(false);
  document.getElementById('guest-playing-icon').textContent = '⏸';
});

socket.on('seek', ({ time }) => { if (ytPlayer && ytReady) ytPlayer.seekTo(time, true); });
socket.on('volume', ({ volume }) => applyVolume(volume));

socket.on('stop', () => {
  if (ytPlayer && ytReady) ytPlayer.stopVideo();
  updatePlayBtn(false);
  updateNowPlaying(null);
  document.getElementById('guest-playing-icon').textContent = '⏸';
  highlightCurrentSong(null);
  log('재생 종료', 'system');
});

socket.on('state-update', patch => {
  if (!roomState) return;
  Object.assign(roomState, patch);
  if (patch.shuffle !== undefined) updateShuffleBtn(patch.shuffle);
  if (patch.repeat  !== undefined) updateRepeatBtn(patch.repeat);
});

socket.on('playlists-update', playlists => {
  if (roomState) roomState.playlists = playlists;
  renderPlaylists(playlists);
});

socket.on('queue-update', queue => {
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
      onStateChange: e => {
        if (e.data === YT.PlayerState.ENDED && isHost) socket.emit('song-ended');
        if (e.data === YT.PlayerState.PLAYING) updatePlayBtn(true);
        if (e.data === YT.PlayerState.PAUSED)  updatePlayBtn(false);
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

function applyVolume(vol) {
  if (ytPlayer && ytReady) ytPlayer.setVolume(vol);
  document.getElementById('vol-label').textContent = vol;
  document.getElementById('volume-slider').value = vol;
}

// ── Room name inline edit ─────────────────────────
const roomNameEl = document.getElementById('room-name');

roomNameEl.addEventListener('click', () => {
  if (!isHost) return;
  const current = roomNameEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'room-name-input';
  input.value = current;
  input.maxLength = 30;
  roomNameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    const span = document.createElement('span');
    span.id = 'room-name';
    span.className = 'room-name';
    span.title = '클릭하여 이름 변경';
    span.textContent = newName || current;
    input.replaceWith(span);
    // Re-attach click listener
    span.addEventListener('click', roomNameEl._clickHandler || (() => {}));
    // Rebind
    bindRoomNameClick(span);
    if (newName && newName !== current) socket.emit('rename-room', { name: newName });
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
});

function bindRoomNameClick(el) {
  el.addEventListener('click', function handler() {
    if (!isHost) return;
    const current = el.textContent;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'room-name-input';
    input.value = current; input.maxLength = 30;
    el.replaceWith(input);
    input.focus(); input.select();
    function commit() {
      const newName = input.value.trim();
      const span = document.createElement('span');
      span.id = 'room-name'; span.className = 'room-name';
      span.title = '클릭하여 이름 변경';
      span.textContent = newName || current;
      input.replaceWith(span);
      bindRoomNameClick(span);
      if (newName && newName !== current) socket.emit('rename-room', { name: newName });
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  });
}

// Also bind the initial element that was clicked
bindRoomNameClick(roomNameEl);

// ── Host Controls ─────────────────────────────────
document.getElementById('btn-playpause').onclick = () => {
  if (!isHost) return;
  const playing = ytPlayer && ytReady && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
  const t = ytPlayer && ytReady ? ytPlayer.getCurrentTime() : 0;
  if (playing) socket.emit('pause', { time: t });
  else socket.emit('play', { time: t });
};

document.getElementById('btn-next').onclick = () => isHost && socket.emit('next-song');
document.getElementById('btn-prev').onclick = () => {
  if (!isHost) return;
  const t = ytPlayer && ytReady ? ytPlayer.getCurrentTime() : 0;
  if (t > 5) socket.emit('seek', { time: 0 });
  else socket.emit('next-song');
};

document.getElementById('btn-shuffle').onclick = () => isHost && socket.emit('toggle-shuffle');
document.getElementById('btn-repeat').onclick  = () => isHost && socket.emit('toggle-repeat');

document.getElementById('volume-slider').oninput = e => {
  if (!isHost) return;
  socket.emit('volume', { volume: parseInt(e.target.value) });
  applyVolume(parseInt(e.target.value));
};

function updatePlayBtn(playing) {
  document.getElementById('btn-playpause').textContent = playing ? '⏸' : '▶';
}
function updateShuffleBtn(on) {
  document.getElementById('btn-shuffle').classList.toggle('active', on);
  document.getElementById('btn-shuffle').title = on ? '셔플 켜짐' : '셔플';
}
function updateRepeatBtn(mode) {
  const btn = document.getElementById('btn-repeat');
  btn.classList.toggle('active', mode !== 'none');
  btn.textContent = mode === 'one' ? '↻¹' : '↻';
  btn.title = { none: '반복 없음', all: '전체 반복', one: '한 곡 반복' }[mode];
}

function updateNowPlaying(song) {
  const setEls = (titleId, subId, artId) => {
    document.getElementById(titleId).textContent = song ? song.title : '재생 중인 곡 없음';
    document.getElementById(subId).textContent   = song ? (song.channelTitle || '—') : '—';
    document.getElementById(artId).innerHTML     = song
      ? `<img src="https://img.youtube.com/vi/${song.videoId}/default.jpg" alt="" />`
      : '♪';
  };
  setEls('now-playing-title', 'now-playing-sub', 'now-playing-art');
  setEls('guest-title', 'guest-sub', 'guest-art');

  // Update guest big card
  const bigTitle = document.getElementById('guest-big-title');
  const bigCh    = document.getElementById('guest-big-ch');
  const bigArt   = document.getElementById('guest-big-art');
  const anim     = document.getElementById('guest-anim');
  if (bigTitle) bigTitle.textContent = song ? song.title : '재생 중인 곡 없음';
  if (bigCh)    bigCh.textContent    = song ? (song.channelTitle || '—') : '—';
  if (bigArt)   bigArt.innerHTML     = song
    ? `<img src="https://img.youtube.com/vi/${song.videoId}/hqdefault.jpg" alt="" />`
    : '♪';
  if (anim) anim.style.display = song ? '' : 'none';
}

function highlightCurrentSong(songId) {
  document.querySelectorAll('.song-item').forEach(el => {
    el.classList.toggle('playing-now', !!songId && el.dataset.id === songId);
  });
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
      <div class="playlist-header">
        <div class="playlist-drag-handle" title="드래그해서 순서 변경">⠿</div>
        <span class="playlist-name">${esc(pl.name)}</span>
        <div class="playlist-actions">
          <button class="btn btn--icon js-add-song" title="곡 추가">＋</button>
          ${isHost ? '<button class="btn btn--icon btn--play-pl js-play-pl" title="첫 곡 재생">▶</button>' : ''}
          <button class="btn btn--icon btn--del js-del-pl" title="삭제">✕</button>
        </div>
      </div>
      <div class="song-list" id="songs-${pl.id}"></div>
    `;
    // Attach event listeners (safe - no JSON in HTML)
    section.querySelector('.js-add-song').addEventListener('click', () => openAddSong(pl.id));
    if (isHost) section.querySelector('.js-play-pl').addEventListener('click', () => playPlaylist(pl.id));
    section.querySelector('.js-del-pl').addEventListener('click', () => deletePlaylist(pl.id));

    el.appendChild(section);
    renderSongs(pl.songs, pl.id, `songs-${pl.id}`);
    setupPlaylistDrag(section, plIdx);
  });

  const cur = roomState?.currentSong?.id;
  if (cur) highlightCurrentSong(cur);
}

function renderSongs(songs, playlistId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (songs.length === 0) {
    el.innerHTML = '<p class="empty-hint" style="padding:0.4rem 0.8rem;font-size:0.77rem;">곡이 없습니다.</p>';
    return;
  }
  songs.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'song-item';
    item.dataset.id  = song.id;
    item.dataset.idx = idx;
    item.draggable   = true;

    item.innerHTML = `
      <div class="song-drag-handle">⠿</div>
      <img class="song-thumb" src="https://img.youtube.com/vi/${song.videoId}/default.jpg" alt="" loading="lazy" />
      <div class="song-info">
        <p class="song-title">${esc(song.title)}</p>
        <p class="song-ch">${esc(song.channelTitle || '')}</p>
      </div>
      <div class="song-actions">
        ${isHost ? `<button class="btn btn--icon btn--play-song js-play-song" title="재생">▶</button>` : ''}
        <button class="btn btn--icon js-move-song" title="이동">⇄</button>
        <button class="btn btn--icon btn--del js-remove-song" title="삭제">✕</button>
      </div>
    `;

    // ★ Use event listeners with closure — no JSON in HTML attributes
    if (isHost) {
      item.querySelector('.js-play-song').addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('play-song', { song });
      });
    }
    item.querySelector('.js-move-song').addEventListener('click', (e) => {
      e.stopPropagation();
      openMoveSong(song.id, playlistId || '');
    });
    item.querySelector('.js-remove-song').addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('remove-song', { playlistId: playlistId || null, songId: song.id });
    });

    setupSongDrag(item, idx, playlistId);
    el.appendChild(item);
  });
}

function renderQueue(queue) {
  renderSongs(queue, null, 'queue-list');
  const cur = roomState?.currentSong?.id;
  if (cur) highlightCurrentSong(cur);
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
  const pl = addSongTargetPlaylistId && roomState?.playlists.find(p => p.id === addSongTargetPlaylistId);
  document.getElementById('add-song-modal-title').textContent = pl ? `곡 추가 — ${pl.name}` : '곡 추가 — 개별 대기열';
  document.getElementById('yt-url-input').value = '';
  document.getElementById('custom-title-input').value = '';
  document.getElementById('song-title-wrap').classList.add('hidden');
  document.getElementById('add-song-preview').classList.add('hidden');
  document.getElementById('add-song-modal').classList.remove('hidden');
  document.getElementById('yt-url-input').focus();
}

document.getElementById('add-queue-song-btn').onclick = () => openAddSong(null);
document.getElementById('add-song-cancel').onclick = () => document.getElementById('add-song-modal').classList.add('hidden');

document.getElementById('yt-url-input').oninput = debounce(async e => {
  const videoId = extractVideoId(e.target.value);
  const preview = document.getElementById('add-song-preview');
  const titleWrap = document.getElementById('song-title-wrap');
  const customInput = document.getElementById('custom-title-input');
  if (!videoId) {
    preview.classList.add('hidden');
    titleWrap.classList.add('hidden');
    customInput.value = '';
    return;
  }
  preview.classList.remove('hidden');
  preview.innerHTML = `<img src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg" style="width:100%;display:block;" />`;
  // Fetch YouTube title as default
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    const d = await r.json();
    customInput.placeholder = d.title || '곡 이름을 직접 입력하세요...';
    customInput._ytTitle = d.title || '';
    customInput._ytChannel = d.author_name || '';
  } catch {
    customInput.placeholder = '곡 이름을 직접 입력하세요...';
    customInput._ytTitle = '';
    customInput._ytChannel = '';
  }
  titleWrap.classList.remove('hidden');
}, 400);

document.getElementById('add-song-confirm').onclick = async () => {
  const url = document.getElementById('yt-url-input').value.trim();
  const videoId = extractVideoId(url);
  if (!videoId) { toast('올바른 YouTube 링크를 입력해주세요.', 'error'); return; }

  const customInput = document.getElementById('custom-title-input');
  const customTitle = customInput.value.trim();
  // Use custom title if entered; otherwise use the fetched YouTube title
  const title = customTitle || customInput._ytTitle || '(제목 없음)';
  const channelTitle = customInput._ytChannel || '';

  socket.emit('add-song', { playlistId: addSongTargetPlaylistId, song: { videoId, title, channelTitle } });
  document.getElementById('add-song-modal').classList.add('hidden');
  toast(`"${title}" 추가됨`, 'success');
};

// ── Add Playlist Modal ────────────────────────────
document.getElementById('add-playlist-btn').onclick = () => {
  document.getElementById('new-playlist-name').value = '';
  document.getElementById('add-playlist-modal').classList.remove('hidden');
  document.getElementById('new-playlist-name').focus();
};
document.getElementById('create-playlist-cancel').onclick = () => document.getElementById('add-playlist-modal').classList.add('hidden');
document.getElementById('create-playlist-confirm').onclick = () => {
  const name = document.getElementById('new-playlist-name').value.trim();
  if (!name) { toast('이름을 입력해주세요.', 'error'); return; }
  socket.emit('create-playlist', { name });
  document.getElementById('add-playlist-modal').classList.add('hidden');
};
document.getElementById('new-playlist-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('create-playlist-confirm').click(); });

// ── Move Song Modal ───────────────────────────────
function openMoveSong(songId, fromPlaylistId) {
  moveSongData = { songId, fromPlaylistId: fromPlaylistId || null };
  const list = document.getElementById('move-target-list');
  list.innerHTML = '';

  if (fromPlaylistId) {
    const btn = document.createElement('button');
    btn.className = 'move-target-btn';
    btn.textContent = '📋 개별 대기열';
    btn.onclick = () => { socket.emit('move-song-to-playlist', { ...moveSongData, toPlaylistId: null }); document.getElementById('move-song-modal').classList.add('hidden'); };
    list.appendChild(btn);
  }

  (roomState?.playlists || []).forEach(pl => {
    if (pl.id === fromPlaylistId) return;
    const btn = document.createElement('button');
    btn.className = 'move-target-btn';
    btn.textContent = `🎵 ${pl.name}`;
    btn.onclick = () => { socket.emit('move-song-to-playlist', { ...moveSongData, toPlaylistId: pl.id }); document.getElementById('move-song-modal').classList.add('hidden'); };
    list.appendChild(btn);
  });

  if (list.children.length === 0) list.innerHTML = '<p style="color:var(--text-muted);font-size:0.87rem;">이동할 수 있는 위치가 없습니다.</p>';
  document.getElementById('move-song-modal').classList.remove('hidden');
}

document.getElementById('move-song-cancel').onclick = () => document.getElementById('move-song-modal').classList.add('hidden');

// ── Drag & Drop ───────────────────────────────────
function setupPlaylistDrag(section, idx) {
  const handle = section.querySelector('.playlist-drag-handle');
  handle.addEventListener('mousedown', () => { section.draggable = true; });
  section.addEventListener('dragstart', e => { dragSource = { type: 'playlist', idx }; e.dataTransfer.effectAllowed = 'move'; });
  section.addEventListener('dragend', () => { section.draggable = false; document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); });
  section.addEventListener('dragover', e => { if (!dragSource || dragSource.type !== 'playlist') return; e.preventDefault(); section.classList.add('drag-over'); });
  section.addEventListener('dragleave', () => section.classList.remove('drag-over'));
  section.addEventListener('drop', e => {
    e.preventDefault(); section.classList.remove('drag-over');
    if (!dragSource || dragSource.type !== 'playlist') return;
    const toIdx = parseInt(section.dataset.idx);
    if (dragSource.idx !== toIdx) socket.emit('reorder-playlists', { fromIndex: dragSource.idx, toIndex: toIdx });
    dragSource = null;
  });
}

function setupSongDrag(item, idx, playlistId) {
  item.addEventListener('dragstart', e => { dragSource = { type: 'song', idx, playlistId }; e.dataTransfer.effectAllowed = 'move'; e.stopPropagation(); });
  item.addEventListener('dragover', e => { if (!dragSource || dragSource.type !== 'song' || dragSource.playlistId !== playlistId) return; e.preventDefault(); e.stopPropagation(); item.classList.add('drag-over'); });
  item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
  item.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); item.classList.remove('drag-over');
    if (!dragSource || dragSource.type !== 'song' || dragSource.playlistId !== playlistId) return;
    const toIdx = parseInt(item.dataset.idx);
    if (dragSource.idx !== toIdx) socket.emit('reorder-songs', { playlistId: playlistId || null, fromIndex: dragSource.idx, toIndex: toIdx });
    dragSource = null;
  });
}

// ── Copy buttons & Room controls ──────────────────
document.getElementById('copy-code').onclick = () => navigator.clipboard.writeText(document.getElementById('room-code').textContent).then(() => toast('코드 복사됨!', 'success'));
document.getElementById('copy-link-btn').onclick = () => navigator.clipboard.writeText(window.location.href).then(() => toast('링크 복사됨!', 'success'));

document.getElementById('delete-room-btn').onclick = () => {
  if (!isHost) return;
  if (!confirm('방을 삭제하면 모든 참가자가 퇴장됩니다. 계속할까요?')) return;
  socket.emit('delete-room');
};

socket.on('room-deleted', () => {
  alert('방이 삭제되었습니다.');
  window.location.href = '/';
});

// ── Activity log ──────────────────────────────────
function log(msg, type = 'system') {
  const el = document.getElementById('chat-log');
  const item = document.createElement('p');
  item.className = `log-item log-item--${type}`;
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  item.textContent = `[${time}] ${msg}`;
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
  setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 250); }, 2500);
}

// ── Utilities ─────────────────────────────────────
function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function debounce(fn, delay) {
  let t;
  return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); };
}

// Close modals on backdrop click
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));

// Enter key shortcuts
document.getElementById('yt-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('add-song-confirm').click(); });
