const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const { MongoClient } = require('mongodb');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ──────────────────────────────────────────────
// MongoDB 연결
// MONGODB_URI 환경변수에서 읽음 (Render.com 환경변수로 설정)
// ──────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

let db;
let roomsCol;        // rooms collection
let sharedPlCol;     // shared playlist codes collection

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('jukesync');
  roomsCol    = db.collection('rooms');
  sharedPlCol = db.collection('shared_playlists');
  // 만료 인덱스: createdAt 필드 기준 24시간 후 자동 삭제
  await sharedPlCol.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
  console.log('✅ MongoDB 연결 성공');
}

// ──────────────────────────────────────────────
// 인메모리 캐시 (소켓 이벤트용 빠른 접근)
// DB에서 로드 후 여기에 보관, 변경 시 DB에도 반영
// ──────────────────────────────────────────────
const rooms = {};

async function loadRoomsFromDB() {
  const docs = await roomsCol.find({}).toArray();
  docs.forEach(doc => {
    // _id 제거하고 캐시에 저장
    const { _id, ...room } = doc;
    rooms[room.id] = room;
  });
  console.log(`💾 ${docs.length}개 방 로드됨`);
}

// DB 저장 (단일 방)
async function saveRoom(room) {
  try {
    await roomsCol.replaceOne({ id: room.id }, room, { upsert: true });
  } catch (e) {
    console.error('DB 저장 실패:', e.message);
  }
}

// DB 삭제 (단일 방)
async function deleteRoom(roomId) {
  try {
    await roomsCol.deleteOne({ id: roomId });
  } catch (e) {
    console.error('DB 삭제 실패:', e.message);
  }
}

// 디바운스 저장 — 자주 바뀌는 playlist/queue 변경에 사용
const saveTimers = {};
function saveRoomDebounced(room) {
  clearTimeout(saveTimers[room.id]);
  saveTimers[room.id] = setTimeout(() => saveRoom(room), 500);
}

// ──────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomByCode(code) {
  return Object.values(rooms).find(r => r.code === code.toUpperCase());
}

function sanitizeRoom(room) {
  return {
    id:          room.id,
    name:        room.name,
    code:        room.code,
    playlists:   room.playlists,
    queue:       room.queue,
    currentSong: room.currentSong,
    isPlaying:   room.isPlaying,
    currentTime: room.currentTime,
    volume:      room.volume,
    shuffle:     room.shuffle,
    repeat:      room.repeat,
    playMode:    room.playMode,
  };
}

// ── REST endpoints ──────────────────────────────

// Create room
app.post('/api/rooms', async (req, res) => {
  const { name, hostNickname } = req.body;
  if (!name || !name.trim())             return res.status(400).json({ error: '방 이름을 입력해주세요.' });
  if (!hostNickname || !hostNickname.trim()) return res.status(400).json({ error: '닉네임을 입력해주세요.' });
  const id   = uuidv4();
  const code = generateCode();
  const room = {
    id, name: name.trim(), code,
    hostNickname:  hostNickname.trim(),
    hostSocketId:  null,
    hostLastSeen:  Date.now(),
    playlists:     [],
    queue:         [],
    currentSong:   null,
    isPlaying:     false,
    currentTime:   0,
    volume:        80,
    shuffle:       false,
    repeat:        'none',
    playMode:      'single',
    lastTimeUpdate: Date.now(),
  };
  rooms[id] = room;
  await saveRoom(room);
  res.json({ id, code });
});

// List rooms
app.get('/api/rooms', (req, res) => {
  // 1. 방 정보를 배열로 변환
  const roomList = Object.values(rooms).map(r => ({ id: r.id, name: r.name, code: r.code }));

  // 2. 가나다 -> ABC -> 123 순으로 정렬 로직 추가
  roomList.sort((a, b) => {
    return a.name.localeCompare(b.name, 'ko-KR', { numeric: true, sensitivity: 'base' });
  });

  res.json(roomList);
});

// Admin: 방 목록 + hostNickname + hostLastSeen
app.get('/api/admin/rooms', (req, res) => {
  if (req.headers['x-admin-password'] !== '7224') return res.status(401).json({ error: '인증 실패' });
  const roomList = Object.values(rooms).map(r => ({
    id: r.id, name: r.name, code: r.code,
    hostNickname: r.hostNickname,
    hostLastSeen: r.hostLastSeen || null,
  }));
  roomList.sort((a, b) => a.name.localeCompare(b.name, 'ko-KR', { numeric: true, sensitivity: 'base' }));
  res.json(roomList);
});

