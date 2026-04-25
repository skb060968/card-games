/**
 * Flip & Match — Main Wiring Module
 *
 * Handles all Flip & Match game flows: create/join room, lobby,
 * gameplay (flip cards, match detection, match animation), results,
 * session persistence.
 */

import { showScreen, showToast } from '../../platform-ui.js';
import {
  createGame,
  flipCard,
  checkGameEnd,
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
  animateMatch,
} from './ui.js';
import {
  announceCapture,
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
const GAME_ID = 'flip-and-match';
const FM_SESSION_KEY = 'card_games_fm_session';

/* ======= STATE ======= */
let state = null;
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let unsubscribeRoom = null;
let goHome = null;
let isProcessingFlip = false;
let _resultsShown = false;

/* ======= SESSION ======= */

function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(FM_SESSION_KEY, JSON.stringify({
        gameId: GAME_ID, roomCode, playerIndex, isHost,
      }));
    } catch (_) {}
  }
}

function clearSession() { localStorage.removeItem(FM_SESSION_KEY); }

function loadSession() {
  try {
    const r = localStorage.getItem(FM_SESSION_KEY);
    return r ? JSON.parse(r) : null;
  } catch (_) { return null; }
}

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearSession();
  roomCode = null; playerIndex = null; isHost = false;
  playerNames = []; state = null; isProcessingFlip = false;
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
  await firebaseRetry(() =>
    update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`), updates)
  );
}

/* ======= CREATE ROOM ======= */

function wireCreateRoom() {
  const btn = document.getElementById('fm-btn-create-room');
  const submit = document.getElementById('fm-btn-create-submit');

  if (btn) btn.addEventListener('click', () => showScreen('fm-create-room'));

  if (submit) submit.addEventListener('click', async () => {
    const name = document.getElementById('fm-create-name')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#fm-create-room .fm-emoji-picker');
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
  const btn = document.getElementById('fm-btn-join-room');
  const submit = document.getElementById('fm-btn-join-submit');

  if (btn) btn.addEventListener('click', () => showScreen('fm-join-room'));

  if (submit) submit.addEventListener('click', async () => {
    const code = document.getElementById('fm-room-code')?.value.trim().toUpperCase();
    const name = document.getElementById('fm-join-name')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#fm-join-room .fm-emoji-picker');
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
  showScreen('fm-lobby');
  const codeEl = document.getElementById('fm-lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;

  const btnStart = document.getElementById('fm-btn-start-online');
  const waiting = document.getElementById('fm-lobby-waiting');
  if (isHost) {
    if (btnStart) btnStart.hidden = false;
    if (waiting) waiting.hidden = true;
  } else {
    if (btnStart) btnStart.hidden = true;
    if (waiting) waiting.hidden = false;
  }

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
          const snap = await firebaseRetry(() =>
            get(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`))
          );
          if (snap.exists()) {
            const d = snap.val();
            if (d.game && d.players) {
              state = deserializeState(d.game, d.players);
              startGame();
            }
          }
        } catch (err) { console.error(err); showToast('Failed to load game.'); }
      }
      if (status === 'lobby') { state = null; setupLobby(); }
      if (status === 'ended') {
        if (state) {
          state.status = 'finished'; state.winnerIndex = null;
          renderResults(state); showScreen('fm-results');
          startReadyListener();
        }
      }
    },
    onGameUpdate: (gameData, lastMove) => { handleRemoteUpdate(gameData, lastMove); },
    onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
  });
}

function wireLobby() {
  // Share code
  const shareBtn = document.getElementById('fm-btn-share-code');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    if (!roomCode) return;
    const text = `Join my Flip & Match room! Code: ${roomCode}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Flip & Match', text, url: location.origin }); return; } catch (_) {}
    }
    try { await navigator.clipboard.writeText(`${text}\n${location.origin}`); showToast('Room code copied!'); }
    catch (_) { showToast(`Room code: ${roomCode}`); }
  });

  // Start game (host)
  const startBtn = document.getElementById('fm-btn-start-online');
  if (startBtn) startBtn.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    if (playerNames.length < 2) { showToast('Need at least 2 players'); return; }
    if (playerNames.length > 4) { showToast('Maximum 4 players'); return; }
    try {
      const snap = await firebaseRetry(() =>
        get(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players`))
      );
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
  const leaveBtn = document.getElementById('fm-btn-leave-lobby');
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    if (isHost && roomCode) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
    else if (roomCode && playerIndex != null) {
      try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {}
    }
    cleanupAndGoHome();
  });
}

