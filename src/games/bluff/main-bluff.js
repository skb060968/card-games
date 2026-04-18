/**
 * Bluff — Main Wiring Module
 *
 * Handles all Bluff game flows: create/join room, lobby,
 * gameplay (place cards, challenge, timer), results, session persistence.
 */

import { showScreen, showToast } from '../../platform-ui.js';
import {
  createGame,
  placeCards,
  resolveChallenge,
  expireChallenge,
  validateState,
  serializeState,
  deserializeState,
} from './engine.js';
import {
  renderGameplay,
  renderChallengeWindow,
  hideChallengeWindow,
  renderRankSelector,
  hideRankSelector,
  renderChallengeResult,
  renderResults,
  renderLobbyPlayers,
  renderReadyIndicators,
  setEventMessage,
  clearSelection,
  getSelectedIndices,
} from './ui.js';
import {
  announceWin,
  initAudio,
  toggleMute,
  isMuted,
  warmSpeech,
  playSound,
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

/* ======= CONSTANTS ======= */
const GAME_ID = 'bluff';
const BL_SESSION_KEY = 'card_games_bluff_session';
const CHALLENGE_WINDOW_MS = 10000;

/* ======= STATE ======= */
let state = null;
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let unsubscribeRoom = null;
let goHome = null;
let _challengeTimer = null;
let _challengeCountdownInterval = null;

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(BL_SESSION_KEY, JSON.stringify({ gameId: GAME_ID, roomCode, playerIndex, isHost }));
    } catch (_) {}
  }
}
function clearSession() { localStorage.removeItem(BL_SESSION_KEY); }
function loadSession() {
  try { const r = localStorage.getItem(BL_SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
}

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearChallengeTimers();
  clearSession();
  roomCode = null; playerIndex = null; isHost = false; playerNames = []; state = null;
  if (goHome) goHome();
}

/* ======= CHALLENGE TIMER HELPERS ======= */

function clearChallengeTimers() {
  if (_challengeTimer) { clearTimeout(_challengeTimer); _challengeTimer = null; }
  if (_challengeCountdownInterval) { clearInterval(_challengeCountdownInterval); _challengeCountdownInterval = null; }
}

/**
 * Starts the challenge countdown UI and host expiry timer.
 */
function startChallengeCountdown() {
  clearChallengeTimers();

  if (!state || state.phase !== 'challengeWindow' || !state.challengeDeadline) return;

  const deadline = state.challengeDeadline;
  const canChallenge = state.lastPlacement && state.lastPlacement.playerIndex !== playerIndex;
  const lp = state.lastPlacement;
  const placer = state.players[lp.playerIndex];
  const announcement = `${placer.emoji} ${placer.name} placed ${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`;

  // Announce placement via speech
  speak(`${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);

  // Initial render
  const remaining = Math.max(0, deadline - Date.now());
  renderChallengeWindow(remaining, canChallenge, handleChallenge, announcement);

  // Update countdown every 200ms
  _challengeCountdownInterval = setInterval(() => {
    const rem = Math.max(0, deadline - Date.now());
    renderChallengeWindow(rem, canChallenge, handleChallenge, announcement);
    if (rem <= 0) {
      clearInterval(_challengeCountdownInterval);
      _challengeCountdownInterval = null;
    }
  }, 200);

  // Host expires the challenge
  if (isHost) {
    const delay = Math.max(0, deadline - Date.now());
    _challengeTimer = setTimeout(async () => {
      _challengeTimer = null;
      if (!state || state.phase !== 'challengeWindow') return;
      try {
        const newState = expireChallenge(state);
        state = newState;
        hideChallengeWindow();
        clearChallengeTimers();

        await writeFullState(state, { playerIndex: lp.playerIndex, action: 'expire', timestamp: Date.now() });

        if (state.status === 'finished') {
          handleWin();
        } else {
          clearSelection();
          renderUI();
        }
      } catch (err) {
        console.error('Challenge expiry failed:', err);
        showToast('Failed to advance turn.');
      }
    }, delay + 500); // small buffer to ensure deadline has passed
  }
}

/* ======= SPEECH HELPER ======= */

function speak(text) {
  if (isMuted()) return;
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    speechSynthesis.speak(utterance);
  } catch (_) {}
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
  const btn = document.getElementById('bl-btn-create-room');
  const submit = document.getElementById('bl-btn-create-submit');

  if (btn) btn.addEventListener('click', () => showScreen('bl-create-room'));

  if (submit) submit.addEventListener('click', async () => {
    const name = document.getElementById('bl-create-name')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#bl-create-room .bl-emoji-picker');
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
  const btn = document.getElementById('bl-btn-join-room');
  const submit = document.getElementById('bl-btn-join-submit');

  if (btn) btn.addEventListener('click', () => showScreen('bl-join-room'));

  if (submit) submit.addEventListener('click', async () => {
    const code = document.getElementById('bl-room-code')?.value.trim().toUpperCase();
    const name = document.getElementById('bl-join-name')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#bl-join-room .bl-emoji-picker');
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
  showScreen('bl-lobby');
  const codeEl = document.getElementById('bl-lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;

  const btnStart = document.getElementById('bl-btn-start-online');
  const waiting = document.getElementById('bl-lobby-waiting');
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
      if (status === 'lobby') { state = null; clearChallengeTimers(); setupLobby(); }
      if (status === 'ended') {
        clearChallengeTimers();
        if (state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('bl-results'); startReadyListener(); }
      }
    },
    onGameUpdate: (gameData, lastMove) => { handleRemoteUpdate(gameData, lastMove); },
    onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
  });
}

function wireLobby() {
  // Share code
  const shareBtn = document.getElementById('bl-btn-share-code');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    if (!roomCode) return;
    const text = `Join my Bluff room! Code: ${roomCode}`;
    if (navigator.share) { try { await navigator.share({ title: 'Bluff', text, url: location.origin }); return; } catch (_) {} }
    try { await navigator.clipboard.writeText(`${text}\n${location.origin}`); showToast('Room code copied!'); } catch (_) { showToast(`Room code: ${roomCode}`); }
  });

  // Start game (host)
  const startBtn = document.getElementById('bl-btn-start-online');
  if (startBtn) startBtn.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    if (playerNames.length < 2) { showToast('Need at least 2 players'); return; }
    if (playerNames.length > 4) { showToast('Maximum 4 players for Bluff'); return; }
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
  const leaveBtn = document.getElementById('bl-btn-leave-lobby');
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    if (isHost && roomCode) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
    else if (roomCode && playerIndex != null) { try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {} }
    cleanupAndGoHome();
  });
}

/* ======= GAMEPLAY ======= */

function startGame() {
  showScreen('bl-gameplay');
  const endBtn = document.getElementById('bl-btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;
  hideChallengeWindow();
  hideRankSelector();
  clearSelection();
  setEventMessage('');
  renderUI();

  // If rejoining mid-challenge, start the countdown
  if (state && state.phase === 'challengeWindow' && state.challengeDeadline) {
    const remaining = state.challengeDeadline - Date.now();
    if (remaining > 0) {
      startChallengeCountdown();
    } else if (isHost) {
      // Deadline already passed, host should expire
      handleChallengeExpiry();
    }
  }
}

function renderUI() {
  if (!state) return;
  renderGameplay(state, playerIndex, {
    onPlaceCards: (indices) => handlePlacement(indices),
    onChallenge: () => handleChallenge(),
  });
}

/* ======= PLACEMENT ======= */

async function handlePlacement(cardIndices) {
  if (!state || state.phase !== 'placing') return;
  if (state.currentPlayerIndex !== playerIndex) return;

  warmSpeech();

  // Show rank selector
  renderRankSelector(async (declaredRank) => {
    try {
      const newState = placeCards(state, cardIndices, declaredRank);

      const validation = validateState(newState);
      if (!validation.valid) {
        showToast(`Error: ${validation.error}`);
        return;
      }

      state = newState;
      clearSelection();

      playSound('throw');

      const lp = state.lastPlacement;
      const lastMove = {
        playerIndex,
        action: 'place',
        declaredRank: lp.declaredRank,
        count: lp.count,
        timestamp: Date.now(),
      };

      await writeFullState(state, lastMove);

      setEventMessage(`You placed ${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
      renderUI();
      startChallengeCountdown();
    } catch (err) {
      console.error('Placement failed:', err);
      showToast(err.message || 'Placement failed');
    }
  });
}

