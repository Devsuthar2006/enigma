/**
 * DebAItor - Main Server (Turn-Based Version)
 * 
 * A turn-based debate app where:
 * - Host controls the flow
 * - Each player gets 30 seconds per turn
 * - Multiple rounds supported
 * - AI evaluates all responses at the end
 * 
 * Storage: Firebase Firestore (with in-memory fallback)
 */

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const OpenAI = require('openai');

// Firebase imports
const firebaseHelper = require('./firebase');
const { 
  db: firestore, 
  createRoom: fbCreateRoom, 
  getRoom: fbGetRoom, 
  updateRoom: fbUpdateRoom,
  addParticipant: fbAddParticipant,
  addArgument: fbAddArgument,
  saveReport: fbSaveReport,
  getReport: fbGetReport
} = firebaseHelper;

const app = express();
const PORT = process.env.PORT || 3000;

// Storage mode
const USE_FIRESTORE = !!firestore;
console.log(USE_FIRESTORE ? '🔥 Using Firebase Firestore for persistence' : '💾 Using in-memory storage (no persistence)');

// Check for OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_MOCK_AI = !OPENAI_API_KEY || OPENAI_API_KEY.startsWith('sk_your');

if (USE_MOCK_AI) {
  console.warn('\n⚠️  WARNING: No valid OpenAI API key found!');
  console.warn('   Using MOCK responses. Add OPENAI_API_KEY to .env for real AI.\n');
} else {
  console.log('✅ OpenAI API key detected - Real AI enabled!\n');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for audio uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// In-memory storage fallback
const memoryRooms = new Map();

// Initialize OpenAI client
let openai = null;
if (!USE_MOCK_AI) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY
  });
}

// Generate room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ============ DISCUSSION STATES ============
const STATES = {
  WAITING: 'waiting',
  COLLECTING: 'collecting',
  EVALUATING: 'evaluating',
  RESULTS: 'results'
};

// ============ DISCUSSION MODES & WEIGHT MAPPINGS ============
const VALID_MODES = ['debate', 'classroom', 'panel', 'meeting'];

const MODE_WEIGHTS = {
  debate: {
    label: 'Debate',
    logic: 0.35,
    clarity: 0.20,
    relevance: 0.30,
    emotionalBias: 0.15
  },
  classroom: {
    label: 'Classroom',
    logic: 0.20,
    clarity: 0.35,
    relevance: 0.35,
    emotionalBias: 0.10
  },
  panel: {
    label: 'Panel Discussion',
    logic: 0.30,
    clarity: 0.25,
    relevance: 0.25,
    emotionalBias: 0.20
  },
  meeting: {
    label: 'Meeting',
    logic: 0.25,
    clarity: 0.30,
    relevance: 0.35,
    emotionalBias: 0.10
  }
};

// ============ STORAGE HELPERS ============
// Firestore is the single source of truth when enabled
// Memory cache is used for performance optimization

/**
 * Get room from storage (Firestore first, then memory fallback)
 */
async function getRoom(roomCode) {
  // Check memory cache first for performance
  if (memoryRooms.has(roomCode)) {
    return memoryRooms.get(roomCode);
  }
  
  // If Firestore enabled, fetch and cache
  if (USE_FIRESTORE) {
    const room = await fbGetRoom(roomCode);
    if (room) {
      // Cache in memory for subsequent requests
      memoryRooms.set(roomCode, room);
    }
    return room;
  }
  
  return null;
}

/**
 * Save room to storage
 */
async function saveRoom(roomCode, roomData) {
  // Always save to memory cache first
  memoryRooms.set(roomCode, roomData);
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    await fbCreateRoom(roomCode, roomData);
  }
}

/**
 * Update room in storage
 */
async function updateRoomData(roomCode, updates) {
  // Update memory cache
  const room = memoryRooms.get(roomCode);
  if (room) {
    Object.assign(room, updates);
  }
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    await fbUpdateRoom(roomCode, updates);
  }
}

/**
 * Add participant to storage
 */
async function addParticipantToRoom(roomCode, participantId, participantData) {
  // Update memory cache
  let room = memoryRooms.get(roomCode);
  
  // If room not in cache, fetch it first
  if (!room && USE_FIRESTORE) {
    room = await fbGetRoom(roomCode);
    if (room) {
      memoryRooms.set(roomCode, room);
    }
  }
  
  if (room) {
    room.participants.set(participantId, {
      ...participantData,
      responses: [],
      joinedAt: Date.now()
    });
    room.turnOrder.push(participantId);
  }
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    await fbAddParticipant(roomCode, participantId, participantData);
    // Update turnOrder in Firestore
    if (room) {
      await fbUpdateRoom(roomCode, { turnOrder: room.turnOrder });
    }
  }
}

/**
 * Add argument to storage
 */
