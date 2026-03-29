/**
 * Simple Rummy — Main Wiring Module
 *
 * Handles all Simple Rummy game flows: create/join room, lobby,
 * gameplay (draw/discard), results, session persistence.
 */

import { showScreen, showToast } from '../../platform-ui.js';
import {
  createGame,
  drawCard,
  discardCard,
  validateState,
  serializeState,
  deserializeState,
} from './engine.js';
import {
  renderGameplay,
  renderResults,
  renderLobbyPlayers,
  renderReadyIndicators,
  renderWinDisplay,
} from './ui.js';
import {
  announceWin,
  initAudio,
  toggleMute,
  isMuted,
  warmSpeech,
} from '../../shared/voice-announcer.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  writeGameState,
  setupDisconnectHandler,
  endRoom,
  deleteRoom,
  resetRoom,
  firebaseRetry,
} from '../../shared/firebase-sync.js';
import { db } from '../../shared/firebase-config.js';
import { ref, get, update, remove, onValue, off } from 'firebase/database';
import { serializeCard } from '../../shared/deck.js';

/* ======= CONSTANTS ======= */
const GAME_ID = 'simple-rummy';
const SR_SESSION_KEY = 'card_games_sr_session';

/* ======= STATE ======= */
let state = null;
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let unsubscribeRoom = null;
let goHome = null;

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(SR_SESSION_KEY, JSON.stringify({ gameId: GAME_ID, roomCode, playerIndex, isHost }));
    } catch (_) {}
  }
}
function clearSession() { localStorage.removeItem(SR_SESSION_KEY); }
function loadSession() {
  try { const r = localStorage.getItem(SR_SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
}

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearSession();
  roomCode = null; playerIndex = null; isHost = false; playerNames = []; state = null;
  if (goHome) goHome();
}

/* ======= FIREBASE WRITE ======= */

async function writeFullState(stateToWrite, lastMove) {
  const serialized = serializeState(stateToWrite);
  const updates = {
    game: serialized,
    lastMove: lastMove || null,
    'meta/lastActivity': Date.now(),
  };
  if (stateToWrite.status === 'playing') updates['meta/status'] = 'active';
  await firebaseRetry(() => update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`), updates));
}

/* ======= CREATE ROOM ======= */

function wireCreateRoom() {
  const btn = document.getElementById('sr-btn-create-room');
  const submit = document.getElementById('sr-btn-create-submit');

  if (btn) btn.addEventListener('click', () => showScreen('sr-create-room'));

  if (submit) submit.addEventListener('click', async () => {
    const name = document.getElementById('sr-create-name')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#sr-create-room .sr-emoji-picker');
    const sel = picker?.querySelector('.emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '👲';
    try {
      const result = await createRoom(GAME_ID, name, emoji);
      roomCode = result.roomCode; playerIndex = result.playerIndex; isHost = true;
      playerNames = [name]; saveSession();
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      setupLobby();
    } catch (err) { console.error(err); showToast('Failed to create room.'); }
  });
}

/* ======= JOIN ROOM ======= */

function wireJoinRoom() {
  const btn = document.getElementById('sr-btn-join-room');
  const submit = document.getElementById('sr-btn-join-submit');

  if (btn) btn.addEventListener('click', () => showScreen('sr-join-room'));

  if (submit) submit.addEventListener('click', async () => {
    const code = document.getElementById('sr-room-code')?.value.trim().toUpperCase();
    const name = document.getElementById('sr-join-name')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#sr-join-room .sr-emoji-picker');
    const sel = picker?.querySelector('.emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '👲';
    try {
      const result = await joinRoom(GAME_ID, code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code; playerIndex = result.playerIndex; isHost = false;
      saveSession();
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      setupLobby();
    } catch (err) { console.error(err); showToast('Failed to join room.'); }
  });
}

/* ======= LOBBY ======= */

function setupLobby() {
  showScreen('sr-lobby');
  const codeEl = document.getElementById('sr-lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;

  const btnStart = document.getElementById('sr-btn-start-online');
  const waiting = document.getElementById('sr-lobby-waiting');
  if (isHost) { if (btnStart) btnStart.hidden = false; if (waiting) waiting.hidden = true; }
  else { if (btnStart) btnStart.hidden = true; if (waiting) waiting.hidden = false; }

  setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
    onPlayersChange: (players) => {
      const keys = Object.keys(players).sort();
      const arr = keys.map((k) => players[k]);
      playerNames = arr.map((p) => p.name || 'Unknown');
      renderLobbyPlayers(arr);
    },
    onStatusChange: async (status) => {
      if (status === 'active' && !isHost) {
        try {
          const snap = await firebaseRetry(() => get(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`)));
          if (snap.exists()) {
            const d = snap.val();
            if (d.game && d.players) { state = deserializeState(d.game, d.players); startGame(); }
          }
        } catch (err) { console.error(err); showToast('Failed to load game.'); }
      }
      if (status === 'lobby') { state = null; setupLobby(); }
      if (status === 'ended') {
        if (state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('sr-results'); startReadyListener(); }
      }
    },
    onGameUpdate: (gameData) => { handleRemoteUpdate(gameData); },
    onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
  });
}

