// main.js — fixed and defensive version
// Detect environment: local vs production
const API_BASE =
  window.location.hostname === "localhost"
    ? "http://localhost:3000" // local backend
    : "https://ai-study-tutor-awpw.onrender.com"; // your Render backend URL

// safe element lookups (elements may be missing in some builds)
const contentInput = document.getElementById('contentInput');
const summarizeBtn = document.getElementById('summarizeBtn');
const quizBtn = document.getElementById('quizBtn');
const fileInput = document.getElementById('fileInput');

const loadingEl = document.getElementById('loading');
const summarySection = document.getElementById('summarySection');
const summaryDisplay = document.getElementById('summaryDisplay');
const regenerateSummary = document.getElementById('regenerateSummary');
const copySummary = document.getElementById('copySummary');

const quizSection = document.getElementById('quizSection');
const quizContainer = document.getElementById('quizContainer');
const quizResult = document.getElementById('quizResult');
const retryQuiz = document.getElementById('retryQuiz');

const summaryLength = document.getElementById('summaryLength');
const quizDifficulty = document.getElementById('quizDifficulty');
const questionCount = document.getElementById('questionCount');

function showLoading(show = true) { if (!loadingEl) return; loadingEl.classList.toggle('hidden', !show); }
function showSummary(show = true) { if (!summarySection) return; summarySection.classList.toggle('hidden', !show); }
function showQuiz(show = true) { if (!quizSection) return; quizSection.classList.toggle('hidden', !show); }