async function addArgumentToRoom(roomCode, participantId, argumentData) {
  // Get room from cache or Firestore
  let room = memoryRooms.get(roomCode);
  if (!room && USE_FIRESTORE) {
    room = await fbGetRoom(roomCode);
    if (room) {
      memoryRooms.set(roomCode, room);
    }
  }
  
  // Update memory cache
  if (room) {
    const participant = room.participants.get(participantId);
    if (participant) {
      if (!participant.responses) participant.responses = [];
      participant.responses.push(argumentData);
    }
  }
  
  // Persist to Firestore if enabled
  if (USE_FIRESTORE) {
    const argId = uuidv4();
    await fbAddArgument(roomCode, argId, {
      participantId,
      text: argumentData.transcript,
      round: argumentData.round,
      scores: argumentData.scores
    });
  }
}

// ============ API ROUTES ============

/**
 * Create a new room
 */
app.post('/api/rooms', async (req, res) => {
  const { topic, mode } = req.body;
  
  if (!topic || topic.trim().length === 0) {
    return res.status(400).json({ error: 'Topic is required' });
  }

  const selectedMode = VALID_MODES.includes(mode) ? mode : 'debate';
  const roomCode = generateRoomCode();
  const hostId = uuidv4();

  const roomData = {
    topic: topic.trim(),
    mode: selectedMode,
    hostId,
    participants: new Map(),
    currentTurn: null,
    turnOrder: [],
    currentRound: 0,
    status: STATES.WAITING,
    locked: false,
    createdAt: Date.now()
  };

  // Save to storage
  await saveRoom(roomCode, roomData);

  console.log(`Room created: ${roomCode} - "${topic}" [${MODE_WEIGHTS[selectedMode].label}] (Host: ${hostId})`);
  res.json({ roomCode, topic, hostId, mode: selectedMode, modeLabel: MODE_WEIGHTS[selectedMode].label });
});

/**
 * Helper: Verify host authorization
 */
function verifyHost(room, hostId) {
  return room && room.hostId === hostId;
}

/**
 * Get room info
 */
app.get('/api/rooms/:code', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const participants = Array.from(room.participants.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    responses: data.responses?.length || 0,
    isCurrentTurn: room.currentTurn === id
  }));

  res.json({
    roomCode,
    topic: room.topic,
    mode: room.mode || 'debate',
    modeLabel: MODE_WEIGHTS[room.mode || 'debate'].label,
    modeWeights: MODE_WEIGHTS[room.mode || 'debate'],
    status: room.status,
    locked: room.locked,
    currentRound: room.currentRound,
    currentTurn: room.currentTurn,
    currentTurnName: room.currentTurn ? room.participants.get(room.currentTurn)?.name : null,
    participants,
    turnOrder: room.turnOrder
  });
});

/**
 * Generate QR code
 */
app.get('/api/rooms/:code/qr', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const joinUrl = `${baseUrl}/join.html?code=${roomCode}`;
    
    const qrDataUrl = await QRCode.toDataURL(joinUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.json({ qrCode: qrDataUrl, joinUrl });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

/**
 * Join a room
 */
app.post('/api/rooms/:code/join', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { name } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status === 'ended' || room.status === STATES.RESULTS) {
    return res.status(400).json({ error: 'Debate has ended' });
  }

  if (room.locked) {
    return res.status(403).json({ error: 'Room is locked. No new participants allowed.' });
  }

  const participantId = uuidv4();
  const participantData = { name: name.trim() };

  // Add to storage (this also updates turnOrder)
  await addParticipantToRoom(roomCode, participantId, participantData);

  console.log(`${name} joined room ${roomCode}`);

  res.json({ 
    participantId, 
    name: name.trim(),
    topic: room.topic,
    roomCode 
  });
});

/**
 * HOST: Lock/Unlock room
 */
app.post('/api/rooms/:code/lock', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { hostId, lock } = req.body;
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!verifyHost(room, hostId)) {
    return res.status(403).json({ error: 'Unauthorized. Host access required.' });
  }

  const locked = lock !== false;
  await updateRoomData(roomCode, { locked });
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    memoryRooms.get(roomCode).locked = locked;
  }

  console.log(`Room ${roomCode} ${locked ? 'LOCKED' : 'UNLOCKED'} by host`);

  res.json({ success: true, locked });
});

/**
 * HOST: Remove a participant
 */