// Admin: 호스트 닉네임 변경
app.patch('/api/admin/rooms/:id/host', (req, res) => {
  if (req.headers['x-admin-password'] !== '7224') return res.status(401).json({ error: '인증 실패' });
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
  const { hostNickname } = req.body;
  if (!hostNickname || !hostNickname.trim()) return res.status(400).json({ error: '닉네임을 입력해주세요.' });
  room.hostNickname = hostNickname.trim();
  saveRoomDebounced(room);
  res.json({ ok: true });
});

// Admin: 방 이름 변경
app.patch('/api/admin/rooms/:id/name', (req, res) => {
  if (req.headers['x-admin-password'] !== '7224') return res.status(401).json({ error: '인증 실패' });
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '방 이름을 입력해주세요.' });
  room.name = name.trim();
  io.to(room.id).emit('room-renamed', { name: room.name });
  saveRoomDebounced(room);
  res.json({ ok: true });
});

// Get room
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
  res.json(sanitizeRoom(room));
});

// Join by code
app.get('/api/rooms/code/:code', (req, res) => {
  const room = getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: '코드를 확인해주세요.' });
  res.json({ id: room.id });
});

// ── Playlist share API ─────────────────────────

// 플레이리스트 내보내기: 코드 생성
app.post('/api/share/playlist', async (req, res) => {
  const { playlist } = req.body;
  if (!playlist || !playlist.name || !Array.isArray(playlist.songs)) {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }
  if (playlist.songs.length > 500) {
    return res.status(400).json({ error: '곡이 너무 많습니다. (최대 500곡)' });
  }
  // 각 곡 필드 간단 검증
  for (const s of playlist.songs) {
    if (!s.videoId || typeof s.videoId !== 'string' || s.videoId.length > 20) {
      return res.status(400).json({ error: '잘못된 곡 데이터가 포함되어 있습니다.' });
    }
  }
  // 6자리 대문자 코드 생성 (충돌 방지 재시도)
  let code, exists = true;
  while (exists) {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
    exists = await sharedPlCol.findOne({ code });
  }
  await sharedPlCol.insertOne({
    code,
    playlist: { name: playlist.name, songs: playlist.songs },
    createdAt: new Date(),
  });
  res.json({ code });
});

// 플레이리스트 불러오기: 코드로 조회
app.get('/api/share/playlist/:code', async (req, res) => {
  const doc = await sharedPlCol.findOne({ code: req.params.code.toUpperCase() });
  if (!doc) return res.status(404).json({ error: '코드를 찾을 수 없거나 만료되었습니다.' });
  res.json({ playlist: doc.playlist });
});

// Admin force-delete
const ADMIN_PASSWORD = '7224';
app.delete('/api/rooms/:id/force', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: '비밀번호가 틀렸습니다.' });
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
  io.to(req.params.id).emit('room-deleted');
  delete rooms[req.params.id];
  await deleteRoom(req.params.id);
  res.json({ ok: true });
});

