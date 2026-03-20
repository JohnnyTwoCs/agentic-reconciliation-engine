/* ── Agentic Reconciliation Engine V2 — Frontend Logic ─────────────── */

// State
let bankTxns = [], glEntries = [], matches = [], auditLog = [];
let matchedBank = new Set(), matchedGL = new Set();
let bankStatement = {}, bookBalance = 0, recReport = null;
let currentStep = 0, selectedMatchId = null, isProcessing = false, activeTab = 'bank';
let resolutions = [];
let pendingResolveData = null; // holds data for the resolve modal

// Transaction type colors from config
const TXN_COLORS = {
  check:'#748FFC', ach_payment:'#DA77F2', ach_deposit:'#69DB7C',
  wire_in:'#22C55E', wire_out:'#F97316', deposit:'#69DB7C',
  pos:'#FFA94D', bank_fee:'#FF6B6B', interest:'#4ECDC4',
  nsf:'#FF6B6B', adjustment:'#8888AA', reversal:'#8888AA'
};
const TXN_LABELS = {
  check:'Check', ach_payment:'ACH', ach_deposit:'ACH', wire_in:'Wire In', wire_out:'Wire Out',
  deposit:'Deposit', pos:'POS', bank_fee:'Fee', interest:'Interest', nsf:'NSF',
  adjustment:'Adj', reversal:'Rev'
};

// Rule display
const RULE_LABELS = {R1:'Check #', R2:'Wire Ref', R3:'ACH Ref', R4:'Amt+Date', R5:'Fuzzy', R6:'Multi', MANUAL:'Manual'};
const RULE_COLORS = {R1:'#22C55E', R2:'#22C55E', R3:'#22C55E', R4:'#3B82F6', R5:'#EAB308', R6:'#A855F7', MANUAL:'#F97316'};

document.addEventListener('DOMContentLoaded', loadData);

// ── Welcome & Progress Tracker ───────────────────────────────────────
function dismissWelcome() { document.getElementById('welcomeCard').classList.add('hidden'); }

function updateProgressTracker() {
  const hasMatches = matches.length > 0;
  const activeMatches = matches.filter(m => m.status !== 'rejected');
  const pendingCount = activeMatches.filter(m => m.status === 'pending' || m.status === 'exception').length;
  const allReviewed = hasMatches && pendingCount === 0;

  // Count reconciling items that need resolution
  let totalActionable = 0, resolvedCount = resolutions.length;
  if (recReport) {
    totalActionable += recReport.book_side.bank_fees.items.length;
    totalActionable += recReport.book_side.interest_income.items.length;
    totalActionable += recReport.book_side.nsf_charges.items.length;
    totalActionable += recReport.bank_side.outstanding_checks.items.length;
    totalActionable += recReport.bank_side.deposits_in_transit.items.length;
    // Count mismatches
    activeMatches.forEach(m => {
      const bAmt = m.bank_ids.reduce((s,id) => { const b=bankTxns.find(x=>x.id===id); return s+(b?Math.abs(b.amount):0); }, 0);
      const gAmt = m.gl_ids.reduce((s,id) => { const g=glEntries.find(x=>x.id===id); return s+(g?(g.debit||g.credit):0); }, 0);
      if (Math.abs(bAmt - gAmt) > 0.01) totalActionable++;
    });
  }
  const allResolved = totalActionable > 0 && resolvedCount >= totalActionable;
  const isReconciled = recReport && recReport.is_reconciled && allResolved;

  // Update counts
  const c1 = document.getElementById('trackerCount1');
  const c2 = document.getElementById('trackerCount2');
  const c3 = document.getElementById('trackerCount3');
  const c4 = document.getElementById('trackerCount4');
  c1.textContent = hasMatches ? `${activeMatches.length} matches` : '';
  c2.textContent = hasMatches ? (allReviewed ? 'Done' : `${pendingCount} pending`) : '';
  c3.textContent = totalActionable > 0 ? (allResolved ? 'Done' : `${resolvedCount}/${totalActionable}`) : '';
  c4.textContent = isReconciled ? '$0 variance' : (recReport ? `$${Math.abs(recReport.variance).toFixed(0)}` : '');

  const steps = [
    { el: 'trackerStep1', line: 'trackerLine1', done: hasMatches },
    { el: 'trackerStep2', line: 'trackerLine2', done: allReviewed },
    { el: 'trackerStep3', line: 'trackerLine3', done: allResolved },
    { el: 'trackerStep4', line: null, done: isReconciled },
  ];

  let currentFound = false;
  steps.forEach((s, i) => {
    const stepEl = document.getElementById(s.el);
    const lineEl = s.line ? document.getElementById(s.line) : null;
    if (s.done) {
      stepEl.className = 'tracker-step done';
      if (lineEl) lineEl.className = 'tracker-line done';
    } else if (!currentFound) {
      stepEl.className = 'tracker-step active';
      if (lineEl) lineEl.className = 'tracker-line';
      currentFound = true;
    } else {
      stepEl.className = 'tracker-step';
      if (lineEl) lineEl.className = 'tracker-line';
    }
  });

  // Enable/disable the Complete & Export button
  const exportBtn = document.getElementById('trackerExportBtn');
  if (exportBtn) exportBtn.disabled = !isReconciled;
}

