/**
 * Bluff — UI Module
 *
 * Renders gameplay screen: players bar, center pile, hand,
 * challenge window with countdown, rank selector, results.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';
import { calculatePot, getPlayerMetric, renderPotDisplay } from '../../shared/win-pot-calculator.js';

/* ======= CONSTANTS ======= */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CHALLENGE_WINDOW_MS = 5000;

/* ======= SELECTION STATE ======= */

let _selectedIndices = new Set();
let _selectedForMove = null;

/**
 * Returns currently selected card indices.
 * @returns {number[]}
 */
export function getSelectedIndices() {
  return [..._selectedIndices];
}

/**
 * Clears card selection state.
 */
export function clearSelection() {
  _selectedIndices = new Set();
  _selectedForMove = null;
}

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Bluff gameplay screen.
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onPlaceCards, onChallenge, onPass, onReorder }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const allPlayersBar = document.getElementById('bl-all-players');
  const pileArea = document.getElementById('bl-pile-area');
  const eventBar = document.getElementById('bl-event-bar');
  const handArea = document.getElementById('bl-hand-area');
  const actionsArea = document.getElementById('bl-actions-area');

  // All players bar (opponents only)
  if (allPlayersBar) {
    renderAllPlayers(allPlayersBar, state, localPlayerIndex);
  }

  // Self bar
  renderSelfBar(state, localPlayerIndex);

  // Round rank indicator
  renderRoundRankIndicator(state);

  // Center pile
  if (pileArea) {
    renderCenterPile(pileArea, state.centerPile.length);
  }

  // Hand
  if (handArea) {
    const isMyTurn = state.currentPlayerIndex === localPlayerIndex;
    const canSelect = isMyTurn && state.phase === 'placing';
    const inChallengeWindow = state.phase === 'challengeWindow';
    renderHand(handArea, state.players[localPlayerIndex].hand, canSelect, inChallengeWindow, callbacks.onReorder);
  }

  // Actions area (place button + pass button)
  if (actionsArea) {
    actionsArea.innerHTML = '';
    const isMyTurn = state.currentPlayerIndex === localPlayerIndex;

    if (isMyTurn && state.phase === 'placing') {
      const btnRow = document.createElement('div');
      btnRow.className = 'bl-action-row';

      const placeBtn = document.createElement('button');
      placeBtn.className = 'btn primary bl-place-btn';
      placeBtn.type = 'button';
      const count = _selectedIndices.size;
      placeBtn.textContent = count > 0 ? `Place ${count} Card${count > 1 ? 's' : ''}` : 'Select Cards to Place';
      placeBtn.disabled = count === 0;
      placeBtn.addEventListener('click', () => {
        if (_selectedIndices.size > 0 && _selectedIndices.size <= 4 && callbacks.onPlaceCards) {
          callbacks.onPlaceCards([..._selectedIndices]);
        }
      });
      btnRow.appendChild(placeBtn);

      // Pass button — only when a rank is already set (can't pass if you need to pick a rank)
      if (state.currentRank) {
        const passBtn = document.createElement('button');
        passBtn.className = 'btn bl-pass-btn';
        passBtn.type = 'button';
        passBtn.textContent = '⏭ Pass';
        passBtn.addEventListener('click', () => {
          if (callbacks.onPass) callbacks.onPass();
        });
        btnRow.appendChild(passBtn);
      }

      actionsArea.appendChild(btnRow);
    }
  }
}

/**
 * Renders all player blocks at the top (opponents only).
 * Each block: emoji + name + compact heap icon + card count badge.
 * Active turn gets gold glow. Skips self.
 */