/* ======= GAMEPLAY ======= */

function startGame() {
  _resultsShown = false;
  showScreen('fm-gameplay');
  const endBtn = document.getElementById('fm-btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;
  setEventMessage('');
  isProcessingFlip = false;
  renderUI();
}

function renderUI() {
  if (!state) return;
  renderGameplay(state, playerIndex, handleFlip);
}

/* ======= FLIP HANDLING ======= */

async function handleFlip(cardIndex) {
  if (!state || state.status !== 'playing' || isProcessingFlip) return;
  if (state.currentPlayerIndex !== playerIndex) return;
  isProcessingFlip = true;

  warmSpeech();

  try {
    const { newState, matched, matchedIndex } = flipCard(state, cardIndex, playerIndex);

    const validation = validateState(newState);
    if (!validation.valid) {
      showToast(`Error: ${validation.error}`);
      isProcessingFlip = false;
      return;
    }

    // Check game end
    const endResult = checkGameEnd(newState);
    let stateToWrite;
    if (endResult.finished) {
      stateToWrite = {
        ...newState,
        status: 'finished',
        winnerIndex: endResult.winnerIndex,
        isTie: endResult.isTie,
        tiedIndices: endResult.tiedIndices,
      };
    } else {
      stateToWrite = newState;
    }

    const flippedCard = state.board[cardIndex].card;

    const lastMove = {
      playerIndex,
      cardIndex,
      card: `${flippedCard.rank}${flippedCard.suit}`,
      matched,
      matchedIndex: matchedIndex != null ? matchedIndex : null,
      timestamp: Date.now(),
    };

    // Write to Firebase
    try {
      await writeFullState(stateToWrite, lastMove);
    } catch (err) {
      console.error('Failed to write flip:', err);
      showToast('Failed to sync move. Try again.');
      isProcessingFlip = false;
      return;
    }

    // Sound: flip
    playSound('throw');

    if (matched) {
      const currentPlayer = state.players[playerIndex];
      const rank = flippedCard.rank;
      setEventMessage(`${currentPlayer.emoji} ${currentPlayer.name} matched ${rank}s!`);

      // Show the flipped card face-up before animation
      // Temporarily update board to show both cards face-up for animation
      const tempBoard = state.board.map((s, i) => {
        if (i === cardIndex) return { ...s, state: 'up' };
        return { ...s };
      });
      const tempState = { ...state, board: tempBoard };
      renderGameplay(tempState, playerIndex, handleFlip);

      // Sound: capture
      playSound('capture');
      announceCapture(currentPlayer.name);

      // Animate match (rise + glow + sweep)
      await animateMatch(cardIndex, matchedIndex, playerIndex, playerIndex);

      // Small delay so all players can see what happened
      await new Promise((r) => setTimeout(r, 500));

      state = stateToWrite;

      if (endResult.finished) {
        handleWin();
        return;
      }

      renderUI();
    } else {
      setEventMessage('No match — card stays face-up');
      state = stateToWrite;

      if (endResult.finished) {
        handleWin();
        return;
      }

      renderUI();
    }
  } catch (err) {
    console.error('Flip failed:', err);
    showToast(err.message || 'Flip failed');
  } finally {
    isProcessingFlip = false;
  }
}

/* ======= WIN HANDLING ======= */

async function handleWin() {
  if (_resultsShown) { renderResults(state); showScreen('fm-results'); return; }
  _resultsShown = true;

  if (state.winnerIndex != null && !state.isTie) {
    const winner = state.players[state.winnerIndex];
    await announceWin(winner.name);
    if (typeof confetti === 'function') {
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
    coinRain();
  }

  renderResults(state);
  showScreen('fm-results');
  startReadyListener();
}

/* ======= REMOTE UPDATES ======= */

async function handleRemoteUpdate(gameData, lastMove) {
  if (!gameData || !roomCode) return;
  if (isProcessingFlip) return;

  const playersData = {};
  playerNames.forEach((name, i) => {
    playersData[`player_${i}`] = {
      name,
      emoji: state ? state.players[i]?.emoji || '😀' : '😀',
    };
  });

  const newState = deserializeState(gameData, playersData);

  // Detect remote flip
  if (lastMove && lastMove.playerIndex !== playerIndex) {
    isProcessingFlip = true;

    playSound('throw');

    if (lastMove.matched) {
      const flipper = newState.players[lastMove.playerIndex];

      // Show the board state before collection (both cards face-up) for animation
      // Build a temp state where both matched cards are still face-up
      const prevBoard = state ? [...state.board] : [];
      if (prevBoard.length > 0 && lastMove.cardIndex < prevBoard.length) {
        // Show the flipped card as face-up
        const tempBoard = prevBoard.map((s, i) => {
          if (i === lastMove.cardIndex) return { ...s, state: 'up' };
          return { ...s };
        });
        const tempState = { ...state, board: tempBoard, players: newState.players };
        renderGameplay(tempState, playerIndex, handleFlip);
      }

      playSound('capture');
      if (flipper) {
        announceCapture(flipper.name);
        setEventMessage(`${flipper.emoji} ${flipper.name} matched!`);
      }

      // Animate match for remote player
      await animateMatch(
        lastMove.cardIndex,
        lastMove.matchedIndex,
        lastMove.playerIndex,
        playerIndex
      );

      // Small delay
      await new Promise((r) => setTimeout(r, 500));

      state = newState;

      if (state.status === 'finished') {
        isProcessingFlip = false;
        handleWin();
        return;
      }

      renderUI();
      isProcessingFlip = false;
      return;
    } else {
      setEventMessage('No match — card stays face-up');
    }

    state = newState;

    if (state.status === 'finished') {
      isProcessingFlip = false;
      handleWin();
      return;
    }

    renderUI();
    isProcessingFlip = false;
    return;
  }

  // Generic update
  state = newState;

  if (state.status === 'finished') {
    handleWin();
    return;
  }

  renderUI();
  isProcessingFlip = false;
}

/* ======= END GAME ======= */

function wireEndGame() {
  const btn = document.getElementById('fm-btn-end-game');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state) return;
    state.status = 'finished'; state.winnerIndex = null;
    if (roomCode) { try { await endRoom(GAME_ID, roomCode); } catch (_) {} }
    renderResults(state);
    showScreen('fm-results');
    startReadyListener();
  });
}

