/**
 * Poker — Main Wiring Module
 *
 * Handles all Poker game flows: create/join room, lobby,
 * gameplay (betting actions, show, fold), results, session persistence.
 */

import { showScreen, showToast } from '../../platform-ui.js';
import {
  createGame,
  performAction,
  evaluateHand,
  validateState,
  serializeState,
  deserializeState,
} from './engine.js';
import {
  renderGameplay,
  renderResults,
  renderLobbyPlayers,
  renderReadyIndicators,
  setEventMessage,
} from './ui.js';
import {
  announceWin,
  toggleMute,
  isMuted,
  warmSpeech,
  playSound,
} from '../../shared/voice-announcer.js';
import { coinRain } from '../../shared/win-pot-calculator.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  setupDisconnectHandler,
  endRoom,
  deleteRoom,
  resetRoom,
  firebaseRetry,
} from '../../shared/firebase-sync.js';
import { db } from '../../shared/firebase-config.js';
import { ref, get, update, remove, onValue, off } from 'firebase/database';

/* ======= CONSTANTS ======= */
const GAME_ID = 'poker';
const PK_SESSION_KEY = 'card_games_pk_session';

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
      localStorage.setItem(PK_SESSION_KEY, JSON.stringify({ gameId: GAME_ID, roomCode, playerIndex, isHost }));
    } catch (_) {}
  }
}
function clearSession() { localStorage.removeItem(PK_SESSION_KEY); }
function loadSession() {
  try { const r = localStorage.getItem(PK_SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
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
  if (stateToWrite.status === 'betting') updates['meta/status'] = 'active';
  await firebaseRetry(() => update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`), updates));
}

/* ======= CREATE ROOM ======= */

function wireCreateRoom() {
  const btn = document.getElementById('pk-btn-create-room');
  const submit = document.getElementById('pk-btn-create-submit');

  if (btn) btn.addEventListener('click', () => showScreen('pk-create-room'));

  if (submit) submit.addEventListener('click', async () => {
    const name = document.getElementById('pk-create-name')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#pk-create-room .pk-emoji-picker');
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
  const btn = document.getElementById('pk-btn-join-room');
  const submit = document.getElementById('pk-btn-join-submit');

  if (btn) btn.addEventListener('click', () => showScreen('pk-join-room'));

  if (submit) submit.addEventListener('click', async () => {
    const code = document.getElementById('pk-room-code')?.value.trim().toUpperCase();
    const name = document.getElementById('pk-join-name')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#pk-join-room .pk-emoji-picker');
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
  showScreen('pk-lobby');
  const codeEl = document.getElementById('pk-lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;

  const btnStart = document.getElementById('pk-btn-start-online');
  const waiting = document.getElementById('pk-lobby-waiting');
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
        if (state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('pk-results'); startReadyListener(); }
      }
    },
    onGameUpdate: (gameData, lastMove) => { handleRemoteUpdate(gameData, lastMove); },
    onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
  });
}

function wireLobby() {
  // Share code
  const shareBtn = document.getElementById('pk-btn-share-code');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    if (!roomCode) return;
    const text = `Join my Poker room! Code: ${roomCode}`;
    if (navigator.share) { try { await navigator.share({ title: 'Poker', text, url: location.origin }); return; } catch (_) {} }
    try { await navigator.clipboard.writeText(`${text}\n${location.origin}`); showToast('Room code copied!'); } catch (_) { showToast(`Room code: ${roomCode}`); }
  });

  // Start game (host)
  const startBtn = document.getElementById('pk-btn-start-online');
  if (startBtn) startBtn.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    if (playerNames.length < 2) { showToast('Need at least 2 players'); return; }
    if (playerNames.length > 4) { showToast('Maximum 4 players for Poker'); return; }
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
  const leaveBtn = document.getElementById('pk-btn-leave-lobby');
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    if (isHost && roomCode) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
    else if (roomCode && playerIndex != null) { try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {} }
    cleanupAndGoHome();
  });
}

/* ======= GAMEPLAY ======= */

function startGame() {
  showScreen('pk-gameplay');
  const endBtn = document.getElementById('pk-btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;
  setEventMessage('');
  renderUI();
}

function renderUI() {
  if (!state) return;
  renderGameplay(state, playerIndex, {
    onAction: (action) => handleAction(action),
  });
}

/* ======= ACTION HANDLING ======= */

async function handleAction(action) {
  if (!state || state.status !== 'betting') return;
  if (state.currentPlayerIndex !== playerIndex) return;

  warmSpeech();

  try {
    const newState = performAction(state, playerIndex, action);

    const validation = validateState(newState);
    if (!validation.valid) {
      showToast(`Error: ${validation.error}`);
      return;
    }

    state = newState;

    const lastMove = {
      playerIndex,
      action: action.type,
      timestamp: Date.now(),
    };

    await writeFullState(state, lastMove);

    // Event messages
    const player = state.players[playerIndex];
    switch (action.type) {
      case 'bet':
        playSound('throw');
        setEventMessage(`You bet 10 chips`);
        break;
      case 'raise':
        playSound('throw');
        setEventMessage(`You raised`);
        break;
      case 'call':
        playSound('throw');
        setEventMessage(`You called`);
        break;
      case 'fold':
        setEventMessage(`You folded`);
        break;
      case 'show':
        playSound('capture');
        setEventMessage(`Showdown!`);
        break;
    }

    // Check if game ended
    if (state.status === 'finished') {
      handleWin(action.type === 'fold' || action.type !== 'show');
      return;
    }

    renderUI();
  } catch (err) {
    console.error('Action failed:', err);
    showToast(err.message || 'Action failed');
  }
}

/* ======= WIN HANDLING ======= */

async function handleWin(isFoldWin = false) {
  if (state.winnerIndex != null) {
    const winner = state.players[state.winnerIndex];
    await announceWin(winner.name);
    if (typeof confetti === 'function') {
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
    coinRain();
  }

  renderResults(state, isFoldWin);
  showScreen('pk-results');
  startReadyListener();
}

/* ======= REMOTE UPDATES ======= */

function handleRemoteUpdate(gameData, lastMove) {
  if (!gameData || !roomCode) return;

  const playersData = {};
  playerNames.forEach((name, i) => {
    playersData[`player_${i}`] = {
      name,
      emoji: state ? state.players[i]?.emoji || '😀' : '😀',
    };
  });

  const newState = deserializeState(gameData, playersData);

  // Detect remote action
  if (lastMove && lastMove.playerIndex !== playerIndex) {
    const actorName = state ? state.players[lastMove.playerIndex]?.name || 'Opponent' : 'Opponent';
    const actorEmoji = state ? state.players[lastMove.playerIndex]?.emoji || '' : '';

    switch (lastMove.action) {
      case 'bet':
        playSound('throw');
        setEventMessage(`${actorEmoji} ${actorName} bet 10 chips`);
        break;
      case 'raise':
        playSound('throw');
        setEventMessage(`${actorEmoji} ${actorName} raised`);
        break;
      case 'call':
        playSound('throw');
        setEventMessage(`${actorEmoji} ${actorName} called`);
        break;
      case 'fold':
        setEventMessage(`${actorEmoji} ${actorName} folded`);
        break;
      case 'show':
        playSound('capture');
        setEventMessage(`${actorEmoji} ${actorName} called Show!`);
        break;
    }
  }

  state = newState;

  if (state.status === 'finished') {
    const isFoldWin = lastMove && lastMove.action === 'fold';
    handleWin(isFoldWin);
    return;
  }

  renderUI();
}

/* ======= END GAME ======= */

function wireEndGame() {
  const btn = document.getElementById('pk-btn-end-game');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state) return;
    state.status = 'finished'; state.winnerIndex = null;
    if (roomCode) { try { await endRoom(GAME_ID, roomCode); } catch (_) {} }
    renderResults(state);
    showScreen('pk-results');
    startReadyListener();
  });
}

/* ======= RESULTS & PLAY AGAIN ======= */

function wireResults() {
  const btnAgain = document.getElementById('pk-btn-play-again');
  const btnHome = document.getElementById('pk-btn-home');

  if (btnAgain) btnAgain.addEventListener('click', async () => {
    if (isHost) {
      if (!btnAgain.dataset.hostReady) {
        btnAgain.dataset.hostReady = 'true';
        btnAgain.textContent = '▶ Start New Round';
        if (roomCode) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {} }
      } else {
        if (window._pkReadyCleanup) window._pkReadyCleanup();
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
    if (window._pkReadyCleanup) window._pkReadyCleanup();
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
  const btnAgain = document.getElementById('pk-btn-play-again');
  if (btnAgain && !btnAgain.dataset.hostReady && !btnAgain.dataset.playerReady) {
    btnAgain.disabled = false; btnAgain.textContent = 'Play Again';
  }
  if (window._pkReadyCleanup) window._pkReadyCleanup();
  const readyRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`);
  const handler = (snap) => {
    const data = snap.val() || {};
    const ready = Object.keys(data).filter((k) => data[k] === true).map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    const left = Object.keys(data).filter((k) => data[k] === 'left').map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, ready, left);
  };
  onValue(readyRef, handler);
  window._pkReadyCleanup = () => { off(readyRef, 'value', handler); window._pkReadyCleanup = null; };
}

/* ======= BACK BUTTONS & EMOJI PICKERS ======= */

function wireBackButtons() {
  const b1 = document.getElementById('pk-btn-back-online');
  if (b1) b1.addEventListener('click', () => { if (goHome) goHome(); });
  const b2 = document.getElementById('pk-btn-back-create');
  if (b2) b2.addEventListener('click', () => showScreen('pk-online-choice'));
  const b3 = document.getElementById('pk-btn-back-join');
  if (b3) b3.addEventListener('click', () => showScreen('pk-online-choice'));
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
  const toggle = document.getElementById('pk-mute-toggle');
  if (!toggle) return;
  toggle.checked = isMuted();
  toggle.addEventListener('change', () => toggleMute());
}

/* ======= SESSION RESTORATION ======= */

export async function checkPKSession() {
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
          if (s === 'ended' && state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('pk-results'); startReadyListener(); }
        },
        onGameUpdate: (gd, lm) => { handleRemoteUpdate(gd, lm); },
        onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
      });
      startGame();
      return true;
    }
    clearSession(); return false;
  } catch (err) { console.warn('Poker rejoin failed:', err); clearSession(); return false; }
}

/* ======= INIT ======= */

export function initPoker(showLandingPageFn) {
  goHome = showLandingPageFn;
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireBackButtons();
  wireEmojiPicker('#pk-create-room .pk-emoji-picker');
  wireEmojiPicker('#pk-join-room .pk-emoji-picker');
}