// ── Socket.io ──────────────────────────────────
io.on('connection', (socket) => {

  // Join room
  socket.on('join-room', ({ roomId, nickname }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', '방을 찾을 수 없습니다.');

    socket.join(roomId);
    socket.roomId  = roomId;
    socket.nickname = nickname || 'Guest';

    // 닉네임이 호스트 닉네임과 일치하면 호스트 권한 부여
    if (nickname && nickname.trim() === room.hostNickname) {
      room.hostSocketId = socket.id;
      room.hostLastSeen = Date.now();
      socket.isHost = true;
      saveRoomDebounced(room);
    } else {
      socket.isHost = false;
    }

    socket.emit('room-state', { ...sanitizeRoom(room), isHost: socket.isHost });
    io.to(roomId).emit('user-joined', { nickname: socket.nickname, isHost: socket.isHost });
  });

  // ── 호스트 전용 액션 래퍼 ──
  function hostAction(cb) {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (socket.id !== room.hostSocketId) {
      return socket.emit('error', '호스트만 제어할 수 있습니다.');
    }
    cb(room);
  }

  // Play
  socket.on('play', ({ videoId, time }) => hostAction(room => {
    room.isPlaying = true;
    if (time !== undefined) room.currentTime = time;
    room.lastTimeUpdate = Date.now();
    io.to(socket.roomId).emit('play', { videoId: videoId || room.currentSong?.videoId, time: room.currentTime });
  }));

  // Pause
  socket.on('pause', ({ time }) => hostAction(room => {
    room.isPlaying = false;
    if (time !== undefined) room.currentTime = time;
    io.to(socket.roomId).emit('pause', { time: room.currentTime });
  }));

  // Seek
  socket.on('seek', ({ time }) => hostAction(room => {
    room.currentTime = time;
    room.lastTimeUpdate = Date.now();
    io.to(socket.roomId).emit('seek', { time });
  }));

  // Volume
  socket.on('volume', ({ volume }) => hostAction(room => {
    room.volume = volume;
    io.to(socket.roomId).emit('volume', { volume });
  }));

  // Play specific song
  socket.on('play-song', ({ song, playMode }) => hostAction(room => {
    room.currentSong   = song;
    room.currentTime   = 0;
    room.isPlaying     = true;
    room.lastTimeUpdate = Date.now();
    room.playMode      = playMode || 'single'; // 'single' | 'playlist'
    io.to(socket.roomId).emit('play-song', { song });
    saveRoomDebounced(room);
  }));

  // Prev song
  socket.on('prev-song', () => hostAction(room => {
    const prev = getPrevSong(room);
    if (prev) {
      room.currentSong   = prev;
      room.currentTime   = 0;
      room.isPlaying     = true;
      room.lastTimeUpdate = Date.now();
      io.to(socket.roomId).emit('play-song', { song: prev });
    } else {
      room.isPlaying   = false;
      room.currentSong = null;
      io.to(socket.roomId).emit('stop');
    }
    saveRoomDebounced(room);
  }));

  // Next song
  socket.on('next-song', () => hostAction(room => {
    const next = getNextSong(room);
    if (next) {
      room.currentSong   = next;
      room.currentTime   = 0;
      room.isPlaying     = true;
      room.lastTimeUpdate = Date.now();
      io.to(socket.roomId).emit('play-song', { song: next });
    } else {
      room.isPlaying   = false;
      room.currentSong = null;
      io.to(socket.roomId).emit('stop');
    }
    saveRoomDebounced(room);
  }));

  // Shuffle toggle
  socket.on('toggle-shuffle', () => hostAction(room => {
    room.shuffle = !room.shuffle;
    io.to(socket.roomId).emit('state-update', { shuffle: room.shuffle });
    saveRoomDebounced(room);
  }));

  // Repeat cycle: none -> all -> one -> none
  socket.on('toggle-repeat', () => hostAction(room => {
    const cycle = { none: 'all', all: 'one', one: 'none' };
    room.repeat = cycle[room.repeat] || 'none';
    io.to(socket.roomId).emit('state-update', { repeat: room.repeat });
    saveRoomDebounced(room);
  }));

  // Song ended
  socket.on('song-ended', () => hostAction(room => {
    // 우선순위 1: 곡 단위 loop 플래그
    if (room.currentSong?.loop) {
      room.currentTime = 0;
      io.to(socket.roomId).emit('play-song', { song: room.currentSong });

    // 우선순위 2: 한곡반복(repeat=one)
    } else if (room.repeat === 'one') {
      room.currentTime = 0;
      io.to(socket.roomId).emit('play-song', { song: room.currentSong });

    // 우선순위 3: 단곡 재생 모드(playMode=single)
    } else if (room.playMode === 'single') {
      if (room.repeat === 'all') {
        // 전체반복 ON → 그 한 곡을 무한 반복 (대기열에 그 곡만 있는 것과 동일하게 취급)
        room.currentTime = 0;
        io.to(socket.roomId).emit('play-song', { song: room.currentSong });
      } else {
        // 반복 OFF → 정지
        room.isPlaying   = false;
        room.currentSong = null;
        io.to(socket.roomId).emit('stop');
      }

    // 우선순위 4: 플레이리스트 재생 모드(playMode=playlist)
    } else {
      const next = getNextSong(room);
      if (next) {
        room.currentSong   = next;
        room.currentTime   = 0;
        room.isPlaying     = true;
        room.lastTimeUpdate = Date.now();
        io.to(socket.roomId).emit('play-song', { song: next });
      } else {
        room.isPlaying   = false;
        room.currentSong = null;
        io.to(socket.roomId).emit('stop');
      }
    }
    saveRoomDebounced(room);
  }));

  // ── Playlist management ──

  socket.on('create-playlist', ({ name }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const pl = { id: uuidv4(), name: name.trim(), songs: [] };
    room.playlists.push(pl);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
    saveRoomDebounced(room);
  });

  socket.on('delete-playlist', ({ playlistId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.playlists = room.playlists.filter(p => p.id !== playlistId);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
    saveRoomDebounced(room);
  });

  socket.on('rename-playlist', ({ playlistId, name }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const pl = room.playlists.find(p => p.id === playlistId);
    if (pl) {
      pl.name = name.trim();
      io.to(socket.roomId).emit('playlists-update', room.playlists);
      saveRoomDebounced(room);
    }
  });

  // Rename room (host only)
  socket.on('rename-room', ({ name }) => hostAction(room => {
    if (!name || !name.trim()) return;
    room.name = name.trim();
    io.to(socket.roomId).emit('room-renamed', { name: room.name });
    saveRoomDebounced(room);
  }));

  // Delete room (host only)
  socket.on('delete-room', () => hostAction(async room => {
    const roomId = socket.roomId;
    io.to(roomId).emit('room-deleted');
    const clients = io.sockets.adapter.rooms.get(roomId);
    if (clients) {
      [...clients].forEach(clientId => {
        const s = io.sockets.sockets.get(clientId);
        if (s) s.leave(roomId);
      });
    }
    delete rooms[roomId];
    await deleteRoom(roomId);
  }));

  // Toggle song loop (곡별 반복 설정)
  socket.on('toggle-song-loop', ({ playlistId, songId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    let song;
    if (playlistId) {
      const pl = room.playlists.find(p => p.id === playlistId);
      if (pl) song = pl.songs.find(s => s.id === songId);
    } else {
      song = room.queue.find(s => s.id === songId);
    }
    if (!song) return;
    song.loop = !song.loop;
    if (playlistId) {
      io.to(socket.roomId).emit('playlists-update', room.playlists);
    } else {
      io.to(socket.roomId).emit('queue-update', room.queue);
    }
    saveRoomDebounced(room);
  });

  // Add song
  socket.on('add-song', ({ playlistId, song }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    song.id = uuidv4();
    if (playlistId) {
      const pl = room.playlists.find(p => p.id === playlistId);
      if (pl) {
        pl.songs.push(song);
        io.to(socket.roomId).emit('playlists-update', room.playlists);
      }
    } else {
      room.queue.push(song);
      io.to(socket.roomId).emit('queue-update', room.queue);
    }
    saveRoomDebounced(room);
  });

  socket.on('remove-song', ({ playlistId, songId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (playlistId) {
      const pl = room.playlists.find(p => p.id === playlistId);
      if (pl) {
        pl.songs = pl.songs.filter(s => s.id !== songId);
        io.to(socket.roomId).emit('playlists-update', room.playlists);
      }
    } else {
      room.queue = room.queue.filter(s => s.id !== songId);
      io.to(socket.roomId).emit('queue-update', room.queue);
    }
    saveRoomDebounced(room);
  });

  // Reorder playlists
  socket.on('reorder-playlists', ({ fromIndex, toIndex }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const [moved] = room.playlists.splice(fromIndex, 1);
    room.playlists.splice(toIndex, 0, moved);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
    saveRoomDebounced(room);
  });

  // Reorder songs inside playlist OR queue
  socket.on('reorder-songs', ({ playlistId, fromIndex, toIndex }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (playlistId) {
      const pl = room.playlists.find(p => p.id === playlistId);
      if (!pl) return;
      const [moved] = pl.songs.splice(fromIndex, 1);
      pl.songs.splice(toIndex, 0, moved);
      io.to(socket.roomId).emit('playlists-update', room.playlists);
    } else {
      const [moved] = room.queue.splice(fromIndex, 1);
      room.queue.splice(toIndex, 0, moved);
      io.to(socket.roomId).emit('queue-update', room.queue);
    }
    saveRoomDebounced(room);
  });

  // Move song to playlist
  socket.on('move-song-to-playlist', ({ songId, fromPlaylistId, toPlaylistId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    let song;
    if (fromPlaylistId) {
      const pl = room.playlists.find(p => p.id === fromPlaylistId);
      if (pl) { song = pl.songs.find(s => s.id === songId); pl.songs = pl.songs.filter(s => s.id !== songId); }
    } else {
      song = room.queue.find(s => s.id === songId);
      room.queue = room.queue.filter(s => s.id !== songId);
    }
    if (!song) return;
    if (toPlaylistId) {
      const pl = room.playlists.find(p => p.id === toPlaylistId);
      if (pl) pl.songs.push(song);
    } else {
      room.queue.push(song);
    }
    io.to(socket.roomId).emit('playlists-update', room.playlists);
    io.to(socket.roomId).emit('queue-update', room.queue);
    saveRoomDebounced(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    io.to(socket.roomId).emit('user-left', { nickname: socket.nickname });
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
    }
  });
});

// ── 이전 곡 결정 ──────────────────────────────
function getPrevSong(room) {
  let context = null;

  if (room.currentSong) {
    if (room.queue.some(s => s.id === room.currentSong.id)) {
      context = { songs: room.queue };
    }
    if (!context) {
      for (const pl of room.playlists) {
        if (pl.songs.some(s => s.id === room.currentSong.id)) {
          context = { songs: pl.songs };
          break;
        }
      }
    }
  }

  if (!context) {
    if (room.queue.length > 0) context = { songs: room.queue };
    else {
      const first = room.playlists.find(pl => pl.songs.length > 0);
      if (first) context = { songs: first.songs };
    }
  }

  if (!context || context.songs.length === 0) return null;

  const songs = context.songs;

  if (room.shuffle) {
    if (songs.length === 1) return songs[0];
    const candidates = room.currentSong
      ? songs.filter(s => s.id !== room.currentSong.id)
      : songs;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  if (!room.currentSong) return songs[songs.length - 1];
  const idx = songs.findIndex(s => s.id === room.currentSong.id);
  if (idx === -1) return songs[0];
  const prevIdx = idx - 1;
  if (prevIdx < 0) return room.repeat === 'all' ? songs[songs.length - 1] : null;
  return songs[prevIdx];
}

// ── 다음 곡 결정 ──────────────────────────────
function getNextSong(room) {
  // 현재 곡이 어느 컨텍스트(플레이리스트 or 큐)에 속하는지 파악
  let context = null;

  if (room.currentSong) {
    if (room.queue.some(s => s.id === room.currentSong.id)) {
      context = { songs: room.queue };
    }
    if (!context) {
      for (const pl of room.playlists) {
        if (pl.songs.some(s => s.id === room.currentSong.id)) {
          context = { songs: pl.songs };
          break;
        }
      }
    }
  }

  // fallback
  if (!context) {
    if (room.queue.length > 0) context = { songs: room.queue };
    else {
      const first = room.playlists.find(pl => pl.songs.length > 0);
      if (first) context = { songs: first.songs };
    }
  }

  if (!context || context.songs.length === 0) return null;

  const songs = context.songs;

  if (room.shuffle) {
    if (songs.length === 1) return songs[0];
    const candidates = room.currentSong
      ? songs.filter(s => s.id !== room.currentSong.id)
      : songs;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  if (!room.currentSong) return songs[0];
  const idx = songs.findIndex(s => s.id === room.currentSong.id);
  if (idx === -1) return songs[0];
  const nextIdx = idx + 1;
  if (nextIdx >= songs.length) return room.repeat === 'all' ? songs[0] : null;
  return songs[nextIdx];
}

// ── 서버 시작 ──────────────────────────────────
const PORT = process.env.PORT || 4200;

connectDB()
  .then(() => loadRoomsFromDB())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🎵 JukeSync running on port ${PORT}`);

      // Render.com 무료 플랜 슬립 방지: 14분마다 자기 자신에게 ping
      const SELF_URL = process.env.RENDER_EXTERNAL_URL;
      if (SELF_URL) {
        setInterval(async () => {
          try {
            const https = require('https');
            https.get(SELF_URL, res => {
              console.log(`🏓 Self-ping OK (${res.statusCode})`);
            }).on('error', e => {
              console.warn('Self-ping 실패:', e.message);
            });
          } catch (e) {
            console.warn('Self-ping 오류:', e.message);
          }
        }, 14 * 60 * 1000); // 14분
      }
    });
  })
  .catch(err => {
    console.error('서버 시작 실패:', err);
    process.exit(1);
  });