/* ======= RESULTS & PLAY AGAIN ======= */

function wireResults() {
  const btnAgain = document.getElementById('fm-btn-play-again');
  const btnHome = document.getElementById('fm-btn-home');

  if (btnAgain) btnAgain.addEventListener('click', async () => {
    if (isHost) {
      if (!btnAgain.dataset.hostReady) {
        btnAgain.dataset.hostReady = 'true';
        btnAgain.textContent = '▶ Start New Round';
        if (roomCode) {
          try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {}
        }
      } else {
        if (window._fmReadyCleanup) window._fmReadyCleanup();
        btnAgain.dataset.hostReady = '';
        btnAgain.dataset.playerReady = '';
        btnAgain.textContent = 'Play Again';
        state = null;
        if (roomCode) {
          try { await resetRoom(GAME_ID, roomCode); } catch (e) { showToast('Failed to reset.'); }
        }
        setupLobby();
      }
    } else {
      if (roomCode && playerIndex != null) {
        try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {}
      }
      btnAgain.dataset.playerReady = 'true';
      btnAgain.disabled = true;
      btnAgain.textContent = '✓ Ready';
      showToast('Waiting for host to start new round...');
    }
  });

  if (btnHome) btnHome.addEventListener('click', async () => {
    if (window._fmReadyCleanup) window._fmReadyCleanup();
    if (roomCode) {
      if (playerIndex != null) {
        try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: 'left' }); } catch (_) {}
      }
      if (isHost) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
      else if (playerIndex != null) {
        try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {}
      }
    }
    cleanupAndGoHome();
  });
}