function renderAllPlayers(container, state, localPlayerIndex) {
  container.innerHTML = '';

  state.players.forEach((player, i) => {
    if (i === localPlayerIndex) return;

    const block = document.createElement('div');
    block.className = 'game-player-block';
    block.dataset.playerIndex = String(i);
    if (i === state.currentPlayerIndex) block.classList.add('game-block-active');

    const emoji = document.createElement('span');
    emoji.className = 'game-block-emoji';
    emoji.textContent = player.emoji;

    const name = document.createElement('span');
    name.className = 'game-block-name';
    name.textContent = player.name;

    const count = player.hand ? player.hand.length : 0;

    // Compact heap: 3 overlapping mini card-backs with random offset
    const heapWrap = document.createElement('div');
    heapWrap.className = 'bl-heap-wrap';

    const heap = document.createElement('div');
    heap.className = 'bl-heap';
    const offsets = [
      { x: 0, y: 0, r: -4 },
      { x: 3, y: -2, r: 2 },
      { x: 6, y: -1, r: 5 },
    ];
    for (let c = 0; c < 3; c++) {
      const mini = document.createElement('div');
      mini.className = 'bl-heap-card';
      const o = offsets[c];
      mini.style.transform = `translate(${o.x}px, ${o.y}px) rotate(${o.r}deg)`;
      mini.style.zIndex = String(c);
      heap.appendChild(mini);
    }
    heapWrap.appendChild(heap);

    const badge = document.createElement('span');
    badge.className = 'bl-heap-badge';
    badge.textContent = String(count);
    heapWrap.appendChild(badge);

    block.appendChild(emoji);
    block.appendChild(name);
    block.appendChild(heapWrap);
    container.appendChild(block);
  });
}

/**
 * Renders the self bar at the bottom with emoji and name.
 */
function renderSelfBar(state, localPlayerIndex) {
  const emojiEl = document.getElementById('bl-self-emoji');
  const nameEl = document.getElementById('bl-self-name');
  if (!emojiEl || !nameEl) return;
  const self = state.players[localPlayerIndex];
  if (!self) return;
  emojiEl.textContent = self.emoji;
  nameEl.textContent = self.name;
}

/**
 * Renders the current round rank indicator above the pile area.
 * Shows "Round: Xs" when a rank is active, or "Pick a rank" when null.
 */
function renderRoundRankIndicator(state) {
  let indicator = document.getElementById('bl-round-rank-indicator');

  // Create the indicator element if it doesn't exist
  if (!indicator) {
    const pileArea = document.getElementById('bl-pile-area');
    if (!pileArea) return;
    indicator = document.createElement('div');
    indicator.id = 'bl-round-rank-indicator';
    indicator.className = 'bl-round-rank-indicator';
    pileArea.parentNode.insertBefore(indicator, pileArea);
  }

  if (state.currentRank) {
    indicator.textContent = `Round: ${state.currentRank}s`;
    indicator.className = 'bl-round-rank-indicator bl-round-rank-active';
  } else {
    indicator.textContent = '🎯 Pick a rank';
    indicator.className = 'bl-round-rank-indicator bl-round-rank-pick';
  }
}

/**
 * Renders center pile as face-down stack with count.
 */
function renderCenterPile(container, pileCount) {
  container.innerHTML = '';

  const pileCard = document.createElement('div');
  pileCard.className = 'bl-pile-card';
  pileCard.id = 'bl-pile-card-inner';

  if (pileCount > 0) {
    const back = renderCardBack();
    pileCard.appendChild(back);
  } else {
    const empty = document.createElement('div');
    empty.className = 'sr-pile-empty';
    empty.textContent = '—';
    pileCard.appendChild(empty);
  }

  const countLabel = document.createElement('p');
  countLabel.className = 'pile-count';
  countLabel.textContent = `Pile: ${pileCount}`;

  container.appendChild(pileCard);
  container.appendChild(countLabel);
}

/**
 * Renders the local player's hand as a multi-row grid (10 columns).
 * Cards slightly overlap horizontally. Supports multi-select for placement
 * and tap-to-reorder when not in placing/challenge phase.
 */