function trackerNavigate(stage) {
  if (stage === 'matching') {
    // Go to Match Explorer, show all
    const tab = document.querySelector('.tab[data-tab="all"]');
    if (tab) switchTab('all', tab);
    filterMatchExplorer('all');
  } else if (stage === 'review') {
    // Go to Match Explorer, show pending
    const tab = document.querySelector('.tab[data-tab="all"]');
    if (tab) switchTab('all', tab);
    filterMatchExplorer('pending');
  } else if (stage === 'resolve') {
    // Scroll to dashboard reconciling items
    const dash = document.getElementById('dashboard');
    if (dash) dash.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Focus on reconciling items panel
    setTimeout(() => {
      const panel = document.querySelector('.recon-items-panel');
      if (panel) panel.style.boxShadow = '0 0 0 2px var(--accent)';
      setTimeout(() => { if (panel) panel.style.boxShadow = ''; }, 2000);
    }, 300);
  } else if (stage === 'complete') {
    // Scroll to rec report
    const rr = document.getElementById('recReport');
    if (rr) rr.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderKPICards(s) {
  if (!s) return;
  const totalTxns = s.total_bank + s.total_gl;
  const matched = s.matched_bank + s.matched_gl;
  document.getElementById('kpiMatched').textContent = `${matched}/${totalTxns}`;
  document.getElementById('kpiMatchedSub').textContent = `${s.match_rate_bank}% bank | ${s.match_rate_gl}% GL`;
  document.getElementById('kpiAutoApproved').textContent = s.auto_approved;
  document.getElementById('kpiNeedsReview').textContent = s.pending_review + s.exceptions;
  // Estimate time saved: ~3 min per match manually, agent does it in seconds
  const minutesSaved = Math.round(s.total_matches * 3);
  const hours = Math.floor(minutesSaved / 60);
  const mins = minutesSaved % 60;
  document.getElementById('kpiTimeSaved').textContent = hours > 0 ? `~${hours}h ${mins}m` : `~${mins}m`;
}

async function loadData() {
  const res = await fetch('/api/data');
  const d = await res.json();
  bankTxns = d.bank_transactions; glEntries = d.gl_entries;
  matches = d.matches || []; auditLog = d.audit_log || [];
  matchedBank = new Set(d.matched_bank || []);
  matchedGL = new Set(d.matched_gl || []);
  bankStatement = d.bank_statement; bookBalance = d.book_balance;
  recReport = d.rec_report; currentStep = d.current_step || 0;
  resolutions = d.resolutions || [];
  renderBankTable(); renderGLTable(); updateTableCount();
  if (d.summary) updateAll(d.summary, d.rec_report);
}

// ── Table Rendering ──────────────────────────────────────────────────
function renderBankTable() {
  document.getElementById('bankBody').innerHTML = bankTxns.map(t => {
    const s = getRowStatus(t.id, 'bank');
    const m = getMatchFor(t.id, 'bank');
    const color = TXN_COLORS[t.txn_type] || '#8888AA';
    const hint = m ? `<span class="match-hint" title="${m.gl_ids.join(', ')} | ${(m.confidence*100).toFixed(0)}% | ${m.rule_name}">&rarr; ${m.gl_ids[0]}</span>` : '';
    return `<tr class="${s.rowClass}" data-id="${t.id}" onclick="selectRow('${t.id}','bank')">
      <td>${t.id}</td><td>${t.date}</td>
      <td><span class="txn-badge" style="background:${color}">${TXN_LABELS[t.txn_type]||t.txn_type}</span></td>
      <td>${esc(t.description)}</td><td class="num">${fmtAmt(t.amount)}</td>
      <td>${t.check_number||'—'}</td><td>${t.reference||t.wire_ref||'—'}</td>
      <td><span class="status-pill ${s.pillClass}">${s.label}</span>${hint}</td></tr>`;
  }).join('');
}

function renderGLTable() {
  document.getElementById('glBody').innerHTML = glEntries.map(g => {
    const s = getRowStatus(g.id, 'gl');
    const m = getMatchFor(g.id, 'gl');
    const hint = m ? `<span class="match-hint" title="${m.bank_ids.join(', ')} | ${(m.confidence*100).toFixed(0)}% | ${m.rule_name}">&rarr; ${m.bank_ids[0]}</span>` : '';
    return `<tr class="${s.rowClass}" data-id="${g.id}" onclick="selectRow('${g.id}','gl')">
      <td>${g.id}</td><td>${g.date}</td><td>${g.effective_date||'—'}</td>
      <td>${esc(g.description)}</td>
      <td class="num">${g.debit > 0 ? fmtPos(g.debit) : '—'}</td>
      <td class="num">${g.credit > 0 ? fmtPos(g.credit) : '—'}</td>
      <td>${g.contra_name||g.account_code}</td><td>${g.journal_ref||'—'}</td>
      <td><span class="status-pill ${s.pillClass}">${s.label}</span>${hint}</td></tr>`;
  }).join('');
}

function getRowStatus(id, type) {
  const m = getMatchFor(id, type);
  if (m) {
    if (m.approval_tier === 'auto_approved') return {rowClass:'row-auto', pillClass:'status-auto', label:'Auto'};
    if (m.status === 'approved') return {rowClass:'row-approved', pillClass:'status-approved', label:'Approved'};
    if (m.status === 'pending') return {rowClass:'row-pending', pillClass:'status-pending', label:'Pending'};
    if (m.status === 'exception') return {rowClass:'row-exception', pillClass:'status-exception', label:'Exception'};
  }
  return {rowClass:'', pillClass:'status-unmatched', label:'—'};
}

function getMatchFor(id, type) {
  const key = type === 'bank' ? 'bank_ids' : 'gl_ids';
  return matches.find(m => m.status !== 'rejected' && m[key].includes(id)) || null;
}

function fmtAmt(n) { const a = Math.abs(n); const f = '$'+a.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); return n < 0 ? `(${f})` : f; }
function fmtPos(n) { return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function switchTab(tab, el) {
  activeTab = tab;
  document.querySelectorAll('.transactions-panel .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('bankTable').classList.toggle('hidden', tab !== 'bank');
  document.getElementById('glTable').classList.toggle('hidden', tab !== 'gl');
  document.getElementById('matchExplorer').classList.toggle('hidden', tab !== 'all');
  if (tab === 'all') renderMatchExplorer();
  updateTableCount();
}

// Right panel tabs
let activeRightTab = 'review';
function switchRightTab(tab, el) {
  activeRightTab = tab;
  document.querySelectorAll('.right-tabs .tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  else document.querySelector(`.right-tabs .tab[data-rtab="${tab}"]`).classList.add('active');
  document.getElementById('rightTabReview').classList.toggle('active', tab === 'review');
  document.getElementById('rightTabActivity').classList.toggle('active', tab === 'activity');
}
function updateTableCount() {
  let c, m;
  if (activeTab === 'all') { c = bankTxns.length + glEntries.length; m = matchedBank.size + matchedGL.size; }
  else if (activeTab === 'bank') { c = bankTxns.length; m = matchedBank.size; }
  else { c = glEntries.length; m = matchedGL.size; }
  document.getElementById('tableCount').textContent = `${m}/${c} matched`;
}

// ── Match Explorer (Card-based paired view) ─────────────────────────
let matchExplorerFilter = 'all';

function filterMatchExplorer(filter) {
  matchExplorerFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  renderMatchExplorer();
}

function renderMatchExplorer() {
  const container = document.getElementById('matchExplorerScroll');
  if (!matches.length && matchExplorerFilter !== 'unmatched') {
    container.innerHTML = '<div class="feed-empty">Run reconciliation to see matched pairs here.</div>';
    return;
  }

  // Sort: exceptions → pending → auto-approved
  const sorted = [...matches].filter(m => m.status !== 'rejected').sort((a, b) => {
    const order = {exception:0, pending:1, approved:2};
    const ao = a.approval_tier==='auto_approved' ? 3 : (order[a.status]??2);
    const bo = b.approval_tier==='auto_approved' ? 3 : (order[b.status]??2);
    return ao - bo;
  });

  let filtered = sorted;
  if (matchExplorerFilter === 'exceptions') filtered = sorted.filter(m => m.status==='exception');
  else if (matchExplorerFilter === 'pending') filtered = sorted.filter(m => m.status==='pending');
  else if (matchExplorerFilter === 'auto') filtered = sorted.filter(m => m.approval_tier==='auto_approved');
  else if (matchExplorerFilter === 'unmatched') filtered = [];

  let html = '';

  if (matchExplorerFilter !== 'unmatched') {
    filtered.forEach(m => {
      const bItems = m.bank_ids.map(id => bankTxns.find(b => b.id===id)).filter(Boolean);
      const gItems = m.gl_ids.map(id => glEntries.find(g => g.id===id)).filter(Boolean);
      const confPct = (m.confidence*100).toFixed(0);
      const confColor = m.confidence>=0.95 ? 'var(--green)' : m.confidence>=0.75 ? 'var(--yellow)' : 'var(--red)';
      const sPill = m.approval_tier==='auto_approved' ? 'status-auto' : m.status==='approved' ? 'status-approved' : m.status==='pending' ? 'status-pending' : 'status-exception';
      const sLabel = m.approval_tier==='auto_approved' ? 'Auto' : m.status.charAt(0).toUpperCase()+m.status.slice(1);
      const sel = selectedMatchId===m.id ? ' selected' : '';
      const plain = generatePlainEnglish(m, bItems, gItems);

      html += `<div class="match-card${sel}" onclick="selectMatch('${m.id}')">
        <div class="match-card-header">
          <span class="match-card-rule"><span class="feed-tag feed-tag-${m.rule_id}">${RULE_LABELS[m.rule_id]}</span> ${m.id}</span>
          <div class="match-card-confidence" title="${m.rule_id==='R5' ? 'Fuzzy scoring: Amount (40%) + Vendor (35%) + Date (25%)' : m.rule_name+' — '+confPct+'% confidence'}">
            <div class="match-card-conf-bar"><div class="match-card-conf-fill" style="width:${confPct}%;background:${confColor}"></div></div>
            <span style="font-size:11px;color:${confColor};font-weight:600">${confPct}%</span>
            <span class="status-pill ${sPill}">${sLabel}</span>
          </div>
        </div>
        <div class="match-card-body">
          <div class="match-card-pair">
            <div class="match-card-side">
              <div class="side-label">Bank Statement</div>
              ${bItems.map(b => `<div class="side-desc">${esc(b.description)}</div><div class="side-meta">${b.date} &middot; <span class="txn-badge" style="background:${TXN_COLORS[b.txn_type]};font-size:8px;padding:0 4px">${TXN_LABELS[b.txn_type]}</span></div><div class="side-amt">${fmtAmt(b.amount)}</div>`).join('')}
            </div>
            <div class="match-card-arrow">&#8596;</div>
            <div class="match-card-side">
              <div class="side-label">Book Entry</div>
              ${gItems.map(g => `<div class="side-desc">${esc(g.description)}</div><div class="side-meta">${g.date} &middot; ${g.journal_ref||''}</div><div class="side-amt">${g.debit > 0 ? fmtPos(g.debit)+' Dr' : fmtPos(g.credit)+' Cr'}</div>`).join('')}
            </div>
          </div>
        </div>
        <div class="match-card-plain">${plain}</div>
        <div class="match-card-actions">
          ${m.status==='pending'||m.status==='exception' ? `<button class="btn-approve" onclick="event.stopPropagation();approveMatch('${m.id}')">Approve</button>` : ''}
          <button class="btn-reject" onclick="event.stopPropagation();rejectMatch('${m.id}')">${m.status==='approved'||m.approval_tier==='auto_approved' ? 'Unmatch' : 'Reject'}</button>
          ${(() => { const bT=bItems.reduce((s,x)=>s+Math.abs(x.amount),0); const gT=gItems.reduce((s,x)=>s+(x.debit||x.credit),0); const diff=Math.abs(bT-gT); if(diff>0.01 && !isItemResolved(m.id)) return `<button class="btn-resolve" onclick="event.stopPropagation();openResolveModal('adjust_mismatch',{matchId:'${m.id}',bankAmount:${bT},glAmount:${gT},description:'${esc(bItems[0].description)}',itemId:'${m.id}'})">Resolve $${diff.toFixed(2)}</button>`; return ''; })()}
        </div>
      </div>`;
    });
  }

  // Unmatched items
  if (matchExplorerFilter === 'all' || matchExplorerFilter === 'unmatched') {
    const ub = bankTxns.filter(b => !matchedBank.has(b.id));
    const ug = glEntries.filter(g => !matchedGL.has(g.id));
    if (ub.length || ug.length) {
      html += `<div class="needs-attention-header">Needs Attention (${ub.length + ug.length} unmatched) ${!manualMatchMode ? `<button class="btn-resolve manual-match-btn" onclick="event.stopPropagation();toggleManualMatchMode()" style="font-size:10px;padding:2px 8px">Manual Match</button>` : ''}</div>`;
      ub.forEach(b => {
        const sel = manualMatchMode && selectedBankIds.has(b.id) ? ' selected' : '';
        const selectable = manualMatchMode ? ' selectable' : '';
        const onclick = manualMatchMode ? `onclick="toggleManualSelect('${b.id}','bank')"` : '';
        html += `<div class="unmatched-item${selectable}${sel}" ${onclick}><span><span class="source-badge source-bank">Bank</span> ${b.id} — ${esc(b.description)} &middot; ${b.date}</span><span class="amt">${fmtAmt(b.amount)}</span></div>`;
      });
      ug.forEach(g => {
        const sel = manualMatchMode && selectedGLIds.has(g.id) ? ' selected' : '';
        const selectable = manualMatchMode ? ' selectable' : '';
        const onclick = manualMatchMode ? `onclick="toggleManualSelect('${g.id}','gl')"` : '';
        html += `<div class="unmatched-item${selectable}${sel}" ${onclick}><span><span class="source-badge source-gl">Book</span> ${g.id} — ${esc(g.description)} &middot; ${g.date}</span><span class="amt">${g.debit > 0 ? fmtPos(g.debit) : fmtPos(g.credit)}</span></div>`;
      });
    }
  }

  container.innerHTML = html || '<div class="feed-empty">No matches for this filter.</div>';
}

function generatePlainEnglish(m, bItems, gItems) {
  const amt = bItems[0] ? fmtAmt(Math.abs(bItems[0].amount)) : '';
  const gDesc = gItems[0] ? gItems[0].description.split(' - ')[0] : '';
  if (m.rule_id==='R1') return `This bank check (${amt}) was matched to a book entry for ${esc(gDesc)} by check number.`;
  if (m.rule_id==='R2') {
    const diff = bItems.length && gItems.length ? Math.abs(bItems.reduce((s,b)=>s+Math.abs(b.amount),0) - gItems.reduce((s,g)=>s+(g.debit||g.credit),0)) : 0;
    return diff > 0.01 ? `Wire matched by reference, but there's a <strong>$${diff.toFixed(2)} amount difference</strong> that needs investigation.` : `This wire transfer (${amt}) was matched by wire reference ID.`;
  }
  if (m.rule_id==='R3') return `This ACH transaction (${amt}) was matched to a book entry by reference number.`;
  if (m.rule_id==='R4') return `This ${amt} transaction was matched by exact amount and date alignment within the clearing window.`;
  if (m.rule_id==='R5') return `Matched by vendor name similarity and amount (${amt}). Verify the descriptions match your records.`;
  if (m.rule_id==='R6') return `${bItems.length > 1 ? bItems.length+' bank items' : gItems.length+' book entries'} were grouped because they sum to the counterpart amount.`;
  if (m.rule_id==='MANUAL') return `Manually matched by reviewer. ${m.reasoning||''}`;
  return '';
}

function selectMatch(matchId) {
  const m = matches.find(x => x.id === matchId);
  if (!m) return;
  selectedMatchId = matchId;
  showReviewPanel(m);
  renderMatchExplorer();
}

// ── Row Selection → Review ──────────────────────────────────────────
function selectRow(id, type) {
  const m = getMatchFor(id, type);
  if (m) {
    selectedMatchId = m.id;
    showReviewPanel(m);
  } else {
    // Unmatched item — show match candidates
    showMatchCandidates(id, type);
  }
}

// ── Match Candidates Panel ───────────────────────────────────────────
let candidateSourceId = null;
let candidateSourceType = null;
let selectedCandidates = new Set();

function scoreCandidate(sourceTxn, candidate, sourceType) {
  const srcAmt = sourceType === 'bank' ? Math.abs(sourceTxn.amount) : (sourceTxn.debit || sourceTxn.credit);
  const candAmt = sourceType === 'bank' ? (candidate.debit || candidate.credit) : Math.abs(candidate.amount);
  const amtDiff = Math.abs(srcAmt - candAmt);
  const amtScore = amtDiff < 0.01 ? 100 : amtDiff < srcAmt * 0.02 ? 80 : amtDiff < srcAmt * 0.1 ? 50 : 0;
  const srcDate = new Date(sourceTxn.date);
  const candDate = new Date(candidate.date || candidate.effective_date);
  const daysDiff = Math.abs((srcDate - candDate) / 86400000);
  const dateScore = daysDiff <= 1 ? 30 : daysDiff <= 3 ? 20 : daysDiff <= 7 ? 10 : 0;
  return amtScore + dateScore;
}

function showMatchCandidates(txnId, sourceType) {
  candidateSourceId = txnId;
  candidateSourceType = sourceType;
  selectedCandidates.clear();

  if (activeRightTab !== 'review') switchRightTab('review', null);

  let sourceTxn, candidates;
  if (sourceType === 'bank') {
    sourceTxn = bankTxns.find(b => b.id === txnId);
    if (!sourceTxn) return;
    candidates = glEntries.filter(g => !matchedGL.has(g.id));
  } else {
    sourceTxn = glEntries.find(g => g.id === txnId);
    if (!sourceTxn) return;
    candidates = bankTxns.filter(b => !matchedBank.has(b.id));
  }

  // Score and sort candidates
  const scored = candidates.map(c => ({item: c, score: scoreCandidate(sourceTxn, c, sourceType)}))
    .sort((a, b) => b.score - a.score);

  const srcAmt = sourceType === 'bank' ? fmtAmt(sourceTxn.amount) : (sourceTxn.debit > 0 ? fmtPos(sourceTxn.debit) + ' Dr' : fmtPos(sourceTxn.credit) + ' Cr');
  const srcLabel = sourceType === 'bank' ? 'Bank' : 'Book';
  const candLabel = sourceType === 'bank' ? 'Book' : 'Bank';

  let html = `<div class="candidate-panel">
    <div class="candidate-header">
      <div class="candidate-source">
        <span class="source-badge source-${sourceType === 'bank' ? 'bank' : 'gl'}">${srcLabel}</span>
        <strong>${txnId}</strong> — ${esc(sourceTxn.description)}
        <div style="font-size:13px;font-weight:600;margin-top:4px">${srcAmt}</div>
      </div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:8px">Select matching ${candLabel} item(s) below:</div>
    </div>
    <div class="candidate-list">`;

  if (scored.length === 0) {
    html += '<div class="feed-empty">No unmatched candidates available.</div>';
  } else {
    scored.forEach(({item, score}) => {
      const id = item.id;
      const sel = selectedCandidates.has(id) ? ' selected' : '';
      const matchCls = score >= 100 ? ' exact-match' : score >= 50 ? ' close-match' : '';
      const pctLabel = score >= 100 ? 'Exact' : score >= 80 ? 'Close' : score >= 50 ? 'Possible' : '';

      let desc, amt, meta;
      if (sourceType === 'bank') {
        // Candidates are GL entries
        desc = esc(item.description);
        amt = item.debit > 0 ? fmtPos(item.debit) + ' Dr' : fmtPos(item.credit) + ' Cr';
        meta = `${item.date} &middot; ${item.journal_ref || ''} &middot; ${item.contra_name || ''}`;
      } else {
        // Candidates are bank transactions
        desc = esc(item.description);
        amt = fmtAmt(item.amount);
        const color = TXN_COLORS[item.txn_type] || '#8888AA';
        meta = `${item.date} &middot; <span class="txn-badge" style="background:${color};font-size:8px;padding:0 4px">${TXN_LABELS[item.txn_type] || item.txn_type}</span>`;
      }

      html += `<div class="candidate-item${matchCls}${sel}" onclick="toggleCandidate('${id}')">
        <div class="candidate-item-main">
          <span class="candidate-id">${id}</span>
          <span class="candidate-desc">${desc}</span>
          <span class="candidate-amt">${amt}</span>
        </div>
        <div class="candidate-item-meta">${meta} ${pctLabel ? `<span class="candidate-score">${pctLabel}</span>` : ''}</div>
      </div>`;
    });
  }

  html += `</div>
    <div class="candidate-actions">
      <button class="btn btn-primary" id="btnCandidateMatch" onclick="submitCandidateMatch()" disabled>Create Match</button>
      <button class="btn btn-ghost" onclick="clearReviewPanel()">Cancel</button>
    </div>
  </div>`;

  document.getElementById('reviewContent').innerHTML = html;
}

function toggleCandidate(id) {
  if (selectedCandidates.has(id)) selectedCandidates.delete(id);
  else selectedCandidates.add(id);
  // Update UI without full re-render
  document.querySelectorAll('.candidate-item').forEach(el => {
    const itemId = el.querySelector('.candidate-id')?.textContent;
    if (itemId) el.classList.toggle('selected', selectedCandidates.has(itemId));
  });
  const btn = document.getElementById('btnCandidateMatch');
  if (btn) btn.disabled = selectedCandidates.size === 0;
}

async function submitCandidateMatch() {
  if (!candidateSourceId || selectedCandidates.size === 0) return;
  const bankIds = candidateSourceType === 'bank' ? [candidateSourceId] : [...selectedCandidates];
  const glIds = candidateSourceType === 'bank' ? [...selectedCandidates] : [candidateSourceId];

  const r = await (await fetch('/api/match/manual', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({bank_ids: bankIds, gl_ids: glIds, memo: 'Manual match from candidate panel'}),
  })).json();

  if (r.success) {
    matches = r.matches;
    matchedBank = new Set(r.matched_bank);
    matchedGL = new Set(r.matched_gl);
    recReport = r.rec_report;
    clearReviewPanel();
    refresh(r.summary);
    addFeedEntry('MANUAL', `Manual match: ${bankIds.join('+')} ↔ ${glIds.join('+')}`, r.match.reasoning);
    agentNarrate(`Manual match created: <strong>${r.match.id}</strong>. Matched from candidate panel.`);
  } else {
    alert(r.error || 'Failed to create match');
  }
}

function showReviewPanel(m) {
  // Auto-switch to Review tab
  if (activeRightTab !== 'review') switchRightTab('review', null);
  const bItems = m.bank_ids.map(id => bankTxns.find(b => b.id===id)).filter(Boolean);
  const gItems = m.gl_ids.map(id => glEntries.find(g => g.id===id)).filter(Boolean);
  const confCls = m.confidence >= 0.8 ? 'conf-high' : m.confidence >= 0.6 ? 'conf-med' : 'conf-low';
  const tierLabel = m.approval_tier === 'auto_approved' ? 'Auto-Approved' : m.approval_tier === 'pending_review' ? 'Pending Review' : 'Exception';

  document.getElementById('reviewContent').innerHTML = `<div class="review-match">
    <h4>${m.id} — ${m.rule_name} (${RULE_LABELS[m.rule_id]||m.rule_id})</h4>
    ${bItems.map(b => `<div class="review-row"><span class="label">Bank</span><span class="value">${b.id} | ${b.date} | <span class="txn-badge" style="background:${TXN_COLORS[b.txn_type]}">${TXN_LABELS[b.txn_type]}</span> ${esc(b.description)} | ${fmtAmt(b.amount)}</span></div>`).join('')}
    ${gItems.map(g => `<div class="review-row"><span class="label">Book</span><span class="value">${g.id} | ${g.date} | ${esc(g.description)} | Dr:${fmtPos(g.debit)} Cr:${fmtPos(g.credit)} | ${g.journal_ref}</span></div>`).join('')}
    <div style="margin-top:8px"><span style="font-size:12px;color:var(--text-dim)">Confidence: ${(m.confidence*100).toFixed(0)}% — ${tierLabel}</span>
    <div class="confidence-bar"><div class="confidence-fill ${confCls}" style="width:${m.confidence*100}%"></div></div></div>
    <div class="review-reasoning">"${esc(m.reasoning)}"</div>
    <div class="review-actions">
      ${m.status==='pending'||m.status==='exception' ? `<button class="btn-approve" onclick="approveMatch('${m.id}')">Approve</button>` : `<span style="font-size:12px;color:var(--text-dim)">Status: <span class="status-pill ${m.status==='approved'?'status-approved':'status-unmatched'}">${m.status}${m.approved_by?' by '+m.approved_by:''}</span></span>`}
      <button class="btn-reject" onclick="rejectMatch('${m.id}')">${m.status==='approved'||m.approval_tier==='auto_approved' ? 'Unmatch' : 'Reject'}</button>
    </div>
  </div>`;
}
function clearReviewPanel() {
  document.getElementById('reviewContent').innerHTML = '<div class="review-empty">Select a transaction or match card to review details.</div>';
  selectedMatchId = null;
}

// ── Approve / Reject ────────────────────────────────────────────────
async function approveMatch(id) {
  const r = await (await fetch(`/api/match/${id}/approve`,{method:'POST'})).json();
  if (r.success) {
    const m = matches.find(x => x.id===id); if(m) { m.status='approved'; m.approved_by='reviewer'; }
    refresh(r.summary); addFeedEntry('system', `Match ${id} approved by reviewer.`);
    if (selectedMatchId===id) showReviewPanel(matches.find(x=>x.id===id));
  }
}
async function rejectMatch(id) {
  const r = await (await fetch(`/api/match/${id}/reject`,{method:'POST'})).json();
  if (r.success) {
    const m = matches.find(x => x.id===id); if(m) { m.status='rejected'; m.bank_ids.forEach(i=>matchedBank.delete(i)); m.gl_ids.forEach(i=>matchedGL.delete(i)); }
    refresh(r.summary); addFeedEntry('system', `Match ${id} rejected. Transactions returned to unmatched pool.`);
    if (selectedMatchId===id) clearReviewPanel();
  }
}
async function bulkApproveAll() {
  const pending = matches.filter(m => m.status==='pending'||m.status==='exception').map(m => m.id);
  if (!pending.length) return;
  const r = await (await fetch('/api/match/bulk-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({match_ids:pending})})).json();
  if (r.success) {
    pending.forEach(id => { const m=matches.find(x=>x.id===id); if(m) {m.status='approved';m.approved_by='reviewer';} });
    refresh(r.summary); addFeedEntry('system', `Bulk approved ${r.count} matches.`);
  }
}

// ── Reconciliation Actions ──────────────────────────────────────────
async function runFullReconciliation() {
  if (isProcessing) return;
  isProcessing = true; setButtons(true); setAgent(true); clearFeed();
  dismissWelcome();
  document.getElementById('matchExplorerScroll').classList.add('loading-shimmer');
  addFeedEntry('system', 'Starting full reconciliation...', 'Running all 6 matching rules in priority order.');

  const r = await (await fetch('/api/reconcile',{method:'POST'})).json();
  matches = r.matches; auditLog = r.audit_log;
  matchedBank = new Set(r.matched_bank); matchedGL = new Set(r.matched_gl);
  recReport = r.rec_report; currentStep = 5;

  // Animate feed by rule
  const byRule = {R1:[], R2:[], R3:[], R4:[], R5:[], R6:[]};
  matches.forEach(m => { if(byRule[m.rule_id]) byRule[m.rule_id].push(m); });

  for (const [rid, rmatches] of Object.entries(byRule)) {
    if (!rmatches.length) continue;
    await delay(200);
    const autoCount = rmatches.filter(m => m.approval_tier==='auto_approved').length;
    addFeedEntry('system', `Rule ${rid}: ${RULE_LABELS[rid]} — ${rmatches.length} match${rmatches.length>1?'es':''} (${autoCount} auto-approved)`);
    for (const m of rmatches.slice(0, 4)) {
      await delay(100);
      const bankStr = m.bank_ids.join(' + ');
      addFeedEntry(rid, `${bankStr} ↔ ${m.gl_ids.join(' + ')}`, m.reasoning, m.confidence, m.approval_tier);
    }
    if (rmatches.length > 4) addFeedEntry('system', `... and ${rmatches.length-4} more ${RULE_LABELS[rid]} matches`);
  }

  await delay(200);
  addFeedEntry('classify', `Classification: ${recReport.bank_side.outstanding_checks.items.length} outstanding checks, ${recReport.bank_side.deposits_in_transit.items.length} deposits in transit`);
  addFeedEntry('classify', `Book adjustments: $${recReport.book_side.interest_income.total.toFixed(2)} interest, $${recReport.book_side.bank_fees.total.toFixed(2)} fees, $${recReport.book_side.nsf_charges.total.toFixed(2)} NSF`);
  addFeedEntry('system', `Variance: $${recReport.variance.toFixed(2)} — ${recReport.is_reconciled ? 'RECONCILED' : 'Unresolved items require investigation'}`);

  document.getElementById('matchExplorerScroll').classList.remove('loading-shimmer');
  updateAll(r.summary, r.rec_report);
  setAgent(false); setButtons(false); isProcessing = false;
}

async function stepThrough() {
  if (isProcessing) return;
  if (currentStep >= 5) { addFeedEntry('system', 'All steps complete. Click Reset to start over.'); return; }
  isProcessing = true; setButtons(true); setAgent(true);
  if (currentStep === 0) { clearFeed(); dismissWelcome(); }

  const r = await (await fetch('/api/reconcile/step',{method:'POST'})).json();
  if (r.error) { addFeedEntry('system', r.error); isProcessing=false; setButtons(false); setAgent(false); return; }

  currentStep = r.step;
  matches.push(...(r.new_matches||[]));
  matchedBank = new Set(r.matched_bank); matchedGL = new Set(r.matched_gl);
  recReport = r.rec_report;

  const nm = r.new_matches||[];
  const autoCount = nm.filter(m => m.approval_tier==='auto_approved').length;
  addFeedEntry('system', `Step ${r.step}: ${r.label} — ${nm.length} match${nm.length!==1?'es':''} (${autoCount} auto-approved)`);

  for (const m of nm) {
    await delay(150);
    addFeedEntry(m.rule_id, `${m.bank_ids.join('+')} ↔ ${m.gl_ids.join('+')}`, m.reasoning, m.confidence, m.approval_tier);
    m.bank_ids.forEach(flashRow); m.gl_ids.forEach(flashRow);
  }

  if (r.done) {
    addFeedEntry('classify', `Classification complete. Variance: $${recReport.variance.toFixed(2)}`);
    addFeedEntry('system', recReport.is_reconciled ? 'RECONCILED — Adjusted balances match.' : 'Unresolved variance requires investigation.');
  }

  updateAll(r.summary, r.rec_report);
  setAgent(false); setButtons(false); isProcessing = false;
}

async function resetDemo() {
  await fetch('/api/reset',{method:'POST'});
  matches=[]; auditLog=[]; matchedBank=new Set(); matchedGL=new Set();
  recReport=null; currentStep=0; selectedMatchId=null; resolutions=[];
  renderBankTable(); renderGLTable(); updateTableCount();
  clearFeed(); clearReviewPanel();
  document.getElementById('recReport').classList.remove('visible');
  document.getElementById('jeReport').classList.remove('visible');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('welcomeCard').classList.remove('hidden');
  updateProgressTracker();
  document.getElementById('badgeMatchRate').textContent = '0%';
  document.getElementById('badgeVariance').textContent = '—';
  document.getElementById('badgeExceptions').textContent = '0';
  document.getElementById('badgeVarianceWrap').className = 'badge';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressText').textContent = 'Ready to reconcile';
  document.getElementById('progressPct').textContent = '0%';
  document.getElementById('btnBulkApprove').disabled = true;
  document.getElementById('btnExport').disabled = true;
}

async function exportReport() { window.open('/api/export?format=html', '_blank'); closeExportMenu(); }
function exportCSV() { window.open('/api/export?format=csv', '_blank'); closeExportMenu(); }
function toggleExportMenu() { document.getElementById('exportMenu').classList.toggle('hidden'); }
function closeExportMenu() { document.getElementById('exportMenu').classList.add('hidden'); }
function toggleTrackerExport() { document.getElementById('trackerExportMenu').classList.toggle('hidden'); }
function closeTrackerExport() { document.getElementById('trackerExportMenu').classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#exportDropdown')) closeExportMenu();
  if (!e.target.closest('#trackerExportDropdown')) closeTrackerExport();
});

// ── Refresh UI ──────────────────────────────────────────────────────
function refresh(summary) { renderBankTable(); renderGLTable(); renderMatchExplorer(); updateTableCount(); if(summary) updateBadges(summary); updateBulkBtn(); updateProgressTracker(); }

function updateAll(summary, rr) {
  renderBankTable(); renderGLTable(); if(activeTab==='all') renderMatchExplorer(); updateTableCount();
  if (summary) { updateBadges(summary); renderKPICards(summary); }
  if (rr) renderRecReport(rr);
  renderDonut(summary);
  renderReconItems(rr);
  renderAuditLog();
  updateProgressTracker();
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('btnExport').disabled = false;
  updateBulkBtn();
  // Smart default filter: show exceptions/pending first
  if (activeTab === 'all' && matches.length > 0) {
    if (matches.some(m => m.status === 'exception')) filterMatchExplorer('exceptions');
    else if (matches.some(m => m.status === 'pending')) filterMatchExplorer('pending');
  }
}

function updateBadges(s) {
  document.getElementById('badgeMatchRate').textContent = s.match_rate_bank + '%';
  const v = s.variance;
  if (v !== null && v !== undefined) {
    document.getElementById('badgeVariance').textContent = '$' + Math.abs(v).toFixed(2);
    const wrap = document.getElementById('badgeVarianceWrap');
    wrap.className = Math.abs(v) < 0.01 ? 'badge badge-green' : 'badge badge-red';
  }
  document.getElementById('badgeExceptions').textContent = s.pending_review + s.exceptions;
  document.getElementById('progressFill').style.width = s.match_rate_bank + '%';
  document.getElementById('progressText').textContent = `Step ${currentStep}/5 — ${s.match_rate_bank}% matched`;
  document.getElementById('progressPct').textContent = s.match_rate_bank + '%';
}

function updateBulkBtn() {
  const pending = matches.filter(m => m.status==='pending'||m.status==='exception').length;
  const btn = document.getElementById('btnBulkApprove');
  btn.disabled = pending === 0;
  btn.textContent = pending > 0 ? `Approve All Pending (${pending})` : 'Approve All Pending';
}

// ── Rec Report ──────────────────────────────────────────────────────
function renderRecReport(r) {
  const panel = document.getElementById('recReport');
  panel.classList.add('visible');

  document.getElementById('recBankEnding').textContent = fmtPos(r.bank_side.ending_balance);

  const ditBody = document.getElementById('recDIT');
  ditBody.innerHTML = r.bank_side.deposits_in_transit.items.map(i =>
    `<tr class="rec-item"><td>${esc(i.description)}</td><td class="amt">${fmtPos(i.amount)}</td></tr>`
  ).join('') || '<tr class="rec-item"><td colspan="2" style="color:var(--text-muted)">None</td></tr>';
  document.getElementById('recDITTotal').textContent = '+ ' + fmtPos(r.bank_side.deposits_in_transit.total);

  const ocBody = document.getElementById('recOC');
  ocBody.innerHTML = r.bank_side.outstanding_checks.items.map(i =>
    `<tr class="rec-item"><td>Check #${i.check_number} — ${esc(i.description)}</td><td class="amt">(${fmtPos(i.amount)})</td></tr>`
  ).join('') || '<tr class="rec-item"><td colspan="2" style="color:var(--text-muted)">None</td></tr>';
  document.getElementById('recOCTotal').textContent = '(' + fmtPos(r.bank_side.outstanding_checks.total) + ')';

  document.getElementById('recAdjBank').textContent = fmtPos(r.bank_side.adjusted_balance);
  document.getElementById('recBookBal').textContent = fmtPos(r.book_side.gl_balance);
  document.getElementById('recInterest').textContent = '+ ' + fmtPos(r.book_side.interest_income.total);
  document.getElementById('recFees').textContent = '(' + fmtPos(r.book_side.bank_fees.total) + ')';
  document.getElementById('recNSF').textContent = '(' + fmtPos(r.book_side.nsf_charges.total) + ')';
  document.getElementById('recAdjBook').textContent = fmtPos(r.book_side.adjusted_balance);

  const vEl = document.getElementById('recVariance');
  vEl.className = 'rec-variance ' + (r.is_reconciled ? 'balanced' : 'unbalanced');
  if (r.is_reconciled) {
    vEl.textContent = 'VARIANCE: $0.00 — RECONCILED';
    vEl.onclick = null;
    vEl.title = '';
  } else {
    vEl.innerHTML = `VARIANCE: $${Math.abs(r.variance).toFixed(2)} — <u>Click to view unresolved transaction</u>`;
    vEl.title = 'Click to jump to the transaction causing this variance';
    vEl.onclick = () => navigateToVarianceSource();
  }
}

function toggleRecReport() {
  const body = document.getElementById('recBody');
  const toggle = document.getElementById('recToggle');
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  toggle.classList.toggle('collapsed', !isHidden);
}

// ── Navigate to Variance Source ──────────────────────────────────────
function navigateToVarianceSource() {
  // Find matches with amount mismatches (pending/exception status, or wire mismatches)
  const varianceMatch = matches.find(m => {
    if (m.status === 'rejected') return false;
    const bItems = m.bank_ids.map(id => bankTxns.find(b => b.id===id)).filter(Boolean);
    const gItems = m.gl_ids.map(id => glEntries.find(g => g.id===id)).filter(Boolean);
    if (!bItems.length || !gItems.length) return false;
    const bAmt = bItems.reduce((s,b) => s + Math.abs(b.amount), 0);
    const gAmt = gItems.reduce((s,g) => s + (g.debit || g.credit), 0);
    return Math.abs(bAmt - gAmt) > 0.01;
  });

  if (varianceMatch) {
    // Switch to Match Explorer tab and select the match
    const meTab = document.querySelector('.tab[data-tab="all"]');
    if (meTab) switchTab('all', meTab);
    // Filter to show the relevant matches
    filterMatchExplorer('pending');
    selectedMatchId = varianceMatch.id;
    renderMatchExplorer();
    // Show it in review panel
    showReviewPanel(varianceMatch);
    // Scroll to the card
    setTimeout(() => {
      const card = document.querySelector(`.match-card.selected`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  } else {
    // Fallback: show unmatched items
    const meTab = document.querySelector('.tab[data-tab="all"]');
    if (meTab) switchTab('all', meTab);
    filterMatchExplorer('unmatched');
  }
}

// ── Dashboard Components ────────────────────────────────────────────
function renderDonut(s) {
  if (!s) return;
  const total = s.total_matches || 1;
  const rules = s.by_rule || {};
  const segments = [
    {label:'Check/Wire/ACH (R1-R3)', count:(rules.R1||0)+(rules.R2||0)+(rules.R3||0), color:'var(--green)'},
    {label:'Exact Amt+Date (R4)', count:rules.R4||0, color:'var(--blue)'},
    {label:'Fuzzy (R5)', count:rules.R5||0, color:'var(--yellow)'},
    {label:'Multi (R6)', count:rules.R6||0, color:'var(--purple)'},
  ];
  let gradient = '', pct = 0;
  segments.forEach(seg => {
    const segPct = seg.count / total * 100;
    gradient += `${seg.color} ${pct}% ${pct + segPct}%,`;
    pct += segPct;
  });
  const donut = document.getElementById('donut');
  donut.style.background = `conic-gradient(${gradient.slice(0,-1)})`;
  donut.style.mask = 'radial-gradient(circle,transparent 45%,black 46%)';
  donut.style.webkitMask = 'radial-gradient(circle,transparent 45%,black 46%)';
  document.getElementById('donutCenter').textContent = total;
  document.getElementById('donutLegend').innerHTML = segments.map(seg =>
    `<div class="legend-item"><span class="legend-dot" style="background:${seg.color}"></span>${seg.label}: ${seg.count}</div>`
  ).join('');
}

function renderReconItems(r) {
  if (!r) return;
  const list = document.getElementById('reconItemsList');
  let html = '';

  const resolvedIds = new Set((r.resolved_ids || []).concat(resolutions.map(x => x.item_id)));

  const cats = [
    {key:'outstanding_checks', label:'Outstanding Checks', items:r.bank_side.outstanding_checks.items, total:r.bank_side.outstanding_checks.total, sign:'-', resType:'acknowledge_timing', subType:'outstanding_check', isTiming:true},
    {key:'deposits_in_transit', label:'Deposits in Transit', items:r.bank_side.deposits_in_transit.items, total:r.bank_side.deposits_in_transit.total, sign:'+', resType:'acknowledge_timing', subType:'deposit_in_transit', isTiming:true},
    {key:'bank_fees', label:'Bank Fees (Not Booked)', items:r.book_side.bank_fees.items, total:r.book_side.bank_fees.total, sign:'-', resType:'book_fee', isTiming:false},
    {key:'interest', label:'Interest Income (Not Booked)', items:r.book_side.interest_income.items, total:r.book_side.interest_income.total, sign:'+', resType:'book_interest', isTiming:false},
    {key:'nsf', label:'NSF Charges (Not Booked)', items:r.book_side.nsf_charges.items, total:r.book_side.nsf_charges.total, sign:'-', resType:'book_nsf', isTiming:false},
  ];

  // Check for amount mismatch matches (pending with variance)
  const mismatchMatches = matches.filter(m => {
    if (m.status === 'rejected') return false;
    const bItems = m.bank_ids.map(id => bankTxns.find(b => b.id===id)).filter(Boolean);
    const gItems = m.gl_ids.map(id => glEntries.find(g => g.id===id)).filter(Boolean);
    if (!bItems.length || !gItems.length) return false;
    const bAmt = bItems.reduce((s,b) => s + Math.abs(b.amount), 0);
    const gAmt = gItems.reduce((s,g) => s + (g.debit || g.credit), 0);
    return Math.abs(bAmt - gAmt) > 0.01;
  });

  if (mismatchMatches.length) {
    html += '<div class="recon-category"><div class="recon-category-header"><span style="color:var(--red)">Amount Mismatches</span><span></span></div>';
    mismatchMatches.forEach(m => {
      const bAll = m.bank_ids.map(id => bankTxns.find(x => x.id===id)).filter(Boolean);
      const gAll = m.gl_ids.map(id => glEntries.find(x => x.id===id)).filter(Boolean);
      if (!bAll.length || !gAll.length) return;
      const b = bAll[0]; // for display label
      const bankTotal = bAll.reduce((s,x) => s + Math.abs(x.amount), 0);
      const glTotal = gAll.reduce((s,x) => s + (x.debit || x.credit), 0);
      const diff = Math.abs(bankTotal - glTotal);
      const resolved = resolvedIds.has(m.id);
      html += `<div class="recon-item ${resolved ? 'recon-item-resolved' : 'recon-item-error'}" style="cursor:pointer" onclick="navigateToVarianceSource()">
        <span>${m.id}: ${esc(b.description)} — Bank ${fmtPos(bankTotal)} vs Book ${fmtPos(glTotal)}</span>
        <span class="amt" style="display:flex;align-items:center;gap:6px">${fmtPos(diff)}
        ${resolved ? '' : `<button class="btn-resolve" onclick="event.stopPropagation();openResolveModal('adjust_mismatch',{matchId:'${m.id}',bankAmount:${bankTotal},glAmount:${glTotal},description:'${esc(b.description)}',itemId:'${m.id}'})">Resolve</button>`}
        </span></div>`;
    });
    html += '</div>';
  }

  cats.forEach(c => {
    if (!c.items.length) return;
    html += `<div class="recon-category"><div class="recon-category-header"><span>${c.label}</span><span>${c.sign}${fmtPos(c.total)}</span></div>`;
    c.items.forEach(i => {
      const resolved = resolvedIds.has(i.id);
      const itemCls = resolved ? 'recon-item-resolved' : (c.isTiming ? 'recon-item-timing' : 'recon-item-error');
      const btnHtml = resolved ? '' : (c.isTiming
        ? `<button class="btn-acknowledge" onclick="event.stopPropagation();openResolveModal('${c.resType}',{itemId:'${i.id}',amount:${i.amount},description:'${esc(i.description)}',subType:'${c.subType||''}'})">Acknowledge</button>`
        : `<button class="btn-resolve" onclick="event.stopPropagation();openResolveModal('${c.resType}',{itemId:'${i.id}',amount:${i.amount},description:'${esc(i.description)}'})">Book to GL</button>`);
      html += `<div class="recon-item ${itemCls}"><span>${esc(i.description)}</span><span class="amt" style="display:flex;align-items:center;gap:6px">${fmtPos(i.amount)} ${btnHtml}</span></div>`;
    });
    html += '</div>';
  });
  // Void pairs (informational)
  const voidPairs = r.reconciling_items?.void_pairs || [];
  if (voidPairs.length > 0) {
    html += '<div class="void-pair-section"><div class="void-pair-header">Void Pairs (excluded — net to $0)</div>';
    // Group by check number
    const byCheck = {};
    voidPairs.forEach(v => { const ck = v.check_number || '?'; if (!byCheck[ck]) byCheck[ck] = []; byCheck[ck].push(v); });
    Object.entries(byCheck).forEach(([ck, entries]) => {
      const issued = entries.find(e => e.credit > 0);
      const voided = entries.find(e => e.debit > 0);
      html += `<div class="void-pair-item">Check #${ck} — ${issued ? esc(issued.description) : 'Unknown'}: ${issued ? fmtPos(issued.credit) : '?'} issued, then voided (net $0)</div>`;
    });
    html += '</div>';
  }

  list.innerHTML = html || '<div class="feed-empty">No reconciling items.</div>';
}

function renderAuditLog() {
  const list = document.getElementById('auditList');
  const count = document.getElementById('auditCount');
  count.textContent = auditLog.length;
  if (!auditLog.length) { list.innerHTML = '<div class="feed-empty">No activity yet.</div>'; return; }
  // Fetch latest from state (audit log grows with user actions)
  fetch('/api/audit-log').then(r=>r.json()).then(log => {
    auditLog = log;
    count.textContent = log.length;
    list.innerHTML = log.slice(-30).reverse().map(e => {
      const time = e.timestamp ? e.timestamp.split('T')[1]?.slice(0,8) : '';
      return `<div class="audit-entry"><span class="audit-time">${time}</span> <span class="audit-action">${e.action}</span><br>${esc(e.details)}</div>`;
    }).join('');
  });
}

// ── Feed ────────────────────────────────────────────────────────────
function addFeedEntry(type, title, detail, confidence, tier) {
  const feed = document.getElementById('feedScroll');
  const empty = feed.querySelector('.feed-empty'); if(empty) empty.remove();
  const entry = document.createElement('div'); entry.className = 'feed-entry';
  const tagClass = type==='system' ? 'feed-tag-system' : type==='classify' ? 'feed-tag-classify' : `feed-tag-${type}`;
  const tagLabel = type==='system' ? 'Agent' : type==='classify' ? 'Classify' : RULE_LABELS[type]||type;
  let html = `<span class="feed-tag ${tagClass}">${tagLabel}</span> ${esc(title)}`;
  if (detail) html += `<div class="feed-detail">${esc(detail)}</div>`;
  if (confidence !== undefined) {
    const pct = (confidence*100).toFixed(0);
    const col = confidence>=0.95?'var(--green)':confidence>=0.75?'var(--yellow)':'var(--red)';
    html += `<span class="feed-confidence" style="color:${col}">${pct}%</span>`;
    if (tier) {
      const tCol = tier==='auto_approved'?'var(--accent)':tier==='pending_review'?'var(--yellow)':'var(--red)';
      const tLabel = tier==='auto_approved'?'AUTO':tier==='pending_review'?'REVIEW':'EXCEPTION';
      html += `<span class="feed-tier" style="background:${tCol}20;color:${tCol}">${tLabel}</span>`;
    }
  }
  entry.innerHTML = html;
  feed.appendChild(entry);
  feed.scrollTop = feed.scrollHeight;
}
function clearFeed() { document.getElementById('feedScroll').innerHTML = ''; }

// ── Helpers ─────────────────────────────────────────────────────────
function flashRow(id) { const r=document.querySelector(`tr[data-id="${id}"]`); if(r){r.classList.add('flash-match');setTimeout(()=>r.classList.remove('flash-match'),800);} }
function setAgent(on) {
  document.getElementById('agentStatus').classList.toggle('active',on);
  const cs = document.getElementById('chatAgentStatus');
  if (cs) { cs.textContent = on ? 'Working...' : 'Ready'; cs.classList.toggle('active', on); }
  // Auto-switch to Activity tab when agent starts working
  if (on && activeRightTab !== 'activity') switchRightTab('activity', null);
}
function setButtons(disabled) { document.getElementById('btnRunAll').disabled=disabled; document.getElementById('btnStep').disabled=disabled; }
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Resolution Modal ─────────────────────────────────────────────────
const ACCOUNT_OPTIONS = [
  {code:'1000',name:'Cash - Operating'},
  {code:'1100',name:'Accounts Receivable'},
  {code:'4000',name:'SaaS Revenue'},
  {code:'4100',name:'Professional Services Revenue'},
  {code:'6100',name:'Office Supplies'},
  {code:'6200',name:'Marketing & Advertising'},
  {code:'6300',name:'Salaries & Wages'},
  {code:'6600',name:'Software Subscriptions'},
  {code:'7400',name:'Bank Fees & Charges'},
  {code:'7900',name:'Miscellaneous Expense'},
  {code:'8100',name:'Interest Income'},
];

function accountSelect(id, selected) {
  return `<select id="${id}">${ACCOUNT_OPTIONS.map(a => `<option value="${a.code}" ${a.code===selected?'selected':''}>${a.code} — ${a.name}</option>`).join('')}</select>`;
}

function isItemResolved(itemId) {
  return resolutions.some(r => r.item_id === itemId);
}

function openResolveModal(type, data) {
  pendingResolveData = {type, ...data};
  const modal = document.getElementById('resolveModal');
  const body = document.getElementById('resolveModalBody');
  const title = document.getElementById('resolveTitle');
  const submitBtn = document.getElementById('btnSubmitResolve');

  if (type === 'book_fee') {
    title.textContent = 'Book Bank Fee to GL';
    body.innerHTML = `
      <div class="resolve-info">This bank fee appeared on the statement but hasn't been recorded in your books yet. Creating a journal entry will book it to the appropriate expense account.</div>
      <div class="resolve-amounts"><div class="resolve-amt-box"><div class="label">Fee Amount</div><div class="value red">${fmtPos(data.amount)}</div></div>
        <div class="resolve-amt-box"><div class="label">Transaction</div><div class="value">${data.itemId}</div></div></div>
      <div class="resolve-field"><label>Debit Account (Expense)</label>${accountSelect('resolveDebit','7400')}</div>
      <div class="resolve-field"><label>Credit Account</label>${accountSelect('resolveCredit','1000')}</div>
      <div class="resolve-field"><label>Memo</label><input id="resolveMemo" value="Book ${esc(data.description)} per bank statement"></div>
      <div class="je-preview"><div class="je-preview-title">Journal Entry Preview</div>
        <div class="je-preview-row"><span class="acct">Dr  Bank Fees & Charges (7400)</span><span>${fmtPos(data.amount)}</span></div>
        <div class="je-preview-row"><span class="acct">&nbsp;&nbsp;Cr  Cash - Operating (1000)</span><span>${fmtPos(data.amount)}</span></div></div>`;
    submitBtn.textContent = 'Create Journal Entry';
  } else if (type === 'book_interest') {
    title.textContent = 'Book Interest Income';
    body.innerHTML = `
      <div class="resolve-info">Interest income was credited on the bank statement but hasn't been recorded in your books yet.</div>
      <div class="resolve-amounts"><div class="resolve-amt-box"><div class="label">Interest Amount</div><div class="value green">${fmtPos(data.amount)}</div></div>
        <div class="resolve-amt-box"><div class="label">Transaction</div><div class="value">${data.itemId}</div></div></div>
      <div class="resolve-field"><label>Debit Account</label>${accountSelect('resolveDebit','1000')}</div>
      <div class="resolve-field"><label>Credit Account (Income)</label>${accountSelect('resolveCredit','8100')}</div>
      <div class="resolve-field"><label>Memo</label><input id="resolveMemo" value="Book interest income per bank statement"></div>
      <div class="je-preview"><div class="je-preview-title">Journal Entry Preview</div>
        <div class="je-preview-row"><span class="acct">Dr  Cash - Operating (1000)</span><span>${fmtPos(data.amount)}</span></div>
        <div class="je-preview-row"><span class="acct">&nbsp;&nbsp;Cr  Interest Income (8100)</span><span>${fmtPos(data.amount)}</span></div></div>`;
    submitBtn.textContent = 'Create Journal Entry';
  } else if (type === 'book_nsf') {
    title.textContent = 'Book NSF Charge';
    body.innerHTML = `
      <div class="resolve-info">An NSF (non-sufficient funds) charge was debited by the bank. This needs to be booked as a receivable or expense — the original deposit was reversed.</div>
      <div class="resolve-amounts"><div class="resolve-amt-box"><div class="label">NSF Amount</div><div class="value red">${fmtPos(data.amount)}</div></div>
        <div class="resolve-amt-box"><div class="label">Transaction</div><div class="value">${data.itemId}</div></div></div>
      <div class="resolve-field"><label>Debit Account</label>${accountSelect('resolveDebit','1100')}</div>
      <div class="resolve-field"><label>Credit Account</label>${accountSelect('resolveCredit','1000')}</div>
      <div class="resolve-field"><label>Memo</label><input id="resolveMemo" value="Book NSF charge — ${esc(data.description)}"></div>`;
    submitBtn.textContent = 'Create Journal Entry';
  } else if (type === 'adjust_mismatch') {
    const diff = Math.abs(data.bankAmount - data.glAmount);
    title.textContent = 'Resolve Amount Mismatch';
    body.innerHTML = `
      <div class="resolve-info">The bank and book amounts don't match. A <strong>${fmtPos(diff)}</strong> adjustment is needed to reconcile this difference.</div>
      <div class="resolve-amounts">
        <div class="resolve-amt-box"><div class="label">Bank Amount</div><div class="value">${fmtPos(data.bankAmount)}</div></div>
        <div class="resolve-amt-box"><div class="label">Book Amount</div><div class="value">${fmtPos(data.glAmount)}</div></div>
      </div>
      <div class="resolve-amounts"><div class="resolve-amt-box" style="grid-column:span 2"><div class="label">Difference</div><div class="value red">${fmtPos(diff)}</div></div></div>
      <div class="resolve-field"><label>Offset Account (where to book the difference)</label>${accountSelect('resolveDebit','4100')}</div>
      <div class="resolve-field"><label>Memo</label><input id="resolveMemo" value="Adjust ${fmtPos(diff)} variance — ${esc(data.description || '')}"></div>`;
    pendingResolveData.amount = diff;
    submitBtn.textContent = `Create ${fmtPos(diff)} Adjusting Entry`;
  } else if (type === 'acknowledge_timing') {
    title.textContent = 'Acknowledge Timing Difference';
    body.innerHTML = `
      <div class="resolve-info">This is a <strong>timing difference</strong>, not an error. ${data.subType === 'outstanding_check' ? 'This check was issued but hasn\'t cleared the bank yet. It will appear on next month\'s bank statement.' : 'This deposit was recorded in the books but hasn\'t appeared on the bank statement yet. It will clear in the next period.'}</div>
      <div class="resolve-amounts"><div class="resolve-amt-box"><div class="label">${data.subType === 'outstanding_check' ? 'Check Amount' : 'Deposit Amount'}</div><div class="value">${fmtPos(data.amount)}</div></div>
        <div class="resolve-amt-box"><div class="label">Expected to Clear</div><div class="value" style="font-size:14px">Next Period</div></div></div>
      <p style="font-size:12px;color:var(--text-dim)">No journal entry is needed — this is a normal part of the reconciliation process.</p>`;
    submitBtn.textContent = 'Acknowledge';
  }

  modal.classList.remove('hidden');
}

function closeResolveModal() {
  document.getElementById('resolveModal').classList.add('hidden');
  pendingResolveData = null;
}

async function submitResolution() {
  if (!pendingResolveData) return;
  const d = pendingResolveData;
  const body = {
    type: d.type,
    item_id: d.itemId || '',
    match_id: d.matchId || '',
    amount: d.amount,
    memo: document.getElementById('resolveMemo')?.value || '',
    debit_account: document.getElementById('resolveDebit')?.value || '',
    credit_account: document.getElementById('resolveCredit')?.value || '',
  };

  const r = await (await fetch('/api/resolve', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})).json();
  if (r.success) {
    resolutions = r.resolutions;
    recReport = r.rec_report;
    _state_summary = r.summary;
    closeResolveModal();
    updateBadges(r.summary);
    renderRecReport(r.rec_report);
    renderReconItems(r.rec_report);
    renderAuditLog();
    if (activeTab === 'all') renderMatchExplorer();
    fetchAndRenderJEReport();
    updateProgressTracker();
    addFeedEntry('system', `Resolution created: ${r.resolution.type} — $${r.resolution.amount.toFixed(2)}`);
    agentNarrate(`I've created an adjusting journal entry: <strong>${r.resolution.journal_entry ? r.resolution.journal_entry.je_ref : 'Acknowledged'}</strong>. ${r.rec_report.is_reconciled ? 'The reconciliation is now <strong>balanced</strong> — variance is $0.00!' : `Remaining variance: <strong>$${Math.abs(r.rec_report.variance).toFixed(2)}</strong>.`}`);
  }
}

async function undoResolution(resId) {
  const r = await (await fetch(`/api/resolve/${resId}`, {method:'DELETE'})).json();
  if (r.success) {
    resolutions = r.resolutions;
    recReport = r.rec_report;
    updateBadges(r.summary);
    renderRecReport(r.rec_report);
    renderReconItems(r.rec_report);
    renderAuditLog();
    if (activeTab === 'all') renderMatchExplorer();
    fetchAndRenderJEReport();
    updateProgressTracker();
    addFeedEntry('system', `Resolution ${resId} undone.`);
  }
}

// ── JE Report Rendering ──────────────────────────────────────────────
async function fetchAndRenderJEReport() {
  const r = await (await fetch('/api/je-report')).json();
  const panel = document.getElementById('jeReport');
  if (r.entries && r.entries.length > 0) {
    panel.classList.add('visible');
    document.getElementById('jeCount').textContent = r.entries.length;
    document.getElementById('jeTableBody').innerHTML = r.entries.map(e => `
      <tr><td>${e.je_ref}</td><td>${e.date}</td><td>${esc(e.debit_account)}</td><td>${esc(e.credit_account)}</td>
      <td class="num">${fmtPos(e.amount)}</td><td>${esc(e.memo)}</td>
      <td><button class="btn-undo" onclick="undoResolution('${e.resolution_id}')">Undo</button></td></tr>`).join('');
    document.getElementById('jeTableFoot').innerHTML = `<tr><td colspan="4" style="text-align:right">Total Adjustments</td><td class="num">${fmtPos(r.summary.total_adjustment_amount)}</td><td colspan="2"></td></tr>`;
    const s = r.summary;
    const statusHtml = s.is_reconciled
      ? '<span style="color:var(--green)">FULLY RECONCILED</span>'
      : `<span style="color:var(--yellow)">${s.completion_text || (s.items_resolved + ' of ' + s.items_total + ' items resolved')}</span>`;
    document.getElementById('jeSummary').innerHTML = `<strong>${s.journal_entries_created}</strong> journal entries created. <strong>${s.items_acknowledged}</strong> timing items acknowledged. Variance: <strong>$${Math.abs(s.final_variance||0).toFixed(2)}</strong> — ${statusHtml}`;
  } else {
    panel.classList.remove('visible');
  }
}

function toggleJEReport() {
  const body = document.getElementById('jeBody');
  const toggle = document.getElementById('jeToggle');
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  toggle.classList.toggle('collapsed', !isHidden);
}

// ── Manual Match Mode ────────────────────────────────────────────────
let manualMatchMode = false;
let selectedBankIds = new Set();
let selectedGLIds = new Set();

function toggleManualMatchMode() {
  manualMatchMode = !manualMatchMode;
  selectedBankIds.clear();
  selectedGLIds.clear();
  document.getElementById('manualMatchBar').classList.toggle('hidden', !manualMatchMode);
  updateManualMatchSummary();
  // Re-render to add/remove selectable state
  if (activeTab === 'all') renderMatchExplorer();
  // Also ensure we're on the unmatched filter so items are visible
  if (manualMatchMode) filterMatchExplorer('unmatched');
}

function toggleManualSelect(id, type) {
  if (!manualMatchMode) return;
  const set = type === 'bank' ? selectedBankIds : selectedGLIds;
  if (set.has(id)) set.delete(id); else set.add(id);
  updateManualMatchSummary();
  renderMatchExplorer(); // re-render to update selection highlights
}

function updateManualMatchSummary() {
  const bc = selectedBankIds.size;
  const gc = selectedGLIds.size;
  const summary = document.getElementById('manualMatchSummary');
  const btn = document.getElementById('btnCreateManualMatch');

  if (bc === 0 && gc === 0) {
    summary.textContent = 'Select bank and GL items from the Needs Attention section below';
    btn.disabled = true;
  } else {
    const bankAmt = [...selectedBankIds].reduce((s, id) => {
      const t = bankTxns.find(b => b.id === id);
      return s + (t ? Math.abs(t.amount) : 0);
    }, 0);
    const glAmt = [...selectedGLIds].reduce((s, id) => {
      const g = glEntries.find(x => x.id === id);
      return s + (g ? (g.debit || g.credit) : 0);
    }, 0);
    summary.innerHTML = `<strong>${bc} bank</strong> (${fmtPos(bankAmt)}) + <strong>${gc} GL</strong> (${fmtPos(glAmt)}) selected`;
    btn.disabled = !(bc > 0 && gc > 0);
  }
}

async function submitManualMatch() {
  if (selectedBankIds.size === 0 || selectedGLIds.size === 0) return;

  const body = {
    bank_ids: [...selectedBankIds],
    gl_ids: [...selectedGLIds],
    memo: 'Manual match by reviewer',
  };

  const r = await (await fetch('/api/match/manual', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  })).json();

  if (r.success) {
    matches = r.matches;
    matchedBank = new Set(r.matched_bank);
    matchedGL = new Set(r.matched_gl);
    recReport = r.rec_report;

    toggleManualMatchMode(); // exit mode
    refresh(r.summary);
    addFeedEntry('MANUAL', `Manual match: ${body.bank_ids.join('+')} ↔ ${body.gl_ids.join('+')}`, r.match.reasoning);
    agentNarrate(`Manual match created: <strong>${r.match.id}</strong>. ${body.bank_ids.length} bank + ${body.gl_ids.length} GL items paired.`);
  } else {
    alert(r.error || 'Failed to create manual match');
  }
}

// ── Agent Chat System ───────────────────────────────────────────────
let chatOpen = false;
let chatUnreadCount = 0;

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chatWindow').classList.toggle('hidden', !chatOpen);
  document.getElementById('chatToggle').classList.toggle('open', chatOpen);
  document.getElementById('chatWidget').classList.toggle('chat-open', chatOpen);
  document.body.classList.toggle('chat-open-mobile', chatOpen);
  if (chatOpen) {
    chatUnreadCount = 0;
    document.getElementById('chatUnread').classList.add('hidden');
    const msgs = document.getElementById('chatMessages');
    msgs.scrollTop = msgs.scrollHeight;
    document.getElementById('chatInput').focus();
  }
}

function addChatMsg(sender, text) {
  const msgs = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg-${sender}`;
  div.innerHTML = `<div class="chat-msg-avatar">${sender === 'ai' ? 'AI' : 'You'}</div>
    <div class="chat-msg-bubble">${text}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;

  // Update unread badge if chat is closed
  if (!chatOpen && sender === 'ai') {
    chatUnreadCount++;
    const badge = document.getElementById('chatUnread');
    badge.textContent = chatUnreadCount;
    badge.classList.remove('hidden');
  }
}

function showChatLoading() {
  const msgs = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'chat-msg chat-msg-ai chat-msg-loading';
  div.id = 'chatLoading';
  div.innerHTML = `<div class="chat-msg-avatar">AI</div>
    <div class="chat-msg-bubble"><div class="chat-dots"><span></span><span></span><span></span></div></div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeChatLoading() {
  const el = document.getElementById('chatLoading');
  if (el) el.remove();
}

// Agent narration during reconciliation — called from step/runFull
function agentNarrate(text) {
  addChatMsg('ai', text);
}

// Hook into reconciliation flow
const _origRunFull = runFullReconciliation;
runFullReconciliation = async function() {
  agentNarrate("Starting full reconciliation. I'll apply all 6 matching rules in priority order against 40 bank transactions and 44 GL entries. Let me work through this...");
  await _origRunFull();
  const s = recReport;
  if (s) {
    const summary = [
      `Done! Here's what I found:`,
      `<strong>${matches.length} matches</strong> across 6 rules.`,
      `<strong>${matches.filter(m=>m.approval_tier==='auto_approved').length}</strong> were auto-approved (confidence ≥95%).`,
      `<strong>${matches.filter(m=>m.status==='pending').length}</strong> need your review.`,
      ``,
      `The rec report shows a <strong>$${Math.abs(s.variance).toFixed(2)} variance</strong> — that's the wire from Epsilon Ventures where the bank received $10,000 but the GL has $10,500. Someone needs to investigate whether the invoice was wrong or if there's a $500 short-payment.`,
      ``,
      `I also classified <strong>${s.bank_side.outstanding_checks.items.length} outstanding checks</strong> and <strong>${s.bank_side.deposits_in_transit.items.length} deposit in transit</strong>. The bank fees and interest haven't been booked yet — you'll need adjusting journal entries for those.`,
      ``,
      `Ask me about any specific transaction or match if you want details!`,
    ].join('<br>');
    agentNarrate(summary);
  }
};

const _origStep = stepThrough;
stepThrough = async function() {
  const prevStep = currentStep;
  const stepNames = {
    0: "I'm starting with <strong>Reference Matching</strong> — this is the highest-confidence pass. I'll match check numbers, wire references, and ACH reference IDs. These are essentially guaranteed matches.",
    1: "Now running <strong>Exact Amount + Date</strong> matching. I'm looking for transactions where the dollar amount matches exactly and the dates align within each transaction type's clearing window (e.g., checks take 3-7 days, ACH 1-2 days).",
    2: "Running <strong>Fuzzy Description + Amount</strong> matching. I normalize vendor names (e.g., 'AMZN MKTP' → 'Amazon') and score on vendor match, amount similarity, and date proximity. This catches transactions where references are missing.",
    3: "Looking for <strong>Many-to-One groupings</strong> — cases where multiple GL entries sum to a single bank transaction (like batch payments). This is common with AP batch runs.",
    4: "Final step: <strong>Classifying reconciling items</strong> and building the standard bank rec report. Unmatched GL checks become outstanding checks, unmatched GL deposits become deposits in transit, and unmatched bank items (fees, interest, NSF) become book-side adjustments.",
  };
  if (stepNames[prevStep]) agentNarrate(stepNames[prevStep]);
  await _origStep();
  if (currentStep > prevStep) {
    const nm = matches.filter(m => !_prevMatchIds.has(m.id));
    if (nm.length > 0) {
      agentNarrate(`Found <strong>${nm.length} match${nm.length>1?'es':''}</strong> in this pass. ${nm.filter(m=>m.approval_tier==='auto_approved').length} auto-approved, ${nm.filter(m=>m.status==='pending').length} pending your review.`);
    } else if (currentStep < 5) {
      agentNarrate("No new matches found in this pass — moving on.");
    }
    if (currentStep === 5 && recReport) {
      agentNarrate(`Reconciliation complete. Variance: <strong>$${Math.abs(recReport.variance).toFixed(2)}</strong>. ${recReport.is_reconciled ? 'Fully reconciled!' : 'There are unresolved items to investigate.'}`);
    }
  }
};

// Track previous matches to know what's new in each step
let _prevMatchIds = new Set();
const _origStepInner = stepThrough;
const __stepWrapper = stepThrough;
// Patch: capture match IDs before each step
const _realStep = __stepWrapper;
stepThrough = async function() {
  _prevMatchIds = new Set(matches.map(m => m.id));
  await _realStep();
};

function handleChatSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  addChatMsg('user', esc(q));

  showChatLoading();
  setTimeout(() => {
    removeChatLoading();
    const response = generateChatResponse(q);
    addChatMsg('ai', response);
  }, 600);
}

function generateChatResponse(q) {
  const ql = q.toLowerCase();

  // Transaction lookup
  const bnkMatch = q.match(/BNK-(\d+)/i);
  if (bnkMatch) {
    const txn = bankTxns.find(t => t.id === `BNK-${bnkMatch[1].padStart(3,'0')}`);
    if (txn) {
      const m = getMatchFor(txn.id, 'bank');
      let resp = `<strong>${txn.id}</strong> — ${esc(txn.description)}<br>Date: ${txn.date} | Type: ${TXN_LABELS[txn.txn_type]} | Amount: ${fmtAmt(txn.amount)}`;
      if (txn.check_number) resp += ` | Check #${txn.check_number}`;
      if (txn.reference) resp += ` | Ref: ${txn.reference}`;
      if (m) resp += `<br><br>Matched to ${m.gl_ids.join(', ')} via <strong>${m.rule_name}</strong> (${(m.confidence*100).toFixed(0)}% confidence, ${m.status}).`;
      else resp += '<br><br>Not currently matched to any GL entry.';
      return resp;
    }
  }
  const glMatch = q.match(/GL-(\d+)/i);
  if (glMatch) {
    const gl = glEntries.find(g => g.id === `GL-${glMatch[1].padStart(3,'0')}`);
    if (gl) {
      const m = getMatchFor(gl.id, 'gl');
      let resp = `<strong>${gl.id}</strong> — ${esc(gl.description)}<br>Date: ${gl.date} | Dr: ${fmtPos(gl.debit)} | Cr: ${fmtPos(gl.credit)} | ${gl.contra_name} | ${gl.journal_ref}`;
      if (m) resp += `<br><br>Matched to ${m.bank_ids.join(', ')} via <strong>${m.rule_name}</strong> (${(m.confidence*100).toFixed(0)}%, ${m.status}).`;
      else resp += '<br><br>Not currently matched. Check if this is an outstanding check, deposit in transit, or timing difference.';
      return resp;
    }
  }
  const matchLookup = q.match(/MATCH-(\d+)/i);
  if (matchLookup) {
    const m = matches.find(x => x.id === `MATCH-${matchLookup[1].padStart(3,'0')}`);
    if (m) return `<strong>${m.id}</strong> — ${m.rule_name}<br>Bank: ${m.bank_ids.join(', ')} ↔ GL: ${m.gl_ids.join(', ')}<br>Confidence: ${(m.confidence*100).toFixed(0)}% | Status: ${m.status}<br><br>"${esc(m.reasoning)}"`;
  }

  // ── What is a bank reconciliation? ──
  if ((ql.includes('what is') || ql.includes('what\'s')) && (ql.includes('bank rec') || ql.includes('reconciliation'))) {
    return `A <strong>bank reconciliation</strong> is the process of comparing your company's internal accounting records (the General Ledger) against the bank statement to make sure they agree.<br><br><strong>Why it matters:</strong> Your books and the bank rarely match perfectly at any given time. Checks take days to clear, bank fees aren't always recorded immediately, and occasionally there are errors. The rec identifies every difference, explains it, and produces the journal entries needed to bring the books in line.<br><br><strong>Who does it:</strong> Typically an accountant or controller performs this monthly as part of the month-end close. This demo automates the matching and classification steps that would normally take hours.`;
  }

  // ── What should I do next? ──
  if (ql.includes('what should') || ql.includes('next step') || ql.includes('what now') || ql.includes('what do i do')) {
    if (!matches.length) return "Start by clicking <strong>Run Full Recon</strong> to match all bank transactions to GL entries, or <strong>Step Through</strong> to see each rule fire one at a time.";
    const pending = matches.filter(m => m.status==='pending').length;
    const exceptions = matches.filter(m => m.status==='exception').length;
    const unresolvedItems = recReport ? (recReport.book_side.bank_fees.items.length + recReport.book_side.interest_income.items.length + recReport.book_side.nsf_charges.items.length) : 0;
    const hasVariance = recReport && Math.abs(recReport.variance) > 0.01;
    const resolvedCount = resolutions.length;

    let steps = [];
    if (pending + exceptions > 0) steps.push(`<strong>Review ${pending + exceptions} pending matches</strong> — click on match cards to approve or reject them. Start with exceptions (lowest confidence).`);
    if (hasVariance && !resolutions.some(r => r.type==='adjust_mismatch')) steps.push(`<strong>Resolve the $${Math.abs(recReport.variance).toFixed(2)} variance</strong> — scroll down to the Reconciliation Dashboard, find "Amount Mismatches" and click Resolve.`);
    if (unresolvedItems > 0) steps.push(`<strong>Book ${unresolvedItems} bank items</strong> to the GL — bank fees, interest, and NSF charges need adjusting journal entries. Click "Book to GL" next to each item in the dashboard.`);
    if (recReport && recReport.bank_side.outstanding_checks.items.length > 0) steps.push(`<strong>Acknowledge timing items</strong> — outstanding checks and deposits in transit are normal and just need to be acknowledged.`);
    if (steps.length === 0 && recReport?.is_reconciled) return "You're done! The reconciliation is <strong>balanced</strong>. You can export the final report (HTML or CSV) using the Export button.";
    if (steps.length === 0) return "Run reconciliation first, then I'll guide you through the review and resolution steps.";
    return `Here's what to do next:<br><br>${steps.map((s,i) => `${i+1}. ${s}`).join('<br><br>')}`;
  }

  // ── Adjusting journal entries ──
  if (ql.includes('adjusting') || ql.includes('journal entr') || (ql.includes('je') && ql.length < 30) || ql.includes('aje')) {
    if (!recReport) return "Run reconciliation first. Adjusting entries are created during the resolution phase.";
    return `<strong>Adjusting Journal Entries (AJEs)</strong> are entries your accountant books to record items that appeared on the bank statement but weren't in the GL yet.<br><br>For this reconciliation, you'll need AJEs for:<br>• <strong>Bank fees</strong>: Dr Bank Charges (7400), Cr Cash (1000) — ${fmtPos(recReport.book_side.bank_fees.total)}<br>• <strong>Interest income</strong>: Dr Cash (1000), Cr Interest Income (8100) — ${fmtPos(recReport.book_side.interest_income.total)}<br>• <strong>NSF charges</strong>: Dr A/R (1100), Cr Cash (1000) — ${fmtPos(recReport.book_side.nsf_charges.total)}<br>${Math.abs(recReport.variance) > 0.01 ? `• <strong>Wire variance</strong>: Dr Revenue (4100), Cr Cash (1000) — $${Math.abs(recReport.variance).toFixed(2)}` : ''}<br><br>Click "Book to GL" or "Resolve" next to each item in the dashboard to create these entries.`;
  }

  // ── Timing vs errors ──
  if (ql.includes('timing') || (ql.includes('difference') && (ql.includes('outstanding') || ql.includes('transit')))) {
    return `Great question — there are two types of reconciling items:<br><br><strong>Timing Differences (normal):</strong><br>• <strong>Outstanding checks</strong> — you wrote a check, recorded it in the GL, but the recipient hasn't cashed it yet. It'll clear next month.<br>• <strong>Deposits in transit</strong> — you deposited money and recorded it, but it hadn't hit the bank by statement date.<br>These don't need journal entries — just acknowledgement.<br><br><strong>Errors & Unrecorded Items (need action):</strong><br>• <strong>Bank fees/interest/NSF</strong> — the bank recorded these but you haven't yet. Need AJEs.<br>• <strong>Amount mismatches</strong> — the bank amount differs from what you recorded. Could be a pricing error, short-payment, or data entry mistake. Need investigation and an adjusting entry.`;
  }

  // ── Confidence / approval tiers ──
  if (ql.includes('confidence') || ql.includes('approval') || ql.includes('tier') || ql.includes('auto-approv')) {
    return `The engine uses a <strong>three-tier approval system</strong> based on match confidence:<br><br>• <strong>Auto-Approved (≥95%)</strong> — High certainty matches like check number or wire reference matches. No human review needed.<br>• <strong>Pending Review (75-94%)</strong> — Probable matches but some uncertainty — maybe the amounts matched but descriptions are slightly different. A human should verify.<br>• <strong>Exception (<75%)</strong> — Low confidence. Might be correct, might not. Requires investigation before approval.<br><br>This mimics how real reconciliation software works — the goal is to automate the obvious matches and only surface the ambiguous ones for human judgment.`;
  }

  // ── Investigate / mismatch ──
  if (ql.includes('investigate') || ql.includes('mismatch')) {
    return `To investigate an amount mismatch:<br><br>1. <strong>Check the source documents</strong> — pull the original invoice, contract, or PO to verify the expected amount.<br>2. <strong>Contact the counterparty</strong> — if it's a customer payment, check if they applied a discount, deducted a fee, or made a partial payment.<br>3. <strong>Review the GL posting</strong> — verify the journal entry amount. Could be a data entry error when the payment was recorded.<br>4. <strong>Check for FX or wire fees</strong> — international wires often have intermediary bank fees deducted in transit.<br>5. <strong>Create an adjusting entry</strong> — once you know the cause, click "Resolve" to book the difference to the appropriate account.<br><br>For the Epsilon Ventures $500 variance in this demo: the bank received $10,000 but the GL shows $10,500. This likely means the invoice was for $10,500 but the client short-paid by $500.`;
  }

  // ── Reconciling item categories ──
  if (ql.includes('reconciling item') || ql.includes('categories') || ql.includes('what are the items')) {
    return `Reconciling items fall into <strong>5 categories</strong>:<br><br><strong>Bank-Side Adjustments (add/subtract from bank balance):</strong><br>• <strong>Outstanding Checks</strong> — checks you wrote that haven't cleared the bank yet<br>• <strong>Deposits in Transit</strong> — deposits you made that aren't on the statement yet<br><br><strong>Book-Side Adjustments (need journal entries):</strong><br>• <strong>Bank Fees</strong> — charges the bank applied (maintenance fees, wire fees) that you haven't booked<br>• <strong>Interest Income</strong> — interest the bank paid you that hasn't been recorded<br>• <strong>NSF Charges</strong> — bounced check charges where a deposited check was returned<br><br>The goal is to adjust both sides until the adjusted bank balance equals the adjusted book balance (variance = $0).`;
  }

  // ── Resolve / how to fix ──
  if (ql.includes('resolve') || ql.includes('how do i fix') || ql.includes('how to fix')) {
    if (!recReport) return "Run reconciliation first, then I'll guide you through resolving items.";
    return `To resolve items, scroll to the <strong>Reconciliation Dashboard</strong> at the bottom. Each reconciling item has an action button:<br><br>• <strong>"Book to GL"</strong> (red items) — Creates an adjusting journal entry. Pre-filled with the right accounts.<br>• <strong>"Acknowledge"</strong> (blue items) — For timing differences like outstanding checks. No JE needed.<br>• <strong>"Resolve"</strong> (on mismatches) — Opens a modal to book the amount difference.<br><br>After resolving all items, the variance drops to $0 and the reconciliation shows as balanced. You can then export the final report with all journal entries included.`;
  }

  // ── Materiality ──
  if (ql.includes('materiality') || ql.includes('threshold') || ql.includes('immaterial')) {
    return `<strong>Materiality</strong> in reconciliation is the threshold below which differences are considered too small to investigate individually.<br><br>In practice:<br>• Small companies might write off variances under $5-10<br>• Larger companies have formal materiality thresholds tied to financial statement materiality (often 1-5% of a line item)<br>• Auditors expect all reconciling items above materiality to be explained and resolved<br><br>In this demo, every penny is tracked (materiality = $0.01). In production, you'd configure a threshold and auto-resolve immaterial items to a suspense or rounding account.`;
  }

  // ── Month-end close ──
  if (ql.includes('month end') || ql.includes('month-end') || ql.includes('close process') || ql.includes('closing')) {
    return `Bank reconciliation is a <strong>critical step in the month-end close</strong>. Here's where it fits:<br><br>1. <strong>Close sub-ledgers</strong> (AP, AR, Payroll) — ensure all transactions are posted<br>2. <strong>Bank reconciliation</strong> ← you are here — match bank to GL, book adjustments<br>3. <strong>Review and book accruals</strong> — prepaid expenses, deferred revenue, etc.<br>4. <strong>Intercompany eliminations</strong> — if multi-entity<br>5. <strong>Management review</strong> — flux analysis, variance investigation<br>6. <strong>Financial statements</strong> — generate trial balance, P&L, balance sheet<br><br>Bank rec is typically done in the first 2-3 days after month-end. The adjusting JEs from the rec directly affect the cash balance on the balance sheet.`;
  }

  // ── Original keyword responses ──
  if (ql.includes('variance') || ql.includes('unresolved')) {
    if (!recReport) return "Run the reconciliation first and I'll tell you about the variance.";
    if (recReport.is_reconciled) return "The reconciliation is <strong>balanced</strong> — variance is $0.00. All items have been resolved.";
    return `The current variance is <strong>$${Math.abs(recReport.variance).toFixed(2)}</strong>. This comes from a wire transfer (Epsilon Ventures, ${fmtPos(10000)} received vs ${fmtPos(10500)} in the GL). The $500 difference needs investigation — either the invoice was wrong, or there's a short-payment that should be followed up with the client.<br><br>To resolve it, click "Resolve" on the mismatch item in the dashboard, or I can explain the investigation steps — just ask "how do I investigate a mismatch?"`;
  }
  if (ql.includes('outstanding') || ql.includes('check')) {
    if (!recReport) return "Run reconciliation first to see outstanding checks.";
    const ocs = recReport.bank_side.outstanding_checks.items;
    if (!ocs.length) return "No outstanding checks right now.";
    return `There are <strong>${ocs.length} outstanding checks</strong> totaling ${fmtPos(recReport.bank_side.outstanding_checks.total)}:<br>` +
      ocs.map(i => `• Check #${i.check_number} — ${esc(i.description)} (${fmtPos(i.amount)})`).join('<br>') +
      '<br><br>These were issued late March and haven\'t cleared the bank yet. They\'re timing differences (not errors) and will appear on the April statement. Click "Acknowledge" next to each one in the dashboard.';
  }
  if (ql.includes('deposit') && ql.includes('transit')) {
    if (!recReport) return "Run reconciliation first.";
    const dits = recReport.bank_side.deposits_in_transit.items;
    return dits.length ? `<strong>${dits.length} deposit in transit</strong>: ${dits.map(i => `${esc(i.description)} (${fmtPos(i.amount)})`).join(', ')}. Received 3/31 afternoon — will appear on the April bank statement. This is a timing difference, not an error.` : "No deposits in transit.";
  }
  if (ql.includes('fee') || ql.includes('interest') || ql.includes('nsf')) {
    if (!recReport) return "Run reconciliation first.";
    return `Book-side adjustments needed:<br>• Interest income: ${fmtPos(recReport.book_side.interest_income.total)}<br>• Bank fees: ${fmtPos(recReport.book_side.bank_fees.total)}<br>• NSF charges: ${fmtPos(recReport.book_side.nsf_charges.total)}<br><br>These items appeared on the bank statement but haven't been booked in the GL yet. Click "Book to GL" next to each item in the dashboard to create the adjusting journal entries. The accounts are pre-filled — fees go to 7400, interest to 8100, NSF to 1100.`;
  }
  if (ql.includes('how') && (ql.includes('work') || ql.includes('match'))) {
    return `I use a <strong>6-rule priority engine</strong>:<br>1. <strong>Check Number</strong> — deterministic match on check # (99% confidence)<br>2. <strong>Wire Reference</strong> — wire ref ID + amount verification (98%)<br>3. <strong>ACH Reference</strong> — ACH reference + exact amount (97%)<br>4. <strong>Exact Amount + Date</strong> — same dollar amount within a clearing window (92%, decays with date gap)<br>5. <strong>Fuzzy Description</strong> — normalized vendor name + amount + date proximity (weighted score)<br>6. <strong>Many-to-One</strong> — groups multiple entries that sum to a counterpart (e.g., batch payments)<br><br>Each rule only processes unmatched items left by previous rules. Matches ≥95% are auto-approved. 75-94% go to pending review. Below 75% are flagged as exceptions.`;
  }
  if (ql.includes('status') || ql.includes('summary')) {
    if (!matches.length) return "No reconciliation has been run yet. Click <strong>Run Full Recon</strong> or <strong>Step Through</strong> to start.";
    const auto = matches.filter(m=>m.approval_tier==='auto_approved').length;
    const pend = matches.filter(m=>m.status==='pending').length;
    const resCount = resolutions.length;
    let resp = `Current status: <strong>${matches.length} matches</strong> found across ${bankTxns.length} bank + ${glEntries.length} GL transactions.<br>• ${auto} auto-approved<br>• ${pend} pending review<br>• Match rate: ${(matchedBank.size/bankTxns.length*100).toFixed(0)}%`;
    if (resCount > 0) resp += `<br>• ${resCount} items resolved`;
    if (recReport) resp += `<br>• Variance: $${Math.abs(recReport.variance).toFixed(2)} — ${recReport.is_reconciled ? 'RECONCILED' : 'Unresolved'}`;
    return resp;
  }

  return `I can help with:<br>• <strong>Look up transactions</strong> — try "BNK-005" or "GL-012" or "MATCH-003"<br>• <strong>Explain concepts</strong> — "what is a bank reconciliation?", "what are adjusting entries?", "timing vs errors"<br>• <strong>Guide next steps</strong> — "what should I do next?"<br>• <strong>Investigate items</strong> — "tell me about the variance", "outstanding checks", "how do I fix the mismatch?"<br>• <strong>Understand the engine</strong> — "how does matching work?", "what are approval tiers?", "what is materiality?"`;
}