app.post('/api/rooms/:code/remove-participant', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { hostId, participantId } = req.body;
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (!verifyHost(room, hostId)) {
    return res.status(403).json({ error: 'Unauthorized. Host access required.' });
  }

  const participant = room.participants.get(participantId);
  if (!participant) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  const name = participant.name;
  
  // Update in memory
  if (memoryRooms.has(roomCode)) {
    const memRoom = memoryRooms.get(roomCode);
    memRoom.participants.delete(participantId);
    memRoom.turnOrder = memRoom.turnOrder.filter(id => id !== participantId);
    
    if (memRoom.currentTurn === participantId) {
      memRoom.currentTurn = memRoom.turnOrder.length > 0 ? memRoom.turnOrder[0] : null;
    }
  }

  // Update Firestore
  if (USE_FIRESTORE) {
    const newTurnOrder = room.turnOrder.filter(id => id !== participantId);
    const newCurrentTurn = room.currentTurn === participantId 
      ? (newTurnOrder.length > 0 ? newTurnOrder[0] : null) 
      : room.currentTurn;
    
    await updateRoomData(roomCode, { 
      turnOrder: newTurnOrder,
      currentTurn: newCurrentTurn
    });
  }

  console.log(`Host removed ${name} from room ${roomCode}`);

  res.json({ success: true, removed: name });
});

/**
 * HOST: Start the debate
 */
app.post('/api/rooms/:code/start', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.turnOrder.length === 0) {
    return res.status(400).json({ error: 'No participants yet' });
  }

  const currentTurn = room.turnOrder[0];
  const updates = {
    status: STATES.COLLECTING,
    currentRound: 1,
    currentTurn
  };

  await updateRoomData(roomCode, updates);
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    Object.assign(memoryRooms.get(roomCode), updates);
  }

  const currentName = room.participants.get(currentTurn)?.name;
  console.log(`Debate started in ${roomCode}. Round 1, ${currentName}'s turn`);

  res.json({ 
    success: true, 
    message: 'Debate started',
    currentTurn,
    currentTurnName: currentName,
    round: 1
  });
});

/**
 * HOST: Move to next turn
 */
app.post('/api/rooms/:code/next-turn', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.COLLECTING) {
    return res.status(400).json({ error: 'Debate not active. Current state: ' + room.status });
  }

  const currentIndex = room.turnOrder.indexOf(room.currentTurn);
  const nextIndex = currentIndex + 1;

  let currentRound = room.currentRound;
  let currentTurn;

  if (nextIndex >= room.turnOrder.length) {
    currentRound++;
    currentTurn = room.turnOrder[0];
    console.log(`Round ${currentRound} started in ${roomCode}`);
  } else {
    currentTurn = room.turnOrder[nextIndex];
  }

  const updates = { currentRound, currentTurn };
  await updateRoomData(roomCode, updates);
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    Object.assign(memoryRooms.get(roomCode), updates);
  }

  const currentName = room.participants.get(currentTurn)?.name;
  console.log(`Next turn: ${currentName}`);

  res.json({ 
    success: true,
    currentTurn,
    currentTurnName: currentName,
    round: currentRound
  });
});

/**
 * HOST: End debate and calculate results
 */
app.post('/api/rooms/:code/end', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  // Transition to evaluating state
  await updateRoomData(roomCode, { status: STATES.EVALUATING, currentTurn: null });

  console.log(`Debate ended in ${roomCode}. Evaluating submissions...`);

  // Calculate results with mode-specific weights
  const roomMode = room.mode || 'debate';
  const weights = MODE_WEIGHTS[roomMode];
  const results = [];

  for (const [id, data] of room.participants) {
    const argumentsCount = data.responses?.length || 0;
    const participationStatus = argumentsCount > 0 ? 'active' : 'silent';
    
    if (argumentsCount === 0) {
      results.push({
        id,
        name: data.name,
        argumentsSubmitted: 0,
        participationStatus: 'silent',
        totalResponses: 0,
        averageScore: 0,
        rawAverageScore: 0,
        responses: []
      });
      continue;
    }

    const avgLogic = data.responses.reduce((sum, r) => sum + (r.scores?.logic || 5), 0) / argumentsCount;
    const avgClarity = data.responses.reduce((sum, r) => sum + (r.scores?.clarity || 5), 0) / argumentsCount;
    const avgRelevance = data.responses.reduce((sum, r) => sum + (r.scores?.relevance || 5), 0) / argumentsCount;
    const avgEmotionalBias = data.responses.reduce((sum, r) => sum + (r.scores?.emotionalBias || 5), 0) / argumentsCount;
    
    // Raw score (simple average of all 4 dimensions)
    const rawAverageScore = (avgLogic + avgClarity + avgRelevance + (10 - avgEmotionalBias)) / 4;
    // Weighted score using mode-specific weights
    const averageScore = calculateFinalScore({ logic: avgLogic, clarity: avgClarity, relevance: avgRelevance, emotionalBias: avgEmotionalBias }, roomMode);
    const lastSummary = data.responses.length > 0 ? data.responses[data.responses.length - 1].scores?.summary : null;

    results.push({
      id,
      name: data.name,
      argumentsSubmitted: argumentsCount,
      participationStatus,
      totalResponses: argumentsCount,
      averageScores: {
        logic: Math.round(avgLogic * 10) / 10,
        clarity: Math.round(avgClarity * 10) / 10,
        relevance: Math.round(avgRelevance * 10) / 10,
        emotionalBias: Math.round(avgEmotionalBias * 10) / 10
      },
      rawAverageScore: Math.round(rawAverageScore * 10) / 10,
      averageScore: Math.round(averageScore * 10) / 10,
      summary: lastSummary,
      responses: data.responses
    });
  }

  results.sort((a, b) => b.averageScore - a.averageScore);
  results.forEach((r, i) => { r.rank = i + 1; });

  // Save report to Firestore
  if (USE_FIRESTORE) {
    await fbSaveReport(roomCode, {
      evaluationScores: results.map(r => ({ id: r.id, score: r.averageScore })),
      summaries: results.map(r => ({ id: r.id, name: r.name, summary: r.summary })),
      overallSummary: `Winner: ${results[0]?.name || 'N/A'}`,
      mode: roomMode,
      modeWeights: weights,
      results
    });
  }

  // Transition to results state
  await updateRoomData(roomCode, { status: STATES.RESULTS });
  
  // Update memory
  if (memoryRooms.has(roomCode)) {
    memoryRooms.get(roomCode).status = STATES.RESULTS;
  }

  console.log(`Results ready for ${roomCode} [${MODE_WEIGHTS[roomMode].label} mode]`);

  res.json({ roomCode, topic: room.topic, mode: roomMode, modeLabel: MODE_WEIGHTS[roomMode].label, modeWeights: weights, results });
});