function startReadyListener() {
  if (!roomCode) return;
  const btnAgain = document.getElementById('fm-btn-play-again');
  if (btnAgain && !btnAgain.dataset.hostReady && !btnAgain.dataset.playerReady) {
    btnAgain.disabled = false; btnAgain.textContent = 'Play Again';
  }
  if (window._fmReadyCleanup) window._fmReadyCleanup();
  const readyRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`);
  const handler = (snap) => {
    const data = snap.val() || {};
    const ready = Object.keys(data).filter((k) => data[k] === true)
      .map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    const left = Object.keys(data).filter((k) => data[k] === 'left')
      .map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, ready, left);
  };
  onValue(readyRef, handler);
  window._fmReadyCleanup = () => { off(readyRef, 'value', handler); window._fmReadyCleanup = null; };
}

/* ======= BACK BUTTONS & EMOJI PICKERS ======= */

function wireBackButtons() {
  const b1 = document.getElementById('fm-btn-back-online');
  if (b1) b1.addEventListener('click', () => { if (goHome) goHome(); });
  const b2 = document.getElementById('fm-btn-back-create');
  if (b2) b2.addEventListener('click', () => showScreen('fm-online-choice'));
  const b3 = document.getElementById('fm-btn-back-join');
  if (b3) b3.addEventListener('click', () => showScreen('fm-online-choice'));
}

function wireEmojiPicker(selector) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const btns = picker.querySelectorAll('.emoji-btn');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      btns.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

function wireMuteToggle() {
  const toggle = document.getElementById('fm-mute-toggle');
  if (!toggle) return;
  toggle.checked = isMuted();
  toggle.addEventListener('change', () => toggleMute());
}

/* ======= SESSION RESTORATION ======= */

export async function checkFMSession() {
  const session = loadSession();
  if (!session) return false;
  try {
    const snap = await firebaseRetry(() =>
      get(ref(db, `card-games/${GAME_ID}-rooms/${session.roomCode}`))
    );
    if (!snap.exists()) { clearSession(); return false; }
    const d = snap.val();
    const status = d.meta?.status;
    if (status === 'ended') { clearSession(); return false; }

    roomCode = session.roomCode; playerIndex = session.playerIndex; isHost = session.isHost;
    if (d.players) {
      const keys = Object.keys(d.players).sort();
      playerNames = keys.map((k) => d.players[k].name || 'Unknown');
    }
    try {
      await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`), { connected: true });
    } catch (_) {}

    if (status === 'lobby') { setupLobby(); return true; }
    if (status === 'active' && d.game) {
      state = deserializeState(d.game, d.players);
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      if (unsubscribeRoom) unsubscribeRoom();
      unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
        onPlayersChange: (players) => {
          const keys = Object.keys(players).sort();
          playerNames = keys.map((k) => players[k].name || 'Unknown');
        },
        onStatusChange: async (s) => {
          if (s === 'lobby') { state = null; setupLobby(); }
          if (s === 'ended' && state) {
            state.status = 'finished'; state.winnerIndex = null;
            renderResults(state); showScreen('fm-results');
            startReadyListener();
          }
        },
        onGameUpdate: (gd, lm) => { handleRemoteUpdate(gd, lm); },
        onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
      });
      startGame();
      return true;
    }
    clearSession(); return false;
  } catch (err) { console.warn('FM rejoin failed:', err); clearSession(); return false; }
}

/* ======= INIT ======= */

export function initFlipMatch(showLandingPageFn) {
  goHome = showLandingPageFn;
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireBackButtons();
  wireEmojiPicker('#fm-create-room .fm-emoji-picker');
  wireEmojiPicker('#fm-join-room .fm-emoji-picker');
}