/* ======= CHALLENGE ======= */

async function handleChallenge() {
  if (!state || state.phase !== 'challengeWindow') return;
  if (!state.lastPlacement || state.lastPlacement.playerIndex === playerIndex) return;

  warmSpeech();
  clearChallengeTimers();

  try {
    const { newState, bluffCaught, revealedCards } = resolveChallenge(state, playerIndex);

    const validation = validateState(newState);
    if (!validation.valid) {
      showToast(`Error: ${validation.error}`);
      return;
    }

    // Announce
    speak('Bluff called!');

    const loserIndex = bluffCaught ? state.lastPlacement.playerIndex : playerIndex;
    const loserName = state.players[loserIndex].name;

    state = newState;

    const lastMove = {
      playerIndex,
      action: 'challenge',
      bluffCaught,
      loserIndex,
      timestamp: Date.now(),
    };

    await writeFullState(state, lastMove);

    hideChallengeWindow();

    // Show result overlay
    await renderChallengeResult(revealedCards, state.lastPlacement ? state.lastPlacement.declaredRank : '', bluffCaught, loserName);

    // Announce outcome
    if (bluffCaught) {
      speak(`${state.players[loserIndex].name} caught bluffing!`);
      setEventMessage(`🚨 ${state.players[loserIndex].name} caught bluffing! Takes the pile.`);
    } else {
      speak(`${loserName} was truthful!`);
      setEventMessage(`✅ Was truthful! ${loserName} takes the pile.`);
    }

    clearSelection();
    renderUI();
  } catch (err) {
    console.error('Challenge failed:', err);
    showToast(err.message || 'Challenge failed');
  }
}

