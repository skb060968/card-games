/**
 * Bluff — UI Module
 *
 * Renders gameplay screen: players bar, center pile, hand,
 * challenge window with countdown, rank selector, results.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';

/* ======= CONSTANTS ======= */

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/* ======= SELECTION STATE ======= */

let _selectedIndices = new Set();

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
}

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Bluff gameplay screen.
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {object} callbacks - { onPlaceCards, onChallenge }
 */
export function renderGameplay(state, localPlayerIndex, callbacks) {
  const playersBar = document.getElementById('bl-players-bar');
  const pileArea = document.getElementById('bl-pile-area');
  const eventBar = document.getElementById('bl-event-bar');
  const handArea = document.getElementById('bl-hand-area');
  const actionsArea = document.getElementById('bl-actions-area');

  // Players bar
  if (playersBar) {
    renderPlayersBar(playersBar, state.players, state.currentPlayerIndex, localPlayerIndex);
  }

  // Center pile
  if (pileArea) {
    renderCenterPile(pileArea, state.centerPile.length);
  }

  // Hand
  if (handArea) {
    const isMyTurn = state.currentPlayerIndex === localPlayerIndex;
    const canSelect = isMyTurn && state.phase === 'placing';
    renderHand(handArea, state.players[localPlayerIndex].hand, canSelect);
  }

  // Actions area (place button)
  if (actionsArea) {
    actionsArea.innerHTML = '';
    const isMyTurn = state.currentPlayerIndex === localPlayerIndex;

    if (isMyTurn && state.phase === 'placing') {
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
      actionsArea.appendChild(placeBtn);
    }
  }
}

/**
 * Renders compact players bar.
 */
function renderPlayersBar(container, players, currentPlayerIndex, localPlayerIndex) {
  container.innerHTML = '';

  players.forEach((player, i) => {
    const slot = document.createElement('div');
    slot.className = 'sr-player-chip';
    if (i === currentPlayerIndex) slot.classList.add('sr-chip-active');
    if (i === localPlayerIndex) slot.classList.add('sr-chip-me');

    const emoji = document.createElement('span');
    emoji.className = 'sr-chip-emoji';
    emoji.textContent = player.emoji;

    const info = document.createElement('span');
    info.className = 'sr-chip-info';
    const displayName = i === localPlayerIndex ? 'You' : player.name;
    const cardCount = player.hand ? player.hand.length : 0;
    info.textContent = `${displayName} (${cardCount})`;

    slot.appendChild(emoji);
    slot.appendChild(info);
    container.appendChild(slot);
  });
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
 * Renders the local player's hand as an arc of tappable cards.
 */
function renderHand(container, hand, canSelect) {
  container.innerHTML = '';

  const arc = document.createElement('div');
  arc.className = 'sr-arc bl-arc';

  const n = hand.length;
  const maxAngle = 30;
  const maxLift = 20;

  hand.forEach((card, i) => {
    const cardEl = renderCardFace(card);
    cardEl.dataset.handIndex = String(i);
    cardEl.classList.add('sr-arc-card', 'bl-hand-card');

    const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
    const angle = t * (maxAngle / 2);
    const lift = (1 - t * t) * maxLift;
    let extraLift = 0;

    if (_selectedIndices.has(i)) {
      cardEl.classList.add('bl-card-selected');
      extraLift = 18;
    }

    if (canSelect) {
      cardEl.style.cursor = 'pointer';
      cardEl.addEventListener('click', () => {
        if (_selectedIndices.has(i)) {
          _selectedIndices.delete(i);
        } else if (_selectedIndices.size < 4) {
          _selectedIndices.add(i);
        }
        // Re-render hand and actions
        renderHand(container, hand, canSelect);
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
    } else {
      cardEl.style.cursor = 'default';
    }

    cardEl.style.transform = `translateY(${-lift - extraLift}px) rotate(${angle}deg)`;
    cardEl.style.zIndex = _selectedIndices.has(i) ? '20' : String(i);

    arc.appendChild(cardEl);
  });

  container.appendChild(arc);
}

/* ======= CHALLENGE WINDOW ======= */

/**
 * Renders the challenge window UI with countdown timer and Bluff! button.
 * @param {number} remainingMs — milliseconds remaining
 * @param {boolean} canChallenge — whether local player can challenge
 * @param {Function} onChallenge — callback when Bluff! is pressed
 * @param {string} announcement — text like "Player placed 2 Kings"
 */
export function renderChallengeWindow(remainingMs, canChallenge, onChallenge, announcement) {
  const challengeArea = document.getElementById('bl-challenge-area');
  if (!challengeArea) return;

  challengeArea.innerHTML = '';
  challengeArea.hidden = false;

  // Announcement
  if (announcement) {
    const announcementEl = document.createElement('p');
    announcementEl.className = 'bl-challenge-announcement';
    announcementEl.textContent = announcement;
    challengeArea.appendChild(announcementEl);
  }

  // Countdown bar
  const timerContainer = document.createElement('div');
  timerContainer.className = 'bl-timer-container';

  const timerBar = document.createElement('div');
  timerBar.className = 'bl-timer-bar';
  const pct = Math.max(0, Math.min(100, (remainingMs / 10000) * 100));
  timerBar.style.width = `${pct}%`;

  const timerText = document.createElement('span');
  timerText.className = 'bl-timer-text';
  timerText.textContent = `${Math.ceil(remainingMs / 1000)}s`;

  timerContainer.appendChild(timerBar);
  timerContainer.appendChild(timerText);
  challengeArea.appendChild(timerContainer);

  // Bluff! button
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
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';
    state.players.forEach((player) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = `🃏 ${player.hand.length} cards`;
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