/**
 * Submit audio response
 */
app.post('/api/rooms/:code/submit', upload.single('audio'), async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { participantId } = req.body;

  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.COLLECTING) {
    return res.status(400).json({ error: 'Debate not in progress' });
  }

  if (room.currentTurn !== participantId) {
    return res.status(400).json({ error: 'Not your turn' });
  }

  const participant = room.participants.get(participantId);

  if (!participant) {
    return res.status(404).json({ error: 'Participant not found' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Audio file is required' });
  }

  try {
    let transcript;
    let evaluation;

    if (USE_MOCK_AI) {
      console.log(`[MOCK] Processing for ${participant.name}...`);
      transcript = getMockTranscript();
      evaluation = getMockEvaluation(room.mode || 'debate');
    } else {
      console.log(`Transcribing audio for ${participant.name}...`);
      
      const audioFile = fs.createReadStream(req.file.path);
      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'en'
      });

      transcript = transcription.text;
      console.log(`Transcript: "${transcript.substring(0, 50)}..."`);

      console.log(`Evaluating response...`);
      evaluation = await evaluateResponse(room.topic, transcript, room.mode || 'debate');
    }

    const argumentData = {
      round: room.currentRound,
      transcript,
      scores: evaluation,
      submittedAt: Date.now()
    };

    // Store the response
    await addArgumentToRoom(roomCode, participantId, argumentData);

    // Clean up audio file
    fs.unlink(req.file.path, () => {});

    console.log(`${participant.name} submitted Round ${room.currentRound}: Score ${evaluation.finalScore}`);

    res.json({
      success: true,
      transcript,
      scores: evaluation,
      round: room.currentRound
    });

  } catch (error) {
    console.error('Submission error:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Failed to process', details: error.message });
  }
});

/**
 * Get current turn status (for participant polling)
 */
app.get('/api/rooms/:code/turn-status', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const { participantId } = req.query;
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const isMyTurn = room.currentTurn === participantId;
  const currentTurnName = room.currentTurn ? room.participants.get(room.currentTurn)?.name : null;

  res.json({
    status: room.status,
    round: room.currentRound,
    isMyTurn,
    currentTurnName,
    currentTurn: room.currentTurn
  });
});

/**
 * Get results (only when debate ended)
 */