async function handleChallengeExpiry() {
  if (!state || state.phase !== 'challengeWindow') return;
  clearChallengeTimers();

  try {
    const lp = state.lastPlacement;
    const newState = expireChallenge(state);
    state = newState;
    hideChallengeWindow();

    await writeFullState(state, { playerIndex: lp ? lp.playerIndex : 0, action: 'expire', timestamp: Date.now() });

    if (state.status === 'finished') {
      handleWin();
    } else {
      clearSelection();
      renderUI();
    }
  } catch (err) {
    console.error('Challenge expiry failed:', err);
    showToast('Failed to advance turn.');
  }
}

/* ======= WIN HANDLING ======= */

async function handleWin() {
  clearChallengeTimers();
  hideChallengeWindow();

  if (state.winnerIndex != null) {
    const winner = state.players[state.winnerIndex];
    await announceWin(winner.name);
    if (typeof confetti === 'function') {
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
  }

  renderResults(state);
  showScreen('bl-results');
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

  // Detect challenge resolution from remote
  if (lastMove && lastMove.action === 'challenge' && lastMove.playerIndex !== playerIndex) {
    clearChallengeTimers();
    hideChallengeWindow();

    const oldLastPlacement = state ? state.lastPlacement : null;
    const revealedCards = oldLastPlacement ? oldLastPlacement.actualCards : [];
    const declaredRank = oldLastPlacement ? oldLastPlacement.declaredRank : '';
    const bluffCaught = lastMove.bluffCaught;
    const loserName = state && lastMove.loserIndex != null ? state.players[lastMove.loserIndex]?.name || 'Player' : 'Player';

    state = newState;

    speak('Bluff called!');

    renderChallengeResult(revealedCards, declaredRank, bluffCaught, loserName).then(() => {
      if (bluffCaught) {
        speak(`${loserName} caught bluffing!`);
        setEventMessage(`🚨 ${loserName} caught bluffing! Takes the pile.`);
      } else {
        speak(`${loserName} was truthful!`);
        setEventMessage(`✅ Was truthful! ${loserName} takes the pile.`);
      }
      clearSelection();
      renderUI();
    });
    return;
  }

  // Detect challenge expiry from remote
  if (lastMove && lastMove.action === 'expire') {
    clearChallengeTimers();
    hideChallengeWindow();
    state = newState;

    if (state.status === 'finished') {
      handleWin();
      return;
    }

    setEventMessage('No challenge — turn advances.');
    clearSelection();
    renderUI();
    return;
  }

  // Detect placement from remote (another player placed cards)
  if (lastMove && lastMove.action === 'place' && lastMove.playerIndex !== playerIndex) {
    state = newState;
    clearSelection();
    playSound('throw');
    renderUI();

    // Small delay before starting challenge countdown for remote animations
    setTimeout(() => {
      // Start challenge countdown for this client
      if (state.phase === 'challengeWindow' && state.challengeDeadline) {
        const remaining = state.challengeDeadline - Date.now();
        if (remaining > 0) {
          startChallengeCountdown();
        }
      }
    }, 300);
    return;
  }

  // Generic update
  state = newState;

  if (state.status === 'finished' || state.phase === 'finished') {
    state.status = 'finished';
    handleWin();
    return;
  }

  // If in challenge window, ensure countdown is running
  if (state.phase === 'challengeWindow' && state.challengeDeadline) {
    const remaining = state.challengeDeadline - Date.now();
    if (remaining > 0 && !_challengeCountdownInterval) {
      startChallengeCountdown();
    }
  } else {
    clearChallengeTimers();
    hideChallengeWindow();
  }

  clearSelection();
  renderUI();
}

/* ======= END GAME ======= */

function wireEndGame() {
  const btn = document.getElementById('bl-btn-end-game');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state) return;
    clearChallengeTimers();
    hideChallengeWindow();
    state.status = 'finished'; state.winnerIndex = null;
    if (roomCode) { try { await endRoom(GAME_ID, roomCode); } catch (_) {} }
    renderResults(state);
    showScreen('bl-results');
    startReadyListener();
  });
}

