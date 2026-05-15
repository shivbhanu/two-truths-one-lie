const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const gameData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'game.json'), 'utf8'));

// Game state
const state = {
  phase: 'lobby',  // lobby | voting | closed | revealing | leaderboard
  currentSlide: 0,
  votes: {},       // { [slideIndex]: { [voterName]: { voter, guessedName, lieIndex } } }
};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function getPublicState() {
  const pub = {
    phase: state.phase,
    currentSlide: state.currentSlide,
    totalSlides: gameData.slides.length,
    voteCount: state.votes[state.currentSlide]
      ? Object.keys(state.votes[state.currentSlide]).length
      : 0,
  };
  if (state.phase === 'revealing') {
    pub.revealData = getRevealData(state.currentSlide);
  }
  return pub;
}

function computeScores() {
  const scores = {};
  gameData.players.forEach(p => { scores[p] = 0; });

  for (let i = 0; i < gameData.slides.length; i++) {
    const slide = gameData.slides[i];
    const slideVotes = state.votes[i] || {};
    Object.values(slideVotes).forEach(vote => {
      const whoCorrect = vote.guessedName === slide.correctName;
      const lieCorrect = vote.lieIndex === slide.lieIndex;
      if (whoCorrect && lieCorrect) {
        scores[vote.voter] = (scores[vote.voter] || 0) + 5;
      } else {
        if (whoCorrect) scores[vote.voter] = (scores[vote.voter] || 0) + 2;
        if (lieCorrect) scores[vote.voter] = (scores[vote.voter] || 0) + 2;
      }
    });
  }
  return scores;
}

function computeMostMysterious() {
  const fooled = {};
  gameData.players.forEach(p => { fooled[p] = 0; });

  for (let i = 0; i < gameData.slides.length; i++) {
    const slide = gameData.slides[i];
    const slideVotes = state.votes[i] || {};
    const wrongGuesses = Object.values(slideVotes).filter(v => v.guessedName !== slide.correctName).length;
    fooled[slide.correctName] = (fooled[slide.correctName] || 0) + wrongGuesses;
  }

  const max = Math.max(...Object.values(fooled));
  return { player: Object.keys(fooled).find(p => fooled[p] === max), count: max };
}

function getRevealData(slideIndex) {
  const slide = gameData.slides[slideIndex];
  const slideVotes = state.votes[slideIndex] || {};
  const allVotes = Object.values(slideVotes);

  const nameCounts = {};
  gameData.players.forEach(p => { nameCounts[p] = 0; });
  allVotes.forEach(v => { nameCounts[v.guessedName] = (nameCounts[v.guessedName] || 0) + 1; });

  const lieIndexCounts = { 0: 0, 1: 0, 2: 0 };
  allVotes.forEach(v => { lieIndexCounts[v.lieIndex]++; });

  const whoCorrectCount = allVotes.filter(v => v.guessedName === slide.correctName).length;
  const lieCorrectCount = allVotes.filter(v => v.lieIndex === slide.lieIndex).length;

  return {
    slideIndex,
    statements: slide.statements,
    correctName: slide.correctName,
    lieIndex: slide.lieIndex,
    nameCounts,
    lieIndexCounts,
    whoCorrectCount,
    lieCorrectCount,
    totalVotes: allVotes.length,
  };
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token === gameData.adminPassword) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// --- API Routes ---

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === gameData.adminPassword) {
    res.json({ ok: true, token: gameData.adminPassword });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.get('/api/state', (req, res) => {
  res.json(getPublicState());
});

app.get('/api/game-data', (req, res) => {
  res.json({
    players: gameData.players,
    totalSlides: gameData.slides.length,
    currentSlideStatements: gameData.slides[state.currentSlide]?.statements || [],
  });
});

// Spoiler C fix: gameData (with answers) is no longer sent; only players list is included
app.get('/api/admin/full-state', requireAdmin, (req, res) => {
  res.json({
    state,
    players: gameData.players,
    scores: computeScores(),
    mostMysterious: computeMostMysterious(),
  });
});

app.get('/api/voted', (req, res) => {
  const { name } = req.query;
  const slideVotes = state.votes[state.currentSlide] || {};
  res.json({ voted: !!slideVotes[name] });
});

app.post('/api/vote', (req, res) => {
  if (state.phase !== 'voting') {
    return res.status(400).json({ error: 'Voting is not open' });
  }
  const { voterName, guessedName, lieIndex } = req.body;
  if (!voterName || !guessedName || lieIndex === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (!gameData.players.includes(voterName)) {
    return res.status(400).json({ error: 'Invalid voter' });
  }
  if (!gameData.players.includes(guessedName)) {
    return res.status(400).json({ error: 'Invalid guess' });
  }

  if (!state.votes[state.currentSlide]) state.votes[state.currentSlide] = {};
  if (state.votes[state.currentSlide][voterName]) {
    return res.status(400).json({ error: 'Already voted' });
  }

  state.votes[state.currentSlide][voterName] = { voter: voterName, guessedName, lieIndex: parseInt(lieIndex) };
  broadcast({ type: 'state', data: getPublicState() });
  res.json({ ok: true });
});

// Admin controls

app.post('/api/admin/open-voting', requireAdmin, (req, res) => {
  if (state.phase !== 'lobby' && state.phase !== 'closed') {
    return res.status(400).json({ error: 'Invalid phase' });
  }
  state.phase = 'voting';
  broadcast({ type: 'state', data: getPublicState() });
  res.json({ ok: true });
});

app.post('/api/admin/close-voting', requireAdmin, (req, res) => {
  if (state.phase !== 'voting') {
    return res.status(400).json({ error: 'Not in voting phase' });
  }
  state.phase = 'closed';
  broadcast({ type: 'state', data: getPublicState() });
  res.json({ ok: true });
});

// Reveal the current round immediately — replaces the old batch reveal flow
app.post('/api/admin/reveal-current', requireAdmin, (req, res) => {
  if (state.phase !== 'closed') {
    return res.status(400).json({ error: 'Must close voting first' });
  }
  state.phase = 'revealing';
  // revealData is included in getPublicState() when phase is 'revealing'
  broadcast({ type: 'state', data: getPublicState() });
  res.json({ ok: true });
});

app.post('/api/admin/next-round', requireAdmin, (req, res) => {
  if (state.phase !== 'revealing') {
    return res.status(400).json({ error: 'Must reveal current round first' });
  }

  if (state.currentSlide >= gameData.slides.length - 1) {
    state.phase = 'leaderboard';
    const scores = computeScores();
    const mostMysterious = computeMostMysterious();
    const maxScore = Math.max(...Object.values(scores), 0);
    const bestDetective = Object.keys(scores).find(p => scores[p] === maxScore);
    const leaderboard = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)
      .map(([name, score]) => ({ name, score }));
    broadcast({
      type: 'leaderboard',
      data: { leaderboard, bestDetective, mostMysterious, publicState: getPublicState() },
    });
  } else {
    state.currentSlide++;
    state.phase = 'lobby';
    broadcast({ type: 'state', data: getPublicState() });
  }

  res.json({ ok: true, phase: state.phase });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  state.phase = 'lobby';
  state.currentSlide = 0;
  state.votes = {};
  broadcast({ type: 'state', data: getPublicState() });
  res.json({ ok: true });
});

// WebSocket: send current state on connect so late joiners/refreshers sync up
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', data: getPublicState() }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Two Truths & One Lie running at http://localhost:${PORT}`);
  console.log(`Admin password: ${gameData.adminPassword}`);
});