app.get('/api/rooms/:code/results', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.RESULTS && room.status !== 'ended') {
    return res.status(400).json({ error: 'Debate has not ended yet' });
  }

  // Try to get from Firestore report first
  if (USE_FIRESTORE) {
    const report = await fbGetReport(roomCode);
    if (report && report.results) {
      return res.json({ roomCode, topic: room.topic, results: report.results });
    }
  }

  // Calculate results from participants using mode-specific weights
  const roomMode = room.mode || 'debate';
  const weights = MODE_WEIGHTS[roomMode];
  const results = [];

  for (const [id, data] of room.participants) {
    if (!data.responses || data.responses.length === 0) {
      results.push({ id, name: data.name, totalResponses: 0, averageScore: 0, rawAverageScore: 0, responses: [] });
      continue;
    }

    const avgLogic = data.responses.reduce((sum, r) => sum + (r.scores?.logic || 0), 0) / data.responses.length;
    const avgClarity = data.responses.reduce((sum, r) => sum + (r.scores?.clarity || 0), 0) / data.responses.length;
    const avgRelevance = data.responses.reduce((sum, r) => sum + (r.scores?.relevance || 0), 0) / data.responses.length;
    const avgEmotionalBias = data.responses.reduce((sum, r) => sum + (r.scores?.emotionalBias || 0), 0) / data.responses.length;
    
    const rawAverageScore = (avgLogic + avgClarity + avgRelevance + (10 - avgEmotionalBias)) / 4;
    const averageScore = calculateFinalScore({ logic: avgLogic, clarity: avgClarity, relevance: avgRelevance, emotionalBias: avgEmotionalBias }, roomMode);

    results.push({
      id,
      name: data.name,
      totalResponses: data.responses.length,
      averageScores: {
        logic: Math.round(avgLogic * 10) / 10,
        clarity: Math.round(avgClarity * 10) / 10,
        relevance: Math.round(avgRelevance * 10) / 10,
        emotionalBias: Math.round(avgEmotionalBias * 10) / 10
      },
      rawAverageScore: Math.round(rawAverageScore * 10) / 10,
      averageScore: Math.round(averageScore * 10) / 10,
      responses: data.responses
    });
  }

  results.sort((a, b) => b.averageScore - a.averageScore);
  results.forEach((r, i) => { r.rank = i + 1; });

  res.json({ roomCode, topic: room.topic, mode: roomMode, modeLabel: MODE_WEIGHTS[roomMode].label, modeWeights: weights, results });
});

/**
 * Export discussion report (text format)
 */