/* ======= RESULTS & PLAY AGAIN ======= */

function wireResults() {
  const btnAgain = document.getElementById('bl-btn-play-again');
  const btnHome = document.getElementById('bl-btn-home');

  if (btnAgain) btnAgain.addEventListener('click', async () => {
    if (isHost) {
      if (!btnAgain.dataset.hostReady) {
        btnAgain.dataset.hostReady = 'true';
        btnAgain.textContent = '▶ Start New Round';
        if (roomCode) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {} }
      } else {
        if (window._blReadyCleanup) window._blReadyCleanup();
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
    if (window._blReadyCleanup) window._blReadyCleanup();
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
  const btnAgain = document.getElementById('bl-btn-play-again');
  if (btnAgain && !btnAgain.dataset.hostReady && !btnAgain.dataset.playerReady) {
    btnAgain.disabled = false; btnAgain.textContent = 'Play Again';
  }
  if (window._blReadyCleanup) window._blReadyCleanup();
  const readyRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`);
  const handler = (snap) => {
    const data = snap.val() || {};
    const ready = Object.keys(data).filter((k) => data[k] === true).map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    const left = Object.keys(data).filter((k) => data[k] === 'left').map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, ready, left);
  };
  onValue(readyRef, handler);
  window._blReadyCleanup = () => { off(readyRef, 'value', handler); window._blReadyCleanup = null; };
}

/* ======= BACK BUTTONS & EMOJI PICKERS ======= */

function wireBackButtons() {
  const b1 = document.getElementById('bl-btn-back-online');
  if (b1) b1.addEventListener('click', () => { if (goHome) goHome(); });
  const b2 = document.getElementById('bl-btn-back-create');
  if (b2) b2.addEventListener('click', () => showScreen('bl-online-choice'));
  const b3 = document.getElementById('bl-btn-back-join');
  if (b3) b3.addEventListener('click', () => showScreen('bl-online-choice'));
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
  const toggle = document.getElementById('bl-mute-toggle');
  if (!toggle) return;
  toggle.checked = isMuted();
  toggle.addEventListener('change', () => toggleMute());
}

/* ======= SESSION RESTORATION ======= */

export async function checkBluffSession() {
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
          if (s === 'lobby') { state = null; clearChallengeTimers(); setupLobby(); }
          if (s === 'ended' && state) { clearChallengeTimers(); state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('bl-results'); startReadyListener(); }
        },
        onGameUpdate: (gd, lm) => { handleRemoteUpdate(gd, lm); },
        onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
      });
      startGame();
      return true;
    }
    clearSession(); return false;
  } catch (err) { console.warn('Bluff rejoin failed:', err); clearSession(); return false; }
}

/* ======= INIT ======= */

export function initBluff(showLandingPageFn) {
  goHome = showLandingPageFn;
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireBackButtons();
  wireEmojiPicker('#bl-create-room .bl-emoji-picker');
  wireEmojiPicker('#bl-join-room .bl-emoji-picker');
}
