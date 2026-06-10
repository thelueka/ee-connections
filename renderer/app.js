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

function getToday() {
  return new Date().toISOString().split('T')[0];
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

// Initialize the app
init();