app.get('/api/rooms/:code/report', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const format = req.query.format || 'text';
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  if (room.status !== STATES.RESULTS && room.status !== 'ended') {
    return res.status(400).json({ error: 'Debate has not ended yet' });
  }

  // Get results
  let results = [];
  
  if (USE_FIRESTORE) {
    const report = await fbGetReport(roomCode);
    if (report && report.results) {
      results = report.results;
    }
  }

  if (results.length === 0) {
    for (const [id, data] of room.participants) {
      if (!data.responses || data.responses.length === 0) {
        results.push({ id, name: data.name, totalResponses: 0, averageScore: 0, responses: [] });
        continue;
      }

      const avgLogic = data.responses.reduce((sum, r) => sum + (r.scores?.logic || 0), 0) / data.responses.length;
      const avgClarity = data.responses.reduce((sum, r) => sum + (r.scores?.clarity || 0), 0) / data.responses.length;
      const avgRelevance = data.responses.reduce((sum, r) => sum + (r.scores?.relevance || 0), 0) / data.responses.length;
      const avgEmotionalBias = data.responses.reduce((sum, r) => sum + (r.scores?.emotionalBias || 0), 0) / data.responses.length;
      const reportMode = room.mode || 'debate';
      const averageScore = calculateFinalScore({ logic: avgLogic, clarity: avgClarity, relevance: avgRelevance, emotionalBias: avgEmotionalBias }, reportMode);

      results.push({
        id,
        name: data.name,
        totalResponses: data.responses.length,
        averageScores: {
          logic: Math.round(avgLogic * 10) / 10,
          clarity: Math.round(avgClarity * 10) / 10,
          relevance: Math.round(avgRelevance * 10) / 10,
          emotionalBias: Math.round(avgEmotionalBias * 10) / 10
        },
        averageScore: Math.round(averageScore * 10) / 10,
        responses: data.responses
      });
    }
  }

  results.sort((a, b) => b.averageScore - a.averageScore);
  results.forEach((r, i) => { r.rank = i + 1; });

  // JSON format
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="debate-report-${roomCode}.json"`);
    return res.json({
      exportedAt: new Date().toISOString(),
      roomCode,
      topic: room.topic,
      mode: room.mode || 'debate',
      modeLabel: MODE_WEIGHTS[room.mode || 'debate'].label,
      modeWeights: MODE_WEIGHTS[room.mode || 'debate'],
      totalRounds: room.currentRound,
      participants: results
    });
  }

  // Text format
  const winner = results[0];
  const reportDate = new Date().toLocaleString();
  
  let report = `
╔══════════════════════════════════════════════════════════════════════╗
║                      DEBAITOR - DISCUSSION REPORT                    ║
╚══════════════════════════════════════════════════════════════════════╝

Report Generated: ${reportDate}
Room Code: ${roomCode}
Topic: ${room.topic}
Mode: ${MODE_WEIGHTS[room.mode || 'debate'].label}
Total Rounds: ${room.currentRound}
Total Participants: ${results.length}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                              🏆 WINNER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${winner ? `${winner.name} (Score: ${winner.averageScore}/10)` : 'No winner'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                        FINAL STANDINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  results.forEach(p => {
    report += `
#${p.rank} ${p.name}
   Overall Score: ${p.averageScore}/10
   Responses: ${p.totalResponses}
   ├─ Logic:          ${p.averageScores?.logic || 0}/10
   ├─ Clarity:        ${p.averageScores?.clarity || 0}/10
   ├─ Relevance:      ${p.averageScores?.relevance || 0}/10
   └─ Emotional Bias: ${p.averageScores?.emotionalBias || 0}/10
`;
  });

  // Add complete conversation transcript
  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                     COMPLETE CONVERSATION TRANSCRIPT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  // Collect all responses with timestamps and organize by round
  const allResponses = [];
  results.forEach(p => {
    if (p.responses && p.responses.length > 0) {
      p.responses.forEach((response, idx) => {
        allResponses.push({
          name: p.name,
          round: response.round || idx + 1,
          transcript: response.transcript || '[No transcript available]',
          score: response.scores?.finalScore || 0,
          feedback: response.scores?.insight || '',
          timestamp: response.timestamp || Date.now()
        });
      });
    }
  });

  // Sort by round then timestamp
  allResponses.sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.timestamp - b.timestamp;
  });

  // Group by round
  let currentRound = 0;
  allResponses.forEach(response => {
    if (response.round !== currentRound) {
      currentRound = response.round;
      report += `
────────────────────── ROUND ${currentRound} ──────────────────────
`;
    }
    
    report += `
[${response.name}] (Score: ${response.score}/10)
"${response.transcript}"

AI Feedback: ${response.feedback || 'No feedback available'}
`;
  });

  if (allResponses.length === 0) {
    report += `
[No responses recorded in this debate]
`;
  }

  report += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                     Generated by DebAItor
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="debate-report-${roomCode}.txt"`);
  res.send(report);
});

// ============ PARTICIPATION ANALYTICS ============

/**
 * Get participation analytics for a room
 */
app.get('/api/rooms/:code/analytics', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const participantCount = room.participants.size;
  if (participantCount === 0) {
    return res.json({
      roomCode,
      topic: room.topic,
      totalParticipants: 0,
      totalArguments: 0,
      averageArgsPerPerson: 0,
      balanceScore: 0,
      participants: [],
      lowContributors: [],
      zeroContributors: []
    });
  }

  // Compute per-participant metrics
  let totalArguments = 0;
  const participantMetrics = [];

  for (const [id, data] of room.participants) {
    const argCount = data.responses?.length || 0;
    totalArguments += argCount;
    participantMetrics.push({
      id,
      name: data.name,
      argumentCount: argCount
    });
  }

  const averageArgsPerPerson = participantCount > 0
    ? Math.round((totalArguments / participantCount) * 10) / 10
    : 0;

  // Compute contribution percentage and status
  participantMetrics.forEach(p => {
    p.contributionPct = totalArguments > 0
      ? Math.round((p.argumentCount / totalArguments) * 1000) / 10
      : 0;
    
    // Status: zero, low (below average), active (at or above average)
    if (p.argumentCount === 0) {
      p.status = 'zero';
    } else if (p.argumentCount < averageArgsPerPerson) {
      p.status = 'low';
    } else {
      p.status = 'active';
    }
  });

  // Sort by argument count descending
  participantMetrics.sort((a, b) => b.argumentCount - a.argumentCount);

  // Identify low and zero contributors
  const zeroContributors = participantMetrics.filter(p => p.status === 'zero').map(p => p.name);
  const lowContributors = participantMetrics.filter(p => p.status === 'low').map(p => p.name);

  // Compute participation balance score (0-100)
  // Uses normalized standard deviation: 100 = perfectly balanced, 0 = maximally unbalanced
  let balanceScore = 100;
  if (participantCount > 1 && totalArguments > 0) {
    const mean = totalArguments / participantCount;
    const variance = participantMetrics.reduce((sum, p) => {
      return sum + Math.pow(p.argumentCount - mean, 2);
    }, 0) / participantCount;
    const stdDev = Math.sqrt(variance);
    // Coefficient of variation, capped at 1
    const cv = Math.min(stdDev / mean, 1);
    balanceScore = Math.round((1 - cv) * 100);
  } else if (totalArguments === 0) {
    balanceScore = 0;
  }

  res.json({
    roomCode,
    topic: room.topic,
    totalParticipants: participantCount,
    totalArguments,
    totalRounds: room.currentRound || 0,
    averageArgsPerPerson,
    balanceScore,
    participants: participantMetrics,
    lowContributors,
    zeroContributors
  });
});

// ============ MODERATOR INSIGHTS ============

/**
 * Get moderator insights for a room
 * Analyzes stored evaluation data to detect patterns
 */
app.get('/api/rooms/:code/insights', async (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = await getRoom(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const participantCount = room.participants.size;
  const insights = [];

  if (participantCount === 0) {
    return res.json({ roomCode, insights: [{ type: 'info', icon: 'ℹ️', title: 'No Data', message: 'No participants have joined yet.' }] });
  }

  // Gather data
  let totalArguments = 0;
  const participantData = [];

  for (const [id, data] of room.participants) {
    const responses = data.responses || [];
    const argCount = responses.length;
    totalArguments += argCount;

    // Compute per-participant averages from stored scores
    let avgRelevance = 0, avgClarity = 0, avgLogic = 0, avgEmotionalBias = 0;
    if (argCount > 0) {
      avgRelevance = responses.reduce((s, r) => s + (r.scores?.relevance || 0), 0) / argCount;
      avgClarity = responses.reduce((s, r) => s + (r.scores?.clarity || 0), 0) / argCount;
      avgLogic = responses.reduce((s, r) => s + (r.scores?.logic || 0), 0) / argCount;
      avgEmotionalBias = responses.reduce((s, r) => s + (r.scores?.emotionalBias || 0), 0) / argCount;
    }

    participantData.push({
      name: data.name,
      argCount,
      avgRelevance: Math.round(avgRelevance * 10) / 10,
      avgClarity: Math.round(avgClarity * 10) / 10,
      avgLogic: Math.round(avgLogic * 10) / 10,
      avgEmotionalBias: Math.round(avgEmotionalBias * 10) / 10,
      avgScore: argCount > 0 ? Math.round(((avgLogic + avgClarity + avgRelevance + (10 - avgEmotionalBias)) / 4) * 10) / 10 : 0
    });
  }

  // ── Insight 1: Dominance Detection ──
  if (totalArguments > 0) {
    participantData.forEach(p => {
      const pct = (p.argCount / totalArguments) * 100;
      if (pct > 50 && participantCount > 1) {
        insights.push({
          type: 'warning',
          icon: '👑',
          title: 'Dominance Detected',
          message: `${p.name} contributed ${Math.round(pct)}% of all arguments. Consider encouraging others to participate more.`,
          metric: `${Math.round(pct)}%`,
          metricLabel: 'Share'
        });
      }
    });
  }

  // ── Insight 2: Low Engagement ──
  if (totalArguments < participantCount && room.status !== STATES.WAITING) {
    insights.push({
      type: 'warning',
      icon: '📉',
      title: 'Low Engagement',
      message: `Only ${totalArguments} argument${totalArguments !== 1 ? 's' : ''} submitted across ${participantCount} participants. Average is below 1 per person.`,
      metric: totalArguments,
      metricLabel: 'Total Args'
    });
  }

  // ── Insight 3: Silent Participants ──
  const silentNames = participantData.filter(p => p.argCount === 0).map(p => p.name);
  if (silentNames.length > 0 && room.status !== STATES.WAITING) {
    insights.push({
      type: 'danger',
      icon: '🔇',
      title: 'Silent Participants',
      message: `${silentNames.join(', ')} ${silentNames.length === 1 ? 'has' : 'have'} not submitted any arguments.`,
      metric: silentNames.length,
      metricLabel: 'Silent'
    });
  }

  // ── Insight 4: Low Relevance ──
  const activeParticipants = participantData.filter(p => p.argCount > 0);
  if (activeParticipants.length > 0) {
    const avgGroupRelevance = activeParticipants.reduce((s, p) => s + p.avgRelevance, 0) / activeParticipants.length;
    if (avgGroupRelevance < 5 && avgGroupRelevance > 0) {
      insights.push({
        type: 'warning',
        icon: '🎯',
        title: 'Low Relevance',
        message: `The group's average relevance score is ${Math.round(avgGroupRelevance * 10) / 10}/10. Arguments may be drifting off-topic.`,
        metric: `${Math.round(avgGroupRelevance * 10) / 10}/10`,
        metricLabel: 'Avg Relevance'
      });
    }

    // ── Insight 5: High Emotional Bias ──
    const avgGroupBias = activeParticipants.reduce((s, p) => s + p.avgEmotionalBias, 0) / activeParticipants.length;
    if (avgGroupBias > 6) {
      insights.push({
        type: 'warning',
        icon: '🔥',
        title: 'High Emotional Bias',
        message: `The group's average emotional bias is ${Math.round(avgGroupBias * 10) / 10}/10. Discussion may benefit from more objective reasoning.`,
        metric: `${Math.round(avgGroupBias * 10) / 10}/10`,
        metricLabel: 'Avg Bias'
      });
    }

    // ── Insight 6: Low Clarity ──
    const avgGroupClarity = activeParticipants.reduce((s, p) => s + p.avgClarity, 0) / activeParticipants.length;
    if (avgGroupClarity < 5 && avgGroupClarity > 0) {
      insights.push({
        type: 'warning',
        icon: '💬',
        title: 'Low Clarity',
        message: `The group's average clarity score is ${Math.round(avgGroupClarity * 10) / 10}/10. Participants may need to articulate their points more clearly.`,
        metric: `${Math.round(avgGroupClarity * 10) / 10}/10`,
        metricLabel: 'Avg Clarity'
      });
    }

    // ── Insight 7: Score Disparity ──
    if (activeParticipants.length > 1) {
      const scores = activeParticipants.map(p => p.avgScore);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      const gap = Math.round((maxScore - minScore) * 10) / 10;
      if (gap > 3) {
        const topName = activeParticipants.find(p => p.avgScore === maxScore)?.name;
        const bottomName = activeParticipants.find(p => p.avgScore === minScore)?.name;
        insights.push({
          type: 'info',
          icon: '📊',
          title: 'Score Disparity',
          message: `There is a ${gap}-point gap between ${topName} (${maxScore}) and ${bottomName} (${minScore}). Consider reviewing argument quality differences.`,
          metric: gap,
          metricLabel: 'Point Gap'
        });
      }
    }
  }

  // ── Positive Insight: Strong Discussion ──
  if (insights.length === 0 && totalArguments > 0) {
    insights.push({
      type: 'success',
      icon: '✅',
      title: 'Strong Discussion',
      message: 'No significant issues detected. The discussion appears balanced, relevant, and well-engaged.',
      metric: '👍',
      metricLabel: 'All Good'
    });
  }

  res.json({
    roomCode,
    topic: room.topic,
    totalInsights: insights.length,
    insights
  });
});

