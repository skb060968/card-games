/**
 * Bluff — Main Wiring Module
 *
 * Handles all Bluff game flows: create/join room, lobby,
 * gameplay (place cards, challenge), results, session persistence.
 * Includes card animations, reorder support, and placement overlay.
 * No timer — Bluff button is available until the next player acts.
 */

import { showScreen, showToast } from '../../platform-ui.js';
import {
  createGame,
  placeCards,
  passCard,
  resolveChallenge,
  validateState,
  serializeState,
  deserializeState,
} from './engine.js';
import {
  renderGameplay,
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
import { renderCardBack } from '../../shared/card-renderer.js';
import { coinRain } from '../../shared/win-pot-calculator.js';
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
let _isAnimating = false;
let _resultsShown = false;

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
  clearSession();
  roomCode = null; playerIndex = null; isHost = false; playerNames = []; state = null;
  if (goHome) goHome();
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

/* ======= CARD ANIMATIONS ======= */

/**
 * Animates a floating card from one rect to another.
 * @param {DOMRect} fromRect
 * @param {DOMRect} toRect
 * @param {HTMLElement} cardEl - a full .card element
 * @param {number} [duration=350]
 * @returns {Promise<void>}
 */
function animateCardMove(fromRect, toRect, cardEl, duration = 350) {
  return new Promise((resolve) => {
    const floater = cardEl;
    floater.style.position = 'fixed';
    floater.style.left = `${fromRect.left}px`;
    floater.style.top = `${fromRect.top}px`;
    floater.style.zIndex = '200';
    floater.style.transition = 'none';
    floater.style.pointerEvents = 'none';

    document.body.appendChild(floater);

    // Double-rAF: first frame ensures the browser paints at start position,
    // second frame applies the transition so older devices animate correctly.
    requestAnimationFrame(() => {
      floater.offsetWidth; // eslint-disable-line no-unused-expressions
      floater.style.transition = `left ${duration}ms ease-out, top ${duration}ms ease-out`;
      requestAnimationFrame(() => {
        const cardW = floater.offsetWidth;
        const cardH = floater.offsetHeight;
        floater.style.left = `${toRect.left + (toRect.width - cardW) / 2}px`;
        floater.style.top = `${toRect.top + (toRect.height - cardH) / 2}px`;
      });
    });

    setTimeout(() => {
      if (floater.parentNode) floater.parentNode.removeChild(floater);
      resolve();
    }, duration + 20);
  });
}

/**
 * Gets the bounding rect of the center pile.
 * @returns {DOMRect|null}
 */
function getPileRect() {
  const el = document.getElementById('bl-pile-card-inner');
  return el ? el.getBoundingClientRect() : null;
}

/**
 * Gets the bounding rect of a specific card in the local hand.
 * @param {number} index
 * @returns {DOMRect|null}
 */
function getHandCardRect(index) {
  const card = document.querySelector(`#bl-hand-area .bl-hand-card[data-hand-index="${index}"]`);
  return card ? card.getBoundingClientRect() : null;
}

/**
 * Gets the bounding rect of an opponent's player block.
 * @param {number} pIdx
 * @returns {DOMRect|null}
 */
function getPlayerBlockRect(pIdx) {
  const block = document.querySelector(`#bl-all-players .game-player-block[data-player-index="${pIdx}"]`);
  return block ? block.getBoundingClientRect() : null;
}

/**
 * Animate cards flying from hand positions to center pile (face-down).
 * @param {number[]} cardIndices
 * @returns {Promise<void>}
 */
async function animatePlacementToPile(cardIndices) {
  const pileRect = getPileRect();
  if (!pileRect) return;

  const promises = cardIndices.map((idx, i) => {
    const fromRect = getHandCardRect(idx);
    if (!fromRect) return Promise.resolve();
    const back = renderCardBack();
    back.style.width = '46px';
    back.style.height = '64px';
    return new Promise((resolve) => {
      setTimeout(() => {
        animateCardMove(fromRect, pileRect, back, 300).then(resolve);
      }, i * 80);
    });
  });

  await Promise.all(promises);
}

/**
 * Animate a card-back from an opponent block to the center pile (remote placement).
 * @param {number} opponentIndex
 * @returns {Promise<void>}
 */
async function animateRemotePlacement(opponentIndex) {
  const fromRect = getPlayerBlockRect(opponentIndex);
  const toRect = getPileRect();
  if (!fromRect || !toRect) return;

  const back = renderCardBack();
  back.style.width = '46px';
  back.style.height = '64px';
  await animateCardMove(fromRect, toRect, back, 300);
}

/**
 * Animate pile sweep toward the loser's block (challenge loss).
 * @param {number} loserIndex
 * @returns {Promise<void>}
 */
async function animatePileSweep(loserIndex) {
  const fromRect = getPileRect();
  let toRect;
  if (loserIndex === playerIndex) {
    // Sweep to self bar
    const selfBar = document.getElementById('bl-self-bar');
    toRect = selfBar ? selfBar.getBoundingClientRect() : null;
  } else {
    toRect = getPlayerBlockRect(loserIndex);
  }
  if (!fromRect || !toRect) return;

  const back = renderCardBack();
  back.style.width = '46px';
  back.style.height = '64px';
  await animateCardMove(fromRect, toRect, back, 400);
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
      if (status === 'lobby') { state = null; setupLobby(); }
      if (status === 'ended') {
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
  _resultsShown = false;
  showScreen('bl-gameplay');
  const endBtn = document.getElementById('bl-btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;
  hideRankSelector();
  clearSelection();
  setEventMessage('');
  renderUI();
}

function renderUI() {
  if (!state) return;
  renderGameplay(state, playerIndex, {
    onPlaceCards: (indices) => handlePlacement(indices),
    onChallenge: () => handleChallenge(),
    onPass: () => handlePass(),
    onReorder: (from, to) => handleReorder(from, to),
    onSort: () => handleSort(),
  });
}

/* ======= REORDER ======= */

function handleReorder(fromIndex, toIndex) {
  if (!state || playerIndex == null) return;
  const hand = [...state.players[playerIndex].hand];
  const [card] = hand.splice(fromIndex, 1);
  hand.splice(toIndex, 0, card);
  const newPlayers = state.players.map((p, i) => {
    if (i === playerIndex) return { ...p, hand };
    return { ...p };
  });
  state = { ...state, players: newPlayers };
  renderUI();
}

/* ======= SORT ======= */

const RANK_ORDER = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };
const SUIT_ORDER = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };

function handleSort() {
  if (!state || playerIndex == null) return;
  const hand = [...state.players[playerIndex].hand];
  hand.sort((a, b) => {
    const rankDiff = (RANK_ORDER[a.rank] || 0) - (RANK_ORDER[b.rank] || 0);
    if (rankDiff !== 0) return rankDiff;
    return (SUIT_ORDER[a.suit] || 0) - (SUIT_ORDER[b.suit] || 0);
  });
  const newPlayers = state.players.map((p, i) => {
    if (i === playerIndex) return { ...p, hand };
    return { ...p };
  });
  state = { ...state, players: newPlayers };
  clearSelection();
  renderUI();
}

/* ======= PLACEMENT ======= */

async function handlePlacement(cardIndices) {
  if (!state || state.phase !== 'placing') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (_isAnimating) return;

  // Check if previous placer won (empty hand, not challenged)
  if (state.lastPlacement && state.lastPlacement.placerEmpty) {
    state = { ...state, phase: 'finished', status: 'finished', winnerIndex: state.lastPlacement.playerIndex, lastPlacement: null };
    await writeFullState(state, { playerIndex, action: 'accept', timestamp: Date.now() });
    handleWin();
    return;
  }

  warmSpeech();

  // If a rank is already set for this round, place directly with that rank
  if (state.currentRank) {
    try {
      // Capture card rects before state change for animation
      const cardRects = cardIndices.map((idx) => getHandCardRect(idx));

      const newState = placeCards(state, cardIndices, state.currentRank);

      const validation = validateState(newState);
      if (!validation.valid) {
        showToast(`Error: ${validation.error}`);
        return;
      }

      state = newState;
      clearSelection();

      playSound('throw');

      const lp = state.lastPlacement;

      // Animate cards flying to pile (face-down)
      _isAnimating = true;
      await animatePlacementToPile(cardIndices);
      _isAnimating = false;

      const lastMove = {
        playerIndex,
        action: 'place',
        declaredRank: lp.declaredRank,
        count: lp.count,
        timestamp: Date.now(),
      };

      await writeFullState(state, lastMove);

      setEventMessage(`You placed ${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
      speak(`${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
      renderUI();
    } catch (err) {
      _isAnimating = false;
      console.error('Placement failed:', err);
      showToast(err.message || 'Placement failed');
    }
    return;
  }

  // No rank set — first player of the round picks via rank selector
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

      // Animate cards flying to pile (face-down)
      _isAnimating = true;
      await animatePlacementToPile(cardIndices);
      _isAnimating = false;

      const lastMove = {
        playerIndex,
        action: 'place',
        declaredRank: lp.declaredRank,
        count: lp.count,
        timestamp: Date.now(),
      };

      await writeFullState(state, lastMove);

      setEventMessage(`You placed ${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
      speak(`${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
      renderUI();
    } catch (err) {
      _isAnimating = false;
      console.error('Placement failed:', err);
      showToast(err.message || 'Placement failed');
    }
  });
}

/* ======= PASS ======= */

async function handlePass() {
  if (!state || state.phase !== 'placing') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (!state.currentRank) return; // Can't pass if no rank is set

  try {
    const newState = passCard(state);
    state = newState;
    clearSelection();

    playSound('capture');

    const lastMove = {
      playerIndex,
      action: 'pass',
      timestamp: Date.now(),
    };

    await writeFullState(state, lastMove);

    if (state.status === 'finished') {
      handleWin();
      return;
    }

    setEventMessage('You passed');
    renderUI();
  } catch (err) {
    console.error('Pass failed:', err);
    showToast(err.message || 'Pass failed');
  }
}

/* ======= CHALLENGE ======= */

async function handleChallenge() {
  if (!state || !state.lastPlacement || state.lastPlacement.playerIndex === playerIndex) return;

  warmSpeech();

  try {
    const { newState, bluffCaught, revealedCards } = resolveChallenge(state, playerIndex);

    const validation = validateState(newState);
    if (!validation.valid) {
      showToast(`Error: ${validation.error}`);
      return;
    }

    // Announce
    speak('Bluff called!');

    const placerIndex = state.lastPlacement.playerIndex;
    const placerName = state.players[placerIndex].name;
    const declaredRank = state.lastPlacement.declaredRank;
    const loserIndex = bluffCaught ? placerIndex : playerIndex;
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

    // Show result overlay
    await renderChallengeResult(revealedCards, declaredRank, bluffCaught, loserName);

    // Animate pile sweep to loser
    playSound('capture');
    await animatePileSweep(loserIndex);

    // Announce outcome
    if (bluffCaught) {
      speak(`${placerName} caught bluffing!`);
      setEventMessage(`🚨 ${placerName} was bluffing! ${placerName} takes the pile.`);
    } else {
      speak(`${placerName} was truthful!`);
      setEventMessage(`✅ ${placerName} was truthful! ${loserName} takes the pile.`);
    }

    clearSelection();
    renderUI();
  } catch (err) {
    console.error('Challenge failed:', err);
    showToast(err.message || 'Challenge failed');
  }
}

/* ======= WIN HANDLING ======= */

async function handleWin() {
  if (_resultsShown) { renderResults(state); showScreen('bl-results'); return; }
  _resultsShown = true;

  if (state.winnerIndex != null) {
    const winner = state.players[state.winnerIndex];
    await announceWin(winner.name);
    if (typeof confetti === 'function') {
      confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
    }
    coinRain();
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

    const oldLastPlacement = state ? state.lastPlacement : null;
    const revealedCards = oldLastPlacement ? oldLastPlacement.actualCards : [];
    const declaredRank = oldLastPlacement ? oldLastPlacement.declaredRank : '';
    const bluffCaught = lastMove.bluffCaught;
    const loserIndex = lastMove.loserIndex;
    const placerIdx = oldLastPlacement ? oldLastPlacement.playerIndex : null;
    const placerName = placerIdx != null && state ? state.players[placerIdx]?.name || 'Player' : 'Player';
    const loserName = state && loserIndex != null ? state.players[loserIndex]?.name || 'Player' : 'Player';

    state = newState;

    speak('Bluff called!');

    renderChallengeResult(revealedCards, declaredRank, bluffCaught, loserName).then(async () => {
      // Animate pile sweep to loser
      playSound('capture');
      await animatePileSweep(loserIndex);

      if (bluffCaught) {
        speak(`${placerName} caught bluffing!`);
        setEventMessage(`🚨 ${placerName} was bluffing! ${placerName} takes the pile.`);
      } else {
        speak(`${placerName} was truthful!`);
        setEventMessage(`✅ ${placerName} was truthful! ${loserName} takes the pile.`);
      }
      clearSelection();
      renderUI();
    });
    return;
  }

  // Detect placement from remote (another player placed cards)
  if (lastMove && lastMove.action === 'place' && lastMove.playerIndex !== playerIndex) {
    state = newState;
    clearSelection();
    playSound('throw');

    // Announce what was placed
    const lp = state.lastPlacement;
    if (lp) {
      const placer = state.players[lp.playerIndex];
      speak(`${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
      setEventMessage(`${placer?.emoji || ''} ${placer?.name || 'Player'} placed ${lp.count} ${lp.declaredRank}${lp.count > 1 ? 's' : ''}`);
    }

    // Animate remote placement: card-back from opponent block to pile
    const opponentIdx = lastMove.playerIndex;
    animateRemotePlacement(opponentIdx).then(() => {
      renderUI();
    });
    return;
  }

  // Detect pass from remote (another player passed)
  if (lastMove && lastMove.action === 'pass' && lastMove.playerIndex !== playerIndex) {
    state = newState;
    clearSelection();
    playSound('capture');
    const passerName = state.players[lastMove.playerIndex]?.name || 'Player';
    setEventMessage(`${passerName} passed`);

    // Check if game ended (previous placer had empty hand, unchallenged)
    if (state.status === 'finished') {
      handleWin();
      return;
    }

    renderUI();
    return;
  }

  // Generic update
  state = newState;

  if (state.status === 'finished' || state.phase === 'finished') {
    state.status = 'finished';
    handleWin();
    return;
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
          if (s === 'lobby') { state = null; setupLobby(); }
          if (s === 'ended' && state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('bl-results'); startReadyListener(); }
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