async function postJSON(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Server error (${res.status}): ${t}`);
  }
  return res.json();
}

/* -------------------------
   Summary button
   ------------------------- */
if (summarizeBtn) {
  summarizeBtn.addEventListener('click', async () => {
    const content = (contentInput && contentInput.value) ? contentInput.value.trim() : '';
    const length = summaryLength ? summaryLength.value : 'medium';
    if (!content) { alert('Please paste or upload some content first.'); return; }

    showSummary(false);
    showQuiz(false);
    showLoading(true);
    try {
    const resp = await postJSON(`${API_BASE}/api/summarize`, { content, length });
      let summary = resp.summary || '';
      
      // Clean up any remaining intro phrases on the frontend as well
      summary = summary
        .replace(/^Here's a summary of the text in \d+ words or less that a student can understand:\s*/i, '')
        .replace(/^Here's a summary of the text:\s*/i, '')
        .replace(/^Here's a concise summary:\s*/i, '')
        .replace(/^Summary:\s*/i, '')
        .replace(/^Here is a summary:\s*/i, '')
        .replace(/^The text can be summarized as follows:\s*/i, '')
        .replace(/^This text discusses:\s*/i, '')
        .trim();
      
      // Format the summary display with a highlighted header
      if (summaryDisplay) {
        summaryDisplay.innerHTML = `
          <div class="summary-header">
            📝 Summary
          </div>
          <div class="summary-content">
            ${summary.replace(/\n/g, '<br>')}
          </div>
        `;
      }
      showSummary(true);
    } catch (err) {
      alert('Error generating summary: ' + err.message);
    } finally {
      showLoading(false);
    }
  });
}

/* -------------------------
   Regenerate + Copy
   ------------------------- */
if (regenerateSummary) {
  regenerateSummary.addEventListener('click', () => { if (summarizeBtn) summarizeBtn.click(); });
}

if (copySummary) {
  copySummary.addEventListener('click', async () => {
    // Get only the summary content, not the header
    const summaryContent = summaryDisplay?.querySelector('.summary-content');
    const text = summaryContent ? summaryContent.textContent.trim() : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      alert('Summary copied to clipboard.');
    } catch (e) {
      alert('Copy failed: ' + e.message);
    }
  });
}

/* -------------------------
   Quiz button
   ------------------------- */
if (quizBtn) {
  quizBtn.addEventListener('click', async () => {
    const content = (contentInput && contentInput.value) ? contentInput.value.trim() : '';
    const difficulty = quizDifficulty ? quizDifficulty.value : 'medium';
    const count = questionCount ? parseInt(questionCount.value, 10) : 5;
    if (!content) { alert('Please paste or upload some content first.'); return; }

    showSummary(false);
    showQuiz(false);
    showLoading(true);
    try {
      const quizResp = await postJSON(`${API_BASE}/api/generateQuiz`, {
        content: content,
        count: count,
        difficulty: difficulty
      });
      renderQuiz(quizResp.questions || []);
      showQuiz(true);
    } catch (err) {
      alert('Error generating quiz: ' + err.message);
    } finally {
      showLoading(false);
    }
  });
}

/* -------------------------
   Quiz rendering + logic
   ------------------------- */
function renderQuiz(questions) {
  if (!quizContainer) return;
  quizContainer.innerHTML = '';
  if (quizResult) quizResult.classList.add('hidden');
  if (retryQuiz) retryQuiz.classList.add('hidden');

  if (!questions.length) {
    quizContainer.innerHTML = '<p>No questions generated.</p>';
    return;
  }

  // Add quiz header
  const quizHeader = document.createElement('div');
  quizHeader.className = 'quiz-header';
  quizHeader.innerHTML = '🧠 Quiz Questions';
  quizContainer.appendChild(quizHeader);

  const state = { answers: Array(questions.length).fill(null), correct: 0 };

  questions.forEach((q, idx) => {
    const qEl = document.createElement('div');
    qEl.className = 'quiz-question';
    qEl.innerHTML = `<div><strong>Q${idx + 1}.</strong> ${escapeHtml(q.question)}</div>`;
    const opts = document.createElement('div');
    opts.className = 'options';

    (q.options || []).forEach((opt, optIdx) => {
      const optEl = document.createElement('div');
      optEl.className = 'option';
      optEl.tabIndex = 0;
      optEl.textContent = opt;
      optEl.addEventListener('click', () => selectOption(idx, optIdx, q, optEl, opts, state));
      opts.appendChild(optEl);
    });

    const hintBtn = document.createElement('button');
    hintBtn.className = 'neumo-btn small';
    hintBtn.style.marginTop = '8px';
    hintBtn.textContent = 'Show Hint';
    const hintBox = document.createElement('div');
    hintBox.className = 'hint hidden';
    hintBox.textContent = q.hint || 'No hint available.';
    hintBtn.addEventListener('click', () => hintBox.classList.toggle('hidden'));

    qEl.appendChild(opts);
    qEl.appendChild(hintBtn);
    qEl.appendChild(hintBox);
    quizContainer.appendChild(qEl);
  });

  const submitBtn = document.createElement('button');
  submitBtn.className = 'neumo-btn';
  submitBtn.textContent = 'Submit Answers';
  submitBtn.style.marginTop = '12px';
  submitBtn.addEventListener('click', () => submitAnswers(questions, state));
  quizContainer.appendChild(submitBtn);
}

function selectOption(qIdx, optIdx, q, clickedEl, optsEl, state) {
  [...optsEl.children].forEach(ch => ch.classList.remove('selected'));
  clickedEl.classList.add('selected');
  state.answers[qIdx] = optIdx;
}

function submitAnswers(questions, state) {
  if (!quizContainer) return;
  let correctCount = 0;
  const qElems = quizContainer.querySelectorAll('.quiz-question');
  questions.forEach((q, idx) => {
    const chosen = state.answers[idx];
    const opts = qElems[idx].querySelectorAll('.option');
    if (chosen === null || chosen === undefined) {
      qElems[idx].style.opacity = '0.9';
      return;
    }
    if (chosen === q.correctIndex) {
      correctCount++;
      opts[chosen].classList.add('correct');
    } else {
      opts[chosen].classList.add('incorrect');
      opts[q.correctIndex].classList.add('correct');
    }
    const explanation = document.createElement('div');
    explanation.className = 'hint';
    explanation.textContent = q.explanation || 'No explanation provided.';
    qElems[idx].appendChild(explanation);
  });

  state.correct = correctCount;
  if (quizResult) {
    quizResult.classList.remove('hidden');
    quizResult.innerHTML = `<strong>Score:</strong> ${correctCount} / ${questions.length}`;
  }
  if (retryQuiz) {
    retryQuiz.classList.remove('hidden');
    retryQuiz.addEventListener('click', () => renderQuiz(questions));
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

/* -------------------------
   File input (guarded) — optional in HTML
   ------------------------- */
if (fileInput) {
  fileInput.addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    if (f.type === 'text/plain' || f.name.endsWith('.md')) {
      const txt = await f.text();
      if (contentInput) contentInput.value = txt;
    } else {
      alert('File type not supported in this demo. Please paste text or upload .txt/.md. For PDFs, add pdf parsing on the server or use pdf.js on client.');
    }
  });
}

/* -------------------------
   Theme toggle (resilient + persisted)
   ------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  const themeToggle = document.getElementById('themeToggle');
  if (!themeToggle) return;

  // restore saved theme
  const saved = localStorage.getItem('theme');
  if (saved === 'dark') document.body.classList.add('dark');

  const setBtnText = () => {
    themeToggle.textContent = document.body.classList.contains('dark') ? '☀️ Light Mode' : '🌙 Dark Mode';
  };
  setBtnText();

  themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    setBtnText();
  });
});