const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configure multer for file uploads
const upload = multer({ 
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Store room data
const rooms = new Map();
const roomVideoStates = new Map();
const roomUsers = new Map();

// Initialize room data
function initializeRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: new Date(),
      users: new Map()
    });
  }
  
  if (!roomVideoStates.has(roomId)) {
    roomVideoStates.set(roomId, {
      type: null, 
      videoId: null,
      videoUrl: null,
      currentTime: 0,
      isPlaying: false,
      lastUpdated: null,
      lastUpdatedBy: null
    });
  }
  
  if (!roomUsers.has(roomId)) {
    roomUsers.set(roomId, new Map());
  }
}

// File upload endpoint
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    path: `/uploads/${req.file.filename}`
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle room joining
  socket.on('join-room', (data) => {
    const { user, roomId } = data;
    
    if (!user || !roomId) {
      socket.emit('error', { message: 'Invalid join data' });
      return;
    }

    initializeRoom(roomId);
    
    user.socketId = socket.id;
    roomUsers.get(roomId).set(socket.id, user);
    
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.user = user;
    
    const currentVideoState = roomVideoStates.get(roomId);
    const usersInRoom = Array.from(roomUsers.get(roomId).values());
    
    socket.emit('room-joined', {
      roomId,
      userCount: usersInRoom.length,
      currentVideoState: currentVideoState,
      users: usersInRoom
    });
    
    socket.to(roomId).emit('user-joined', {
      user,
      userCount: usersInRoom.length,
      users: usersInRoom
    });
    
    console.log(`User ${user.name} joined room ${roomId}`);
  });

  // Handle video loading (YouTube or uploaded)
  socket.on('video-load', (data) => {
    const { roomId, type, videoId, videoUrl, userId } = data;
    
    if (!roomId || !userId || !type) {
      socket.emit('error', { message: 'Invalid video load data' });
      return;
    }
    
    initializeRoom(roomId);
    
    const currentState = roomVideoStates.get(roomId);
    
    currentState.type = type;
    currentState.videoId = videoId;
    currentState.videoUrl = videoUrl;
    currentState.currentTime = 0;
    currentState.isPlaying = false;
    currentState.lastUpdated = Date.now();
    currentState.lastUpdatedBy = userId;
    
    io.to(roomId).emit('video-load', {
      type,
      videoId,
      videoUrl,
      userId,
      timestamp: Date.now()
    });
    
    console.log(`Video loaded in room ${roomId}: ${type} - ${videoId || videoUrl} by ${userId}`);
  });

  // Handle video actions
  socket.on('video-action', (data) => {
    const { roomId, action, time, userId } = data;
    
    if (!roomId || !userId) {
      socket.emit('error', { message: 'Invalid video action data' });
      return;
    }
    
    const currentState = roomVideoStates.get(roomId);
    if (!currentState) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    const now = Date.now();
    if (currentState.lastUpdated && now - currentState.lastUpdated < 300) {
      return;
    }
    
    switch(action) {
      case 'play':
        currentState.currentTime = time || currentState.currentTime;
        currentState.isPlaying = true;
        break;
        
      case 'pause':
        currentState.currentTime = time || currentState.currentTime;
        currentState.isPlaying = false;
        break;
        
      case 'seek':
        currentState.currentTime = time;
        break;
        
      case 'restart':
        currentState.currentTime = 0;
        currentState.isPlaying = true;
        break;
    }
    
    currentState.lastUpdated = now;
    currentState.lastUpdatedBy = userId;
    
    socket.to(roomId).emit('video-action', {
      ...data,
      timestamp: now
    });
    
    console.log(`Video action in room ${roomId}: ${action} at ${time}s by ${userId}`);
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const { roomId, user, message } = data;
    
    if (!roomId || !user || !message) {
      socket.emit('error', { message: 'Invalid chat message' });
      return;
    }
    
    io.to(roomId).emit('chat-message', {
      user,
      message,
      timestamp: Date.now()
    });
  });

  // ✅ Voice chat signaling
  socket.on("offer", ({ roomId, offer }) => {
    socket.to(roomId).emit("offer", { offer, from: socket.id });
  });

  socket.on("answer", ({ roomId, answer }) => {
    socket.to(roomId).emit("answer", { answer, from: socket.id });
  });

  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", { candidate, from: socket.id });
  });

  // Handle user leaving room
  socket.on('leave-room', (data) => {
    const { userId, roomId } = data;
    
    if (!roomId || !userId) {
      socket.emit('error', { message: 'Invalid leave room data' });
      return;
    }
    
    const users = roomUsers.get(roomId);
    if (users) {
      const user = users.get(socket.id);
      users.delete(socket.id);
      
      const remainingUsers = Array.from(users.values());
      
      socket.to(roomId).emit('user-left', {
        userName: user?.name || 'Unknown',
        userCount: remainingUsers.length,
        users: remainingUsers
      });
      
      if (remainingUsers.length === 0) {
        rooms.delete(roomId);
        roomVideoStates.delete(roomId);
        roomUsers.delete(roomId);
        console.log(`Room ${roomId} cleaned up (no users)`);
      }
    }
    
    socket.leave(roomId);
    console.log(`User ${userId} left room ${roomId}`);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const user = socket.data.user;
    
    if (roomId && user) {
      const users = roomUsers.get(roomId);
      if (users) {
        users.delete(socket.id);
        
        const remainingUsers = Array.from(users.values());
        
        socket.to(roomId).emit('user-left', {
          userName: user.name,
          userCount: remainingUsers.length,
          users: remainingUsers
        });
        
        if (remainingUsers.length === 0) {
          rooms.delete(roomId);
          roomVideoStates.delete(roomId);
          roomUsers.delete(roomId);
          console.log(`Room ${roomId} cleaned up (no users)`);
        }
      }
    }
    
    console.log('User disconnected:', socket.id);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Shuvan server running on port ${PORT}`);
  console.log(`Uploads directory: ${uploadsDir}`);
});