function wireLobby() {
  // Share code
  const shareBtn = document.getElementById('sr-btn-share-code');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    if (!roomCode) return;
    const text = `Join my Simple Rummy room! Code: ${roomCode}`;
    if (navigator.share) { try { await navigator.share({ title: 'Simple Rummy', text, url: location.origin }); return; } catch (_) {} }
    try { await navigator.clipboard.writeText(`${text}\n${location.origin}`); showToast('Room code copied!'); } catch (_) { showToast(`Room code: ${roomCode}`); }
  });

  // Start game (host)
  const startBtn = document.getElementById('sr-btn-start-online');
  if (startBtn) startBtn.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    if (playerNames.length < 2) { showToast('Need at least 2 players'); return; }
    try {
      const snap = await firebaseRetry(() => get(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players`)));
      if (!snap.exists()) { showToast('No players found'); return; }
      const pd = snap.val();
      const keys = Object.keys(pd).sort();
      const infos = keys.map((k) => ({ name: pd[k].name || 'Unknown', emoji: pd[k].emoji || '😀' }));
      state = createGame(infos);
      await writeFullState(state, null);
      startGame();
    } catch (err) { console.error(err); showToast('Failed to start game.'); }
  });

  // Leave
  const leaveBtn = document.getElementById('sr-btn-leave-lobby');
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    if (isHost && roomCode) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
    else if (roomCode && playerIndex != null) { try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {} }
    cleanupAndGoHome();
  });
}

/* ======= GAMEPLAY ======= */

function startGame() {
  showScreen('sr-gameplay');
  const endBtn = document.getElementById('sr-btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;
  renderUI();
}

function renderUI() {
  if (!state) return;
  renderGameplay(state, playerIndex, {
    onDrawPileTap: () => handleDraw('drawPile'),
    onDiscardPileTap: () => handleDraw('discardPile'),
    onHandCardTap: (idx) => handleDiscard(idx),
  });
}

async function handleDraw(source) {
  if (!state || state.status === 'finished') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (state.turnPhase !== 'draw') return;

  warmSpeech();

  try {
    const newState = drawCard(state, source);
    if (newState.status === 'finished') {
      // Draw pile exhaustion → game draw
      state = newState;
      await writeFullState(state, null);
      renderResults(state);
      showScreen('sr-results');
      startReadyListener();
      return;
    }
    state = newState;
    renderUI();
  } catch (err) { console.error(err); showToast('Draw failed'); }
}

async function handleDiscard(handIndex) {
  if (!state || state.status === 'finished') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (state.turnPhase !== 'discard') return;

  try {
    const discardedCard = state.players[playerIndex].hand[handIndex];
    const { newState, won, winGroups } = discardCard(state, handIndex);

    const validation = validateState(newState);
    if (!validation.valid) { showToast(`Error: ${validation.error}`); return; }

    const lastMove = {
      playerIndex,
      discardedCard: serializeCard(discardedCard),
      timestamp: Date.now(),
    };

    await writeFullState(newState, lastMove);
    state = newState;

    if (won) {
      if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
      const winner = state.players[state.winnerIndex];
      await announceWin(winner.name);
      renderResults(state);
      showScreen('sr-results');
      startReadyListener();
      return;
    }

    renderUI();
  } catch (err) { console.error(err); showToast('Discard failed'); }
}

/* ======= REMOTE UPDATES ======= */

function handleRemoteUpdate(gameData) {
  if (!gameData || !roomCode) return;

  const playersData = {};
  playerNames.forEach((name, i) => {
    playersData[`player_${i}`] = {
      name,
      emoji: state ? state.players[i]?.emoji || '😀' : '😀',
    };
  });

  const newState = deserializeState(gameData, playersData);
  state = newState;

  if (state.status === 'finished') {
    if (state.winnerIndex != null) {
      const winner = state.players[state.winnerIndex];
      announceWin(winner.name);
      if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
    renderResults(state);
    showScreen('sr-results');
    startReadyListener();
    return;
  }

  renderUI();
}

/* ======= END GAME ======= */

function wireEndGame() {
  const btn = document.getElementById('sr-btn-end-game');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state) return;
    state.status = 'finished'; state.winnerIndex = null;
    if (roomCode) { try { await endRoom(GAME_ID, roomCode); } catch (_) {} }
    renderResults(state);
    showScreen('sr-results');
    startReadyListener();
  });
}

/* ======= RESULTS & PLAY AGAIN ======= */

function wireResults() {
  const btnAgain = document.getElementById('sr-btn-play-again');
  const btnHome = document.getElementById('sr-btn-home');

  if (btnAgain) btnAgain.addEventListener('click', async () => {
    if (isHost) {
      if (!btnAgain.dataset.hostReady) {
        btnAgain.dataset.hostReady = 'true';
        btnAgain.textContent = '▶ Start New Round';
        if (roomCode) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {} }
      } else {
        if (window._srReadyCleanup) window._srReadyCleanup();
        btnAgain.dataset.hostReady = '';
        btnAgain.dataset.playerReady = '';
        btnAgain.textContent = 'Play Again';
        state = null;
        if (roomCode) { try { await resetRoom(GAME_ID, roomCode); } catch (e) { showToast('Failed to reset.'); } }
        setupLobby();
      }
    } else {
      if (roomCode && playerIndex != null) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {} }
      btnAgain.dataset.playerReady = 'true';
      btnAgain.disabled = true;
      btnAgain.textContent = '✓ Ready';
      showToast('Waiting for host to start new round...');
    }
  });

  if (btnHome) btnHome.addEventListener('click', async () => {
    if (window._srReadyCleanup) window._srReadyCleanup();
    if (roomCode) {
      if (playerIndex != null) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: 'left' }); } catch (_) {} }
      if (isHost) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
      else if (playerIndex != null) { try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {} }
    }
    cleanupAndGoHome();
  });
}

function startReadyListener() {
  if (!roomCode) return;
  const btnAgain = document.getElementById('sr-btn-play-again');
  if (btnAgain && !btnAgain.dataset.hostReady && !btnAgain.dataset.playerReady) {
    btnAgain.disabled = false; btnAgain.textContent = 'Play Again';
  }
  if (window._srReadyCleanup) window._srReadyCleanup();
  const readyRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`);
  const handler = (snap) => {
    const data = snap.val() || {};
    const ready = Object.keys(data).filter((k) => data[k] === true).map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    const left = Object.keys(data).filter((k) => data[k] === 'left').map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, ready, left);
  };
  onValue(readyRef, handler);
  window._srReadyCleanup = () => { off(readyRef, 'value', handler); window._srReadyCleanup = null; };
}

