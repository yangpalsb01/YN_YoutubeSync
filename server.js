const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ──────────────────────────────────────────────
// In-memory data store
// rooms[roomId] = {
//   id, name, code, hostSocketId,
//   playlists: [ { id, name, songs: [{id, title, videoId, duration}] } ],
//   queue: [songObj, ...],          // standalone queue (not in any playlist)
//   currentSong: songObj | null,
//   isPlaying: bool,
//   currentTime: number,
//   volume: number (0-100),
//   shuffle: bool,
//   repeat: 'none'|'one'|'all',
//   lastTimeUpdate: timestamp
// }
// ──────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomByCode(code) {
  return Object.values(rooms).find(r => r.code === code.toUpperCase());
}

function sanitizeRoom(room) {
  // Don't expose internal socket ids beyond what frontend needs
  return {
    id: room.id,
    name: room.name,
    code: room.code,
    playlists: room.playlists,
    queue: room.queue,
    currentSong: room.currentSong,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
    volume: room.volume,
    shuffle: room.shuffle,
    repeat: room.repeat,
  };
}

// ── REST endpoints ──────────────────────────────

// Create room
app.post('/api/rooms', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '방 이름을 입력해주세요.' });
  const id = uuidv4();
  const code = generateCode();
  rooms[id] = {
    id, name: name.trim(), code,
    hostSocketId: null,
    playlists: [],
    queue: [],
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    volume: 80,
    shuffle: false,
    repeat: 'none',
    lastTimeUpdate: Date.now(),
  };
  res.json({ id, code });
});

// List rooms
app.get('/api/rooms', (req, res) => {
  res.json(Object.values(rooms).map(r => ({ id: r.id, name: r.name, code: r.code })));
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

// ── Socket.io ──────────────────────────────────
io.on('connection', (socket) => {

  // Join room
  socket.on('join-room', ({ roomId, nickname }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', '방을 찾을 수 없습니다.');

    socket.join(roomId);
    socket.roomId = roomId;
    socket.nickname = nickname || 'Guest';

    // First to join becomes host
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
      socket.isHost = true;
    } else {
      socket.isHost = false;
    }

    socket.emit('room-state', {
      ...sanitizeRoom(room),
      isHost: socket.isHost,
    });

    io.to(roomId).emit('user-joined', { nickname: socket.nickname, isHost: socket.isHost });
  });

  // ── Host-only actions ──
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
  socket.on('play-song', ({ song }) => hostAction(room => {
    room.currentSong = song;
    room.currentTime = 0;
    room.isPlaying = true;
    room.lastTimeUpdate = Date.now();
    io.to(socket.roomId).emit('play-song', { song });
  }));

  // Next song
  socket.on('next-song', () => hostAction(room => {
    const next = getNextSong(room);
    if (next) {
      room.currentSong = next;
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastTimeUpdate = Date.now();
      io.to(socket.roomId).emit('play-song', { song: next });
    } else {
      room.isPlaying = false;
      room.currentSong = null;
      io.to(socket.roomId).emit('stop');
    }
  }));

  // Shuffle toggle
  socket.on('toggle-shuffle', () => hostAction(room => {
    room.shuffle = !room.shuffle;
    io.to(socket.roomId).emit('state-update', { shuffle: room.shuffle });
  }));

  // Repeat cycle: none -> all -> one -> none
  socket.on('toggle-repeat', () => hostAction(room => {
    const cycle = { none: 'all', all: 'one', one: 'none' };
    room.repeat = cycle[room.repeat] || 'none';
    io.to(socket.roomId).emit('state-update', { repeat: room.repeat });
  }));

  // Song ended (from host player)
  socket.on('song-ended', () => hostAction(room => {
    if (room.repeat === 'one') {
      room.currentTime = 0;
      io.to(socket.roomId).emit('play-song', { song: room.currentSong });
    } else {
      const next = getNextSong(room);
      if (next) {
        room.currentSong = next;
        room.currentTime = 0;
        room.isPlaying = true;
        room.lastTimeUpdate = Date.now();
        io.to(socket.roomId).emit('play-song', { song: next });
      } else {
        room.isPlaying = false;
        room.currentSong = null;
        io.to(socket.roomId).emit('stop');
      }
    }
  }));

  // ── Playlist management ──
  socket.on('create-playlist', ({ name }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const pl = { id: uuidv4(), name: name.trim(), songs: [] };
    room.playlists.push(pl);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
  });

  socket.on('delete-playlist', ({ playlistId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.playlists = room.playlists.filter(p => p.id !== playlistId);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
  });

  socket.on('rename-playlist', ({ playlistId, name }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const pl = room.playlists.find(p => p.id === playlistId);
    if (pl) { pl.name = name.trim(); io.to(socket.roomId).emit('playlists-update', room.playlists); }
  });

  // Add song (to playlist or standalone queue)
  socket.on('add-song', ({ playlistId, song }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    song.id = uuidv4();
    if (playlistId) {
      const pl = room.playlists.find(p => p.id === playlistId);
      if (pl) { pl.songs.push(song); io.to(socket.roomId).emit('playlists-update', room.playlists); }
    } else {
      room.queue.push(song);
      io.to(socket.roomId).emit('queue-update', room.queue);
    }
  });

  socket.on('remove-song', ({ playlistId, songId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (playlistId) {
      const pl = room.playlists.find(p => p.id === playlistId);
      if (pl) { pl.songs = pl.songs.filter(s => s.id !== songId); io.to(socket.roomId).emit('playlists-update', room.playlists); }
    } else {
      room.queue = room.queue.filter(s => s.id !== songId);
      io.to(socket.roomId).emit('queue-update', room.queue);
    }
  });

  // Reorder playlists
  socket.on('reorder-playlists', ({ fromIndex, toIndex }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const [moved] = room.playlists.splice(fromIndex, 1);
    room.playlists.splice(toIndex, 0, moved);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
  });

  // Reorder songs inside playlist
  socket.on('reorder-songs', ({ playlistId, fromIndex, toIndex }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const pl = room.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    const [moved] = pl.songs.splice(fromIndex, 1);
    pl.songs.splice(toIndex, 0, moved);
    io.to(socket.roomId).emit('playlists-update', room.playlists);
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
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    io.to(socket.roomId).emit('user-left', { nickname: socket.nickname });
    // Transfer host if needed
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      // Find another socket in the room
      const clients = io.sockets.adapter.rooms.get(socket.roomId);
      if (clients && clients.size > 0) {
        const nextId = [...clients][0];
        room.hostSocketId = nextId;
        io.to(nextId).emit('became-host');
        io.to(socket.roomId).emit('host-changed');
      }
    }
  });
});

function getNextSong(room) {
  // Collect all songs
  let allSongs = [...room.queue];
  room.playlists.forEach(pl => allSongs = allSongs.concat(pl.songs));

  if (allSongs.length === 0) return null;

  if (room.shuffle) {
    return allSongs[Math.floor(Math.random() * allSongs.length)];
  }

  if (!room.currentSong) return allSongs[0];

  const idx = allSongs.findIndex(s => s.id === room.currentSong.id);
  if (idx === -1) return allSongs[0];

  const nextIdx = idx + 1;
  if (nextIdx >= allSongs.length) {
    return room.repeat === 'all' ? allSongs[0] : null;
  }
  return allSongs[nextIdx];
}

const PORT = process.env.PORT || 4200;
server.listen(PORT, () => console.log(`🎵 Jukebox running on port ${PORT}`));