function renderHand(container, hand, canSelect, inChallengeWindow, onReorder) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'bl-hand-grid';

  const n = hand.length;

  // Responsive card sizing based on hand count
  let cardW = 38, cardH = 54;
  if (n <= 10) {
    cardW = 42; cardH = 59;
  } else if (n > 26) {
    cardW = 34; cardH = 48;
  }

  grid.style.setProperty('--bl-grid-card-w', `${cardW}px`);
  grid.style.setProperty('--bl-grid-card-h', `${cardH}px`);

  hand.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.dataset.handIndex = String(i);
    cardEl.classList.add('bl-hand-card');

    if (canSelect) {
      // Placing phase: multi-select for placement
      if (_selectedIndices.has(i)) {
        cardEl.classList.add('bl-card-selected');
      }

      cardEl.style.cursor = 'pointer';
      cardEl.addEventListener('click', () => {
        if (_selectedIndices.has(i)) {
          _selectedIndices.delete(i);
        } else if (_selectedIndices.size < 4) {
          _selectedIndices.add(i);
        }
        // Re-render hand and actions
        renderHand(container, hand, canSelect, inChallengeWindow, onReorder);
        // Update place button
        const actionsArea = document.getElementById('bl-actions-area');
        if (actionsArea) {
          const placeBtn = actionsArea.querySelector('.bl-place-btn');
          if (placeBtn) {
            const count = _selectedIndices.size;
            placeBtn.textContent = count > 0 ? `Place ${count} Card${count > 1 ? 's' : ''}` : 'Select Cards to Place';
            placeBtn.disabled = count === 0;
          }
        }
      });
    } else if (!inChallengeWindow) {
      // Not placing, not in challenge window: reorder mode
      cardEl.style.cursor = 'pointer';

      if (_selectedForMove === i) {
        cardEl.classList.add('sr-card-selected');
      }

      cardEl.addEventListener('click', () => {
        if (_selectedForMove === null || _selectedForMove === i) {
          _selectedForMove = _selectedForMove === i ? null : i;
          renderHand(container, hand, canSelect, inChallengeWindow, onReorder);
        } else {
          const from = _selectedForMove;
          _selectedForMove = null;
          if (onReorder) onReorder(from, i);
        }
      });
    } else {
      cardEl.style.cursor = 'default';
    }

    grid.appendChild(cardEl);
  });

  container.appendChild(grid);
}

/* ======= CHALLENGE WINDOW ======= */

/**
 * Renders the merged challenge window UI — prominent placement announcement + BLUFF button (or waiting) + countdown.
 * This replaces both the old placement overlay and the old challenge area.
 * @param {number} remainingMs — milliseconds remaining
 * @param {boolean} canChallenge — whether local player can challenge
 * @param {Function} onChallenge — callback when Bluff! is pressed
 * @param {string} announcement — text like "🧙 Player placed 2 Kings"
 */
export function renderChallengeWindow(remainingMs, canChallenge, onChallenge, announcement) {
  const challengeArea = document.getElementById('bl-challenge-area');
  if (!challengeArea) return;

  challengeArea.innerHTML = '';
  challengeArea.hidden = false;

  // Prominent placement announcement (gold, large)
  if (announcement) {
    const announcementEl = document.createElement('p');
    announcementEl.className = 'bl-challenge-announcement bl-challenge-announcement-prominent';
    announcementEl.textContent = announcement;
    challengeArea.appendChild(announcementEl);
  }

  // Bluff! button (large, pulsing) or waiting text
  if (canChallenge) {
    const bluffBtn = document.createElement('button');
    bluffBtn.className = 'btn primary bl-bluff-btn';
    bluffBtn.type = 'button';
    bluffBtn.textContent = '🃏 BLUFF!';
    bluffBtn.addEventListener('click', () => {
      if (onChallenge) onChallenge();
    });
    challengeArea.appendChild(bluffBtn);
  } else {
    const waitText = document.createElement('p');
    waitText.className = 'bl-wait-text';
    waitText.textContent = 'Waiting for challenges...';
    challengeArea.appendChild(waitText);
  }

  // Countdown text
  const countdownText = document.createElement('span');
  countdownText.className = 'bl-countdown-text';
  countdownText.textContent = `${Math.ceil(remainingMs / 1000)}s`;
  challengeArea.appendChild(countdownText);
}

/**
 * Hides the challenge window.
 */
export function hideChallengeWindow() {
  const challengeArea = document.getElementById('bl-challenge-area');
  if (challengeArea) {
    challengeArea.innerHTML = '';
    challengeArea.hidden = true;
  }
}

/* ======= RANK SELECTOR ======= */

/**
 * Renders the rank selector overlay for declaring a rank.
 * @param {Function} onRankSelect — callback(rank) when a rank is chosen
 */
export function renderRankSelector(onRankSelect) {
  const overlay = document.getElementById('bl-rank-selector');
  if (!overlay) return;

  overlay.innerHTML = '';
  overlay.hidden = false;

  const box = document.createElement('div');
  box.className = 'bl-rank-box';

  const title = document.createElement('h3');
  title.textContent = 'Declare a Rank';
  box.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'bl-rank-grid';

  RANKS.forEach((rank) => {
    const btn = document.createElement('button');
    btn.className = 'bl-rank-btn';
    btn.type = 'button';
    btn.textContent = rank;
    btn.addEventListener('click', () => {
      overlay.hidden = true;
      overlay.innerHTML = '';
      if (onRankSelect) onRankSelect(rank);
    });
    grid.appendChild(btn);
  });

  box.appendChild(grid);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn secondary bl-rank-cancel';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    overlay.hidden = true;
    overlay.innerHTML = '';
  });
  box.appendChild(cancelBtn);

  overlay.appendChild(box);
}