// ============ AI EVALUATION ============

function calculateFinalScore(scores, mode = 'debate') {
  const { logic, clarity, relevance, emotionalBias } = scores;
  const w = MODE_WEIGHTS[mode] || MODE_WEIGHTS.debate;
  return Math.round(((logic * w.logic) + (clarity * w.clarity) + (relevance * w.relevance) + ((10 - emotionalBias) * w.emotionalBias)) * 10) / 10;
}

async function evaluateResponse(topic, transcript, mode = 'debate') {
  const systemPrompt = `You are an impartial discussion evaluator.

Task:
Evaluate the following discussion argument based ONLY on how it is presented.

Evaluation Criteria (score each from 1 to 10):
1. Logic – How well-structured and logical the argument is.
2. Clarity – How clearly the idea is expressed.
3. Relevance – How well the argument stays on the given topic.
4. Emotional Bias – How emotional vs objective the argument is.

Return ONLY a valid JSON object:
{
  "logic": X,
  "clarity": X,
  "relevance": X,
  "emotionalBias": X,
  "summary": "Brief one-line summary"
}`;

  const userPrompt = `Topic: "${topic}"\n\nArgument:\n"${transcript}"`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    const responseText = completion.choices[0]?.message?.content || '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('No valid JSON in response');
    }

    const scores = JSON.parse(jsonMatch[0]);
    scores.finalScore = calculateFinalScore(scores, mode);
    
    return scores;
  } catch (error) {
    console.error('AI evaluation error:', error.message);
    return getMockEvaluation(mode);
  }
}

