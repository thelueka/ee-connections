// Simple seeded pseudo-random number generator (mulberry32)
function seededRandom(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Generate a shuffled question order unique to this installation
function getShuffledIndices(totalQuestions, installSeed) {
  const indices = Array.from({ length: totalQuestions }, (_, i) => i);
  // Fisher-Yates shuffle with seeded random
  for (let i = indices.length - 1; i > 0; i--) {
    const rand = seededRandom(installSeed + i);
    const j = Math.floor(rand * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

// Get today's question — never repeats answered questions
function getTodayQuestion(questions, progress) {
  const installSeed = progress.installSeed;
  const shuffled = getShuffledIndices(questions.length, installSeed);
  const answeredIds = new Set(Object.keys(progress.answers).map(Number));

  // Walk through the shuffled order and find the first unanswered question
  for (const idx of shuffled) {
    if (!answeredIds.has(questions[idx].id)) {
      return questions[idx];
    }
  }

  // All questions have been answered
  return null;
}

// Local calendar date (YYYY-MM-DD); must match localDate() in main.js.
function getToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function init() {
  const questions = await window.api.getQuestions();
  const progress = await window.api.getProgress();
  const stats = await window.api.getStats();

  // Update stats display
  document.getElementById('streak').textContent = stats.streak;
  document.getElementById('accuracy').textContent = stats.accuracy + '%';
  document.getElementById('total').textContent = stats.total;

  const today = getToday();

  // Check if already answered today
  if (progress.lastAnsweredDate === today) {
    // Find the question they answered today
    const todayEntry = Object.entries(progress.answers).find(([, a]) => a.date === today);
    if (todayEntry) {
      const answeredQuestion = questions.find(q => q.id === Number(todayEntry[0]));
      if (answeredQuestion) {
        showAlreadyAnswered(answeredQuestion, todayEntry[1]);
        return;
      }
    }
  }

  // Get next unanswered question
  const question = getTodayQuestion(questions, progress);

  if (!question) {
    showAllComplete();
    return;
  }

  showQuestion(question);
}

function showQuestion(question) {
  document.getElementById('question-card').classList.remove('hidden');
  document.getElementById('result-card').classList.add('hidden');
  document.getElementById('done-card').classList.add('hidden');

  document.getElementById('category-badge').textContent = formatCategory(question.category);
  document.getElementById('question-text').textContent = question.question;

  const optionsContainer = document.getElementById('options-container');
  optionsContainer.innerHTML = '';

  question.options.forEach((option, idx) => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.textContent = option;
    btn.addEventListener('click', () => handleAnswer(question, idx, btn));
    optionsContainer.appendChild(btn);
  });
}

async function handleAnswer(question, selectedIdx, selectedBtn) {
  const correct = selectedIdx === question.answer;
  const buttons = document.querySelectorAll('.option-btn');

  // Disable all buttons
  buttons.forEach(btn => btn.disabled = true);

  // Highlight correct/incorrect
  buttons.forEach((btn, idx) => {
    if (idx === question.answer) {
      btn.classList.add('correct');
    } else if (idx === selectedIdx && !correct) {
      btn.classList.add('incorrect');
    }
  });

  // Save progress
  const updatedProgress = await window.api.saveAnswer({
    questionId: question.id,
    answer: selectedIdx,
    correct
  });

  // Update stats
  const stats = await window.api.getStats();
  document.getElementById('streak').textContent = stats.streak;
  document.getElementById('accuracy').textContent = stats.accuracy + '%';
  document.getElementById('total').textContent = stats.total;

  // Show result after a brief delay
  setTimeout(() => {
    showResult(question, correct);
  }, 1200);
}

function showResult(question, correct) {
  document.getElementById('question-card').classList.add('hidden');
  document.getElementById('result-card').classList.remove('hidden');

  const icon = document.getElementById('result-icon');
  const text = document.getElementById('result-text');

  if (correct) {
    icon.textContent = '✓';
    icon.className = 'result-icon';
    text.textContent = 'Correct!';
  } else {
    icon.textContent = '✗';
    icon.className = 'result-icon incorrect';
    text.textContent = 'Not quite!';
  }

  document.getElementById('explanation').textContent = question.explanation;
  document.getElementById('next-timer').textContent = 'Next question tomorrow at midnight';
}

function showAlreadyAnswered(question, answer) {
  document.getElementById('question-card').classList.add('hidden');
  document.getElementById('result-card').classList.add('hidden');
  document.getElementById('done-card').classList.remove('hidden');

  const reviewSection = document.getElementById('review-section');
  reviewSection.innerHTML = `
    <div class="review-label">Today's Question</div>
    <div class="review-question">${question.question}</div>
    <div class="review-answer">
      Your answer: ${question.options[answer.answer]} ${answer.correct ? '✓' : '✗'}<br>
      Correct answer: ${question.options[question.answer]}
    </div>
  `;
}

function showAllComplete() {
  document.getElementById('question-card').classList.add('hidden');
  document.getElementById('result-card').classList.add('hidden');
  document.getElementById('done-card').classList.remove('hidden');

  const reviewSection = document.getElementById('review-section');
  reviewSection.innerHTML = `
    <div class="review-label">🎉 Congratulations!</div>
    <div class="review-question">You've answered all available questions!</div>
    <div class="review-answer">
      Check back later — new questions are added regularly.
    </div>
  `;
}

function formatCategory(category) {
  return category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

let boardData = null;
let boardPeriod = 'weekly';

const BOARD_MESSAGES = {
  disabled: 'The leaderboard isn\'t set up yet.',
  'no-alias': 'Couldn\'t detect your Amazon alias from this computer\'s login.',
  'alias-taken': 'Your alias is already registered from another install. Ask the app owner to reset it.',
  offline: 'Can\'t reach the leaderboard right now. Your answers will sync when you\'re back online.',
  unavailable: 'The leaderboard is unavailable right now. Try again later.'
};

function setActiveTab(showBoard) {
  document.querySelector('.app-container').classList.toggle('show-board', showBoard);
  document.getElementById('board-card').classList.toggle('hidden', !showBoard);
  const today = document.getElementById('tab-today');
  const board = document.getElementById('tab-board');
  today.classList.toggle('active', !showBoard);
  board.classList.toggle('active', showBoard);
  today.setAttribute('aria-selected', String(!showBoard));
  board.setAttribute('aria-selected', String(showBoard));
  if (showBoard) loadLeaderboard();
}

function setPeriod(period) {
  boardPeriod = period;
  for (const [id, p] of [['period-weekly', 'weekly'], ['period-alltime', 'allTime']]) {
    const btn = document.getElementById(id);
    btn.classList.toggle('active', p === period);
    btn.setAttribute('aria-pressed', String(p === period));
  }
  renderBoard();
}

async function loadLeaderboard() {
  const status = document.getElementById('board-status');
  status.textContent = 'Loading…';
  status.classList.remove('hidden');
  boardData = await window.api.getLeaderboard();
  renderBoard();
}

function formatWeek(monday) {
  const start = new Date(`${monday}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, fmt)} – ${end.toLocaleDateString(undefined, fmt)}`;
}

// Builds a row with textContent only; aliases come from the network.
function boardRow(entry, myAlias) {
  const li = document.createElement('li');
  li.className = 'board-row' + (entry.alias === myAlias ? ' me' : '');

  const rankEl = document.createElement('span');
  rankEl.className = 'board-rank';
  rankEl.textContent = entry.rank;

  const aliasEl = document.createElement('span');
  aliasEl.className = 'board-alias';
  aliasEl.textContent = entry.alias === myAlias ? `${entry.alias} (you)` : entry.alias;

  const scoreEl = document.createElement('span');
  scoreEl.className = 'board-score';
  scoreEl.textContent = entry.correct;
  const of = document.createElement('small');
  of.textContent = `/ ${entry.answered}`;
  scoreEl.appendChild(of);
  scoreEl.setAttribute('aria-label', `${entry.correct} correct out of ${entry.answered}`);

  li.append(rankEl, aliasEl, scoreEl);
  return li;
}

function renderBoard() {
  const list = document.getElementById('board-list');
  const me = document.getElementById('board-me');
  const status = document.getElementById('board-status');
  const subtitle = document.getElementById('board-subtitle');
  list.innerHTML = '';
  me.classList.add('hidden');
  subtitle.textContent = '';

  if (!boardData) return;
  if (boardData.status !== 'ok') {
    status.textContent = BOARD_MESSAGES[boardData.status] || BOARD_MESSAGES.unavailable;
    status.classList.remove('hidden');
    return;
  }

  const board = boardData[boardPeriod];
  subtitle.textContent = boardPeriod === 'weekly'
    ? `Correct answers, ${formatWeek(boardData.week)} · ${board.players} players`
    : `Correct answers since the leaderboard started · ${board.players} players`;

  if (board.top.length === 0) {
    status.textContent = boardPeriod === 'weekly'
      ? 'No answers yet this week. Be the first.'
      : 'No answers yet.';
    status.classList.remove('hidden');
    return;
  }
  status.classList.add('hidden');

  for (const entry of board.top) list.appendChild(boardRow(entry, boardData.alias));

  const inTop = board.top.some((e) => e.alias === boardData.alias);
  if (board.me && !inTop) {
    me.textContent = `You're #${board.me.rank} of ${board.players} with ${board.me.correct} correct.`;
    me.classList.remove('hidden');
  } else if (!board.me) {
    me.textContent = boardPeriod === 'weekly'
      ? 'Answer today\'s question to get on this week\'s board.'
      : 'Answer a question to get on the board.';
    me.classList.remove('hidden');
  }
}

document.getElementById('tab-today').addEventListener('click', () => setActiveTab(false));
document.getElementById('tab-board').addEventListener('click', () => setActiveTab(true));
document.getElementById('period-weekly').addEventListener('click', () => setPeriod('weekly'));
document.getElementById('period-alltime').addEventListener('click', () => setPeriod('allTime'));

// Initialize the app
init();