/**
 * Hides the rank selector.
 */
export function hideRankSelector() {
  const overlay = document.getElementById('bl-rank-selector');
  if (overlay) {
    overlay.hidden = true;
    overlay.innerHTML = '';
  }
}

/* ======= CHALLENGE RESULT ======= */

/**
 * Renders the challenge result — reveals cards, shows outcome.
 * @param {Array} revealedCards — the actual cards placed
 * @param {string} declaredRank — what was declared
 * @param {boolean} bluffCaught — whether the bluff was caught
 * @param {string} loserName — name of the player who takes the pile
 * @returns {Promise<void>} resolves when animation completes
 */
export function renderChallengeResult(revealedCards, declaredRank, bluffCaught, loserName) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('bl-challenge-result');
    if (!overlay) { resolve(); return; }

    overlay.innerHTML = '';
    overlay.hidden = false;

    const box = document.createElement('div');
    box.className = 'bl-result-box';

    // Outcome text
    const outcomeEl = document.createElement('h3');
    outcomeEl.className = bluffCaught ? 'bl-result-caught' : 'bl-result-truthful';
    outcomeEl.textContent = bluffCaught ? '🚨 Bluff Caught!' : '✅ Was Truthful!';
    box.appendChild(outcomeEl);

    // Declared vs actual
    const declaredEl = document.createElement('p');
    declaredEl.className = 'bl-result-declared';
    declaredEl.textContent = `Declared: ${revealedCards.length} × ${declaredRank}`;
    box.appendChild(declaredEl);

    // Revealed cards
    const cardsRow = document.createElement('div');
    cardsRow.className = 'bl-result-cards';
    revealedCards.forEach((card) => {
      const cardEl = renderCardFace(card);
      cardEl.style.cursor = 'default';
      cardsRow.appendChild(cardEl);
    });
    box.appendChild(cardsRow);

    // Loser info
    const loserEl = document.createElement('p');
    loserEl.className = 'bl-result-loser';
    loserEl.textContent = `${loserName} takes the pile!`;
    box.appendChild(loserEl);

    overlay.appendChild(box);

    // Auto-dismiss after 3 seconds
    setTimeout(() => {
      overlay.hidden = true;
      overlay.innerHTML = '';
      resolve();
    }, 3000);
  });
}

/* ======= EVENT BAR ======= */

/**
 * Sets the event message bar text.
 * @param {string} message
 */
export function setEventMessage(message) {
  const bar = document.getElementById('bl-event-bar');
  if (bar) bar.textContent = message || '';
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 */
export function renderResults(state) {
  const display = document.getElementById('bl-winner-display');
  const resultsList = document.getElementById('bl-results-list');

  if (display) {
    display.innerHTML = '';
    if (state.winnerIndex != null && state.players[state.winnerIndex]) {
      const winner = state.players[state.winnerIndex];
      const emojiEl = document.createElement('div');
      emojiEl.className = 'winner-emoji';
      emojiEl.textContent = winner.emoji;

      const nameEl = document.createElement('div');
      nameEl.className = 'winner-name';
      nameEl.textContent = `${winner.name} wins!`;

      display.appendChild(emojiEl);
      display.appendChild(nameEl);

      const pot = calculatePot('bluff', state);
      if (pot > 0) {
        display.appendChild(renderPotDisplay(pot));
      }
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';
    state.players.forEach((player, i) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = getPlayerMetric('bluff', state, i);
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      resultsList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 * @param {Array<{name, emoji}>} players
 */
export function renderLobbyPlayers(players) {
  const list = document.getElementById('bl-lobby-player-list');
  if (!list) return;
  list.innerHTML = '';

  players.forEach((player, index) => {
    const li = document.createElement('li');
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';
    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    list.appendChild(li);
  });
}

/* ======= READY INDICATORS ======= */

/**
 * Renders ready indicators for play-again flow.
 */
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('bl-ready-indicators');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';

  const readySet = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers);
  const leftSet = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);

  playerNames.forEach((name, index) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readySet.has(index)) dot.classList.add('ready');
    if (leftSet.has(index)) dot.classList.add('not-ready');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = name;
    dot.appendChild(circle);
    dot.appendChild(label);
    container.appendChild(dot);
  });
}