// Mock functions
const MOCK_TRANSCRIPTS = [
  "I believe we need to consider both perspectives carefully before making a judgment.",
  "The evidence clearly shows that this approach has significant benefits.",
  "While there are valid concerns, the overall impact remains positive.",
  "We must prioritize long-term sustainability over short-term gains."
];

const MOCK_SUMMARIES = [
  "Presents a balanced perspective but lacks depth.",
  "Clear argument with good supporting evidence.",
  "Well-reasoned but could be more relevant to topic.",
  "Strong conviction but needs more logical structure."
];

function getMockTranscript() {
  return MOCK_TRANSCRIPTS[Math.floor(Math.random() * MOCK_TRANSCRIPTS.length)];
}

function getMockEvaluation(mode = 'debate') {
  const logic = Math.floor(Math.random() * 4) + 5;
  const clarity = Math.floor(Math.random() * 4) + 5;
  const relevance = Math.floor(Math.random() * 4) + 5;
  const emotionalBias = Math.floor(Math.random() * 5) + 2;
  const summary = MOCK_SUMMARIES[Math.floor(Math.random() * MOCK_SUMMARIES.length)];
  const finalScore = calculateFinalScore({ logic, clarity, relevance, emotionalBias }, mode);
  return { logic, clarity, relevance, emotionalBias, summary, finalScore };
}

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));

// Start server
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║      DebAItor - Turn-Based Debate MVP         ║
╠═══════════════════════════════════════════════╣
║  Server: http://localhost:${PORT}                ║
║  Storage: ${USE_FIRESTORE ? 'Firebase Firestore' : 'In-Memory'}             ║
║                                               ║
║  Host Flow:                                   ║
║  1. Create room → 2. Wait for players         ║
║  3. Start debate → 4. Control turns           ║
║  5. End debate → View results                 ║
╚═══════════════════════════════════════════════╝
    `);
  });
}

module.exports = app;