/* ======= BACK BUTTONS & EMOJI PICKERS ======= */

function wireBackButtons() {
  const b1 = document.getElementById('sr-btn-back-online');
  if (b1) b1.addEventListener('click', () => { if (goHome) goHome(); });
  const b2 = document.getElementById('sr-btn-back-create');
  if (b2) b2.addEventListener('click', () => showScreen('sr-online-choice'));
  const b3 = document.getElementById('sr-btn-back-join');
  if (b3) b3.addEventListener('click', () => showScreen('sr-online-choice'));
}

function wireEmojiPicker(selector) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const btns = picker.querySelectorAll('.emoji-btn');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => { btns.forEach((b) => b.classList.remove('selected')); btn.classList.add('selected'); });
  });
}

function wireMuteToggle() {
  const toggle = document.getElementById('sr-mute-toggle');
  if (!toggle) return;
  toggle.checked = isMuted();
  toggle.addEventListener('change', () => toggleMute());
}

/* ======= SESSION RESTORATION ======= */

export async function checkSRSession() {
  const session = loadSession();
  if (!session) return false;
  try {
    const snap = await firebaseRetry(() => get(ref(db, `card-games/${GAME_ID}-rooms/${session.roomCode}`)));
    if (!snap.exists()) { clearSession(); return false; }
    const d = snap.val();
    const status = d.meta?.status;
    if (status === 'ended') { clearSession(); return false; }

    roomCode = session.roomCode; playerIndex = session.playerIndex; isHost = session.isHost;
    if (d.players) { const keys = Object.keys(d.players).sort(); playerNames = keys.map((k) => d.players[k].name || 'Unknown'); }
    try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`), { connected: true }); } catch (_) {}

    if (status === 'lobby') { setupLobby(); return true; }
    if (status === 'active' && d.game) {
      state = deserializeState(d.game, d.players);
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      if (unsubscribeRoom) unsubscribeRoom();
      unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
        onPlayersChange: (players) => { const keys = Object.keys(players).sort(); playerNames = keys.map((k) => players[k].name || 'Unknown'); },
        onStatusChange: async (s) => {
          if (s === 'lobby') { state = null; setupLobby(); }
          if (s === 'ended' && state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('sr-results'); startReadyListener(); }
        },
        onGameUpdate: (gd) => { handleRemoteUpdate(gd); },
        onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
      });
      startGame();
      return true;
    }
    clearSession(); return false;
  } catch (err) { console.warn('SR rejoin failed:', err); clearSession(); return false; }
}

/* ======= INIT ======= */

export function initSimpleRummy(showLandingPageFn) {
  goHome = showLandingPageFn;
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireBackButtons();
  wireEmojiPicker('#sr-create-room .sr-emoji-picker');
  wireEmojiPicker('#sr-join-room .sr-emoji-picker');
}
