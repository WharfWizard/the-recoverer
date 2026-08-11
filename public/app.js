/* The Recoverer™ — application logic
   Get SAFE · Academy of Life Planning

   All AI calls go through /api/claude.js (see callClaude() below), a serverless
   proxy that holds the ANTHROPIC_API_KEY server-side only. PDF generation
   (see the "Download Dossier (PDF)" section) never calls Claude — it only
   formats data already in `state`, keeping API usage limited to the three
   deliberate, user-triggered actions: evidence analysis, report drafting,
   and the safeguard check.
*/

const STORAGE_KEY = "recoverer-case-v3";

// PDF.js needs its worker script pointed at explicitly. Guarded in case the
// CDN script failed to load — evidence upload for other file types should
// still work even if PDF reading is unavailable.
if(typeof pdfjsLib !== "undefined"){
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}
const MAX_EXTRACTED_CHARS = 8000; // cap on text sent to Claude for analysis, and on what's stored as the item's description

// Shared evidence-type options. "Prior analysis / notes" matters specifically:
// it's how a citizen investigator flags "this is someone's write-up ABOUT the
// evidence" rather than the primary evidence itself — the AI analysis prompt
// (see analyzeEvidenceText) treats that type differently, describing what the
// write-up CLAIMS rather than stating its conclusions as fact.
const EVIDENCE_TYPES = [
  "Payment confirmation", "Email", "Message / chat export", "Marketing material",
  "Prior analysis / notes", "PDF document", "Word document", "Image / photo", "Web link", "Other"
];
const SECONDARY_SOURCE_TYPE = "Prior analysis / notes";

const STEPS = [
  { id:"case", label:"Case & evidence", desc:"Who, what, how much", hint:"The more you add, the stronger your case becomes" },
  { id:"reports", label:"Draft reports", desc:"Firm, bank, authorities", hint:"Review every draft before you send it" },
  { id:"ladder", label:"Escalation ladder", desc:"What's been done", hint:"Some routes recover funds, some are for the record" },
  { id:"safeguard", label:"Safeguard check", desc:"Vet a third party", hint:"When in doubt, check before you trust" },
];

let showAbout = false;
function toggleAbout(){ showAbout = !showAbout; renderAbout(); }
function renderAbout(){
  document.getElementById("about-root").innerHTML = showAbout ? `
    <div class="about-panel">
      The Recoverer™ helps you build an evidence dossier, draft professional reports to the firm, your bank, and the authorities, and understand realistically which routes can recover your money — before you consider handing your case to anyone else. It doesn't provide legal advice and isn't a claims-management service.
    </div>` : "";
}

function stepDone(id){
  if(id === "case") return !!(state.caseData.victimName || state.evidence.length > 0);
  if(id === "reports") return Object.keys(state.reports).length > 0;
  if(id === "safeguard") return !!state.safeguard.result;
  return false;
}

function renderStageTrack(){
  const idx = STEPS.findIndex(s => s.id === state.active);
  const current = STEPS[idx];
  document.getElementById("stage-track-root").innerHTML = `
    <div class="stage-track">
      ${STEPS.map(s => `<button class="stage-seg ${s.id===state.active?'active':(stepDone(s.id)?'done':'')}" onclick="setActive('${s.id}')" title="${esc(s.label)}"></button>`).join("")}
    </div>
    <div class="stage-meta">
      <span class="stage-current">Step ${idx+1} of ${STEPS.length} — ${esc(current.label)}</span>
      <span>${esc(current.hint)}</span>
    </div>
  `;
}

const RECIPIENTS = [
  { id:"firm", name:"The firm / individual", brief:"Formal notice to the firm or individual who took the money, setting out the transaction history and what is being requested. Rarely produces payment from a genuine scammer, but establishes your formal position and creates the paper trail everything else relies on.", expectation:"foundation", expLabel:"Establishes your position" },
  { id:"bank", name:"Bank / EMI (APP fraud, CRM Code)", brief:"Authorised Push Payment fraud claim to the bank or e-money institution that processed the payment, under the CRM Code. This is about your bank's own conduct, not the scam firm's — it applies regardless of how the firm classified you as a client.", expectation:"real", expLabel:"Realistic recovery route" },
  { id:"fos", name:"Financial Ombudsman (against your bank)", brief:"Complaint to the Financial Ombudsman Service against your bank or EMI, once their own complaints process has been exhausted or rejected your claim. The Ombudsman has jurisdiction here because it concerns a UK-regulated firm's own handling of your account — separate from any classification issue with the scam firm.", expectation:"real", expLabel:"Realistic recovery route" },
  { id:"actionfraud", name:"Action Fraud", brief:"Structured report to Action Fraud covering the fraud mechanism, entities involved, and the payment trail. This creates an official crime reference number. It is rarely investigated at the individual level, but the reference strengthens your bank and insurance claims.", expectation:"record", expLabel:"For the record, not recovery" },
  { id:"fca", name:"FCA", brief:"Report to the FCA where a genuinely regulated, retail-facing entity is involved in the chain. The FCA does not resolve individual complaints or award compensation — it cannot get your money back. Where the firm is unauthorised, or you were classified (rightly or wrongly) as professional, high net worth, or a sophisticated investor, the FCA has no power to intervene on your behalf. A report still feeds their wider intelligence picture.", expectation:"conditional", expLabel:"Record only — no redress power" },
];

const LADDER_RUNGS = [
  { recipient:"firm", title:"Report to the firm", note:"The first, direct step — put the firm or individual on formal notice. Sets your position on record even if it goes unanswered.", tag:"foundation", tagLabel:"Establishes your position" },
  { recipient:"bank", title:"Report to the bank / EMI", note:"APP fraud claim under the CRM Code. This concerns your bank's own conduct — a genuine route to recovery, independent of how the firm classified you.", tag:"real", tagLabel:"Realistic recovery route" },
  { recipient:"fos", title:"Financial Ombudsman — against your bank", note:"If the bank rejects your claim or doesn't respond, escalate to the Ombudsman. Their jurisdiction here comes from regulating your bank, not the scam firm.", tag:"real", tagLabel:"Realistic recovery route" },
  { recipient:"actionfraud", title:"Report to Action Fraud", note:"A formal crime reference for the file. Rarely leads to an individual investigation — treat it as record-keeping, not a recovery route.", tag:"record", tagLabel:"For the record" },
  { recipient:"fca", title:"Report to the FCA", note:"Only genuinely useful where a regulated, retail-facing entity is in the chain. The FCA cannot award you compensation — this is intelligence, not redress. Manage your own expectations accordingly.", tag:"conditional", tagLabel:"Conditional — no redress power" },
  { recipient:null, title:"Present the file for professional engagement", note:"Package the fully prepared, evidenced dossier for a solicitor to assess on a no-win-no-fee or conditional-fee basis, or for an assignment-based recovery firm. For an unregulated scam with no realistic ombudsman route, this is often the necessary path to recovery — reached once you've done everything you can yourself, not skipped to first.", lastResort:true, tag:"path", tagLabel:"Likely path for unregulated scams" },
];

const EXP_CLASS = { foundation:"exp-foundation", real:"exp-real", record:"exp-record", conditional:"exp-conditional", path:"exp-path" };

const SAFEGUARD_CHECKS = [
  "Asks for any upfront fee before recovery work is agreed",
  "Promises guaranteed recovery, or states a recovery timeline with false certainty",
  "Made unsolicited contact shortly after the original loss",
  "Appears to know non-public details of the original scam",
  "Claims to be acting for, or endorsed by, the FCA, Action Fraud, or a court",
  "Pressures quick action, confidentiality, or bypassing independent advice",
  "Has no verifiable regulatory status, Companies House standing, or indemnity cover"
];

let state = {
  active: "case",
  caseTitle: null,
  editingTitle: false,
  caseData: { victimName:"", firmName:"", individuals:"", bankName:"", amountLost:"", dateOfLoss:"", howApproached:"", regulatedEntity:"unsure", classification:"unsure" },
  evidence: [],
  activeRecipient: "firm",
  narrativeByRecipient: {},
  reports: {},
  safeguard: { partyName:"", notes:"", result:null, loading:false },
  draftLoading: false,
  showDownloadModal: false,
  confirmAction: null,
  uploadOpenForm: null, // 'url' | 'paste' | null
};

/* ---------------- Claude proxy ----------------
   Every AI call goes through /api/claude, our own serverless function.
   The API key lives only in Vercel's environment variables — it is never
   sent to, or visible from, the browser. The model is fixed server-side.
   This is the ONLY place in the app that calls the AI; PDF generation
   never triggers a Claude call — it only formats data already fetched. */
async function callClaude(system, messages, maxTokens){
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, max_tokens: maxTokens })
  });
  if(!response.ok){
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Request failed (${response.status})`);
  }
  return response.json();
}

/* ---------------- Persistence ----------------
   This deployment stores the case in the browser's own localStorage — it
   works today, with no external account, but it is per-browser/per-device
   only. The product spec calls for Supabase Postgres (matching Goliathon)
   so a case can be picked up on another device or handed to a professional
   without an export/import step — that's the natural next step once
   Supabase credentials exist, and the localStorage shape below (a single
   JSON snapshot) maps directly onto a single Supabase row, so swapping the
   two functions below for API calls is a contained change. */
function persistableSnapshot(){
  return {
    caseTitle: state.caseTitle,
    caseData: state.caseData,
    evidence: state.evidence.map(e => ({ ...e, thumbnail: undefined })), // don't persist raw image data
    reports: state.reports,
    narrativeByRecipient: state.narrativeByRecipient,
  };
}
function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistableSnapshot()));
  }catch(e){ /* storage unavailable or full — case stays in memory for this session */ }
}
function manualSave(){
  saveState();
  showToast("Case saved");
}
async function restoreCase(){
  await loadState();
  showToast("Restored last saved version");
}
async function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      state.caseTitle = parsed.caseTitle || null;
      Object.assign(state.caseData, parsed.caseData || {});
      state.evidence = parsed.evidence || [];
      state.reports = parsed.reports || {};
      state.narrativeByRecipient = parsed.narrativeByRecipient || {};
    }
  }catch(e){ /* no saved case yet, or storage unavailable */ }
  render();
}

function askConfirm(action){ state.confirmAction = action; renderModals(); }
function cancelConfirm(){ state.confirmAction = null; renderModals(); }
function confirmYes(){
  // Both Reset and Delete wipe localStorage and force a full page reload,
  // rather than just clearing in-memory state and re-rendering in place.
  // A reload guarantees no leftover in-flight callback (e.g. an evidence
  // analysis still resolving) or stale render path can make old data
  // reappear — Reset always means a genuinely empty case, no exceptions.
  if(state.confirmAction === "reset" || state.confirmAction === "delete"){
    try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
    showToast(state.confirmAction === "reset" ? "Case reset — reloading…" : "Case deleted — reloading…");
    setTimeout(() => window.location.reload(), 400);
    return;
  }
  state.confirmAction = null;
  render();
}

function shareCase(){
  const text = buildShareSummaryText();
  navigator.clipboard.writeText(text).then(()=>{
    showToast("Case summary copied — paste it anywhere to share or back it up");
  }).catch(()=>{
    showToast("Couldn't copy — try Download instead");
  });
}

let toastTimer;
function showToast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove("show"), 2600);
}

function setActive(id){ state.active = id; render(); }

/* ---------------- Case strength & title ---------------- */
function computeCaseStrength(){
  let score = 0;
  const c = state.caseData;
  if(c.victimName) score += 8;
  if(c.firmName) score += 8;
  if(c.amountLost) score += 8;
  if(c.dateOfLoss) score += 6;
  if(c.howApproached && c.howApproached.length > 20) score += 15;
  score += Math.min(state.evidence.length * 8, 30);
  const sent = Object.values(state.reports).filter(r => r.status === "sent").length;
  score += Math.min(sent * 5, 25);
  return Math.min(score, 100);
}
function strengthLabel(pct){
  if(pct < 20) return "Just started";
  if(pct < 45) return "Developing";
  if(pct < 75) return "Building";
  return "Strong";
}
function defaultCaseTitle(){
  const v = state.caseData.victimName || "Your case";
  const f = state.caseData.firmName ? " v " + state.caseData.firmName : "";
  return v + f + " — Investment Loss";
}
function toggleEditTitle(){ state.editingTitle = !state.editingTitle; render(); }
function updateCaseTitle(v){ state.caseTitle = v; }
function commitCaseTitle(){ state.editingTitle = false; saveState(); render(); }

function renderCaseHeader(){
  const title = state.caseTitle || defaultCaseTitle();
  const pct = computeCaseStrength();
  return `
    <div class="case-header">
      <div class="ch-left">
        <div class="ch-eyebrow">Case</div>
        ${state.editingTitle
          ? `<input class="ch-title-input" type="text" value="${esc(title)}" onblur="commitCaseTitle()" oninput="updateCaseTitle(this.value)" onkeydown="if(event.key==='Enter'){this.blur()}" autofocus>`
          : `<div class="ch-title">${esc(title)}</div>`}
      </div>
      <div class="ch-right">
        <div class="chip">${state.evidence.length} item${state.evidence.length===1?'':'s'} filed</div>
        <button class="ch-edit-btn" onclick="toggleEditTitle()">${state.editingTitle ? 'Done' : '✎ Edit'}</button>
      </div>
    </div>
    <div class="strength-card">
      <div class="strength-top">
        <div class="strength-label">Case strength</div>
        <div class="strength-value">${strengthLabel(pct)} · ${pct}%</div>
      </div>
      <div class="strength-bar-track"><div class="strength-bar-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

/* ---------------- Case & Evidence ---------------- */
function renderCasePanel(){
  const c = state.caseData;
  return `
    <div class="panel-head">
      <div class="eyebrow">Step 1</div>
      <div class="panel-title">Case &amp; evidence</div>
      <div class="panel-intro">Build the case once. Everything here feeds the reports you draft in Step 2 — you won't need to re-explain yourself to each recipient.</div>
    </div>

    ${renderCaseHeader()}

    <div class="card">
      <h3>The basics</h3>
      <div class="grid2">
        <div class="field"><label>Your name</label>
          <input type="text" value="${esc(c.victimName)}" oninput="updateCase('victimName', this.value)"></div>
        <div class="field"><label>Amount lost (£)</label>
          <input type="text" value="${esc(c.amountLost)}" oninput="updateCase('amountLost', this.value)"></div>
        <div class="field"><label>Firm name</label>
          <input type="text" value="${esc(c.firmName)}" oninput="updateCase('firmName', this.value)"></div>
        <div class="field"><label>Date of loss</label>
          <input type="date" value="${esc(c.dateOfLoss)}" oninput="updateCase('dateOfLoss', this.value)"></div>
        <div class="field"><label>Individuals named (if any)</label>
          <input type="text" value="${esc(c.individuals)}" oninput="updateCase('individuals', this.value)"></div>
        <div class="field"><label>Bank / payment provider used</label>
          <input type="text" value="${esc(c.bankName)}" oninput="updateCase('bankName', this.value)"></div>
      </div>
      <div class="field">
        <label>How you were approached, and what happened — in your own words</label>
        <textarea rows="4" oninput="updateCase('howApproached', this.value)">${esc(c.howApproached)}</textarea>
      </div>
    </div>

    <div class="card">
      <h3>Regulatory position</h3>
      <div class="panel-intro" style="margin-bottom:14px;">This decides which routes on your escalation ladder are realistic. It doesn't change what evidence you gather — only how much weight the regulatory routes should carry.</div>
      <div class="grid2">
        <div class="field"><label>Is there a regulated entity in the chain, besides the firm? (bank, EMI, authorised platform or adviser)</label>
          <select onchange="updateCase('regulatedEntity', this.value)">
            <option value="unsure" ${c.regulatedEntity==='unsure'?'selected':''}>Not sure</option>
            <option value="yes" ${c.regulatedEntity==='yes'?'selected':''}>Yes</option>
            <option value="no" ${c.regulatedEntity==='no'?'selected':''}>No — firm appears unauthorised</option>
          </select></div>
        <div class="field"><label>How did the firm classify you as a client?</label>
          <select onchange="updateCase('classification', this.value)">
            <option value="unsure" ${c.classification==='unsure'?'selected':''}>Not sure / never told</option>
            <option value="retail" ${c.classification==='retail'?'selected':''}>Retail client</option>
            <option value="professional" ${c.classification==='professional'?'selected':''}>Professional client</option>
            <option value="hnw" ${c.classification==='hnw'?'selected':''}>High net worth</option>
            <option value="sophisticated" ${c.classification==='sophisticated'?'selected':''}>Sophisticated investor</option>
          </select></div>
      </div>
      ${c.classification !== 'retail' && c.classification !== 'unsure' ? `<div class="helper-note">If this classification wasn't accurate, or wasn't properly explained to you at the time, that's worth noting in your evidence — it's often the reason FCA and FOS routes close down, correctly or not.</div>` : ''}
    </div>

    <div class="card">
      <h3>Evidence dossier</h3>

      <div class="dropzone">
        <div class="plus">+</div>
        <h4>Add your next piece of evidence</h4>
        <div class="dz-sub">${state.evidence.length === 0 ? "No items filed yet" : state.evidence.length + " item(s) filed"} — keep adding to build your case</div>
        <div class="dz-buttons">
          <button class="dz-btn primary" onclick="document.getElementById('file-input').click()">⬆ Upload File</button>
          <button class="dz-btn" onclick="document.getElementById('camera-input').click()">📷 Camera Scan</button>
          <button class="dz-btn" onclick="toggleUploadForm('url')">🔗 Add URL</button>
          <button class="dz-btn" onclick="toggleUploadForm('paste')">📋 Paste Text</button>
        </div>
        <div class="dz-hint">JPG, PNG, PDF and DOCX are read and analysed automatically. TXT/CSV/MD too. Older .DOC and .MSG files need a short description added manually.</div>
        <input type="file" id="file-input" style="display:none" onchange="handleFileUpload(event)">
        <input type="file" id="camera-input" accept="image/*" capture="environment" style="display:none" onchange="handleFileUpload(event)">

        ${state.uploadOpenForm === 'url' ? `
          <div class="inline-form">
            <div class="field"><label>Web address</label>
              <input type="url" id="url-input" placeholder="https://..."></div>
            <button class="btn-primary" onclick="addUrlEvidence()">Add to dossier</button>
          </div>` : ''}

        ${state.uploadOpenForm === 'paste' ? `
          <div class="inline-form">
            <div class="grid2">
              <div class="field"><label>Type</label>
                <select id="ev-type">
                  <option>Payment confirmation</option>
                  <option>Email</option>
                  <option>Message / chat export</option>
                  <option>Marketing material</option>
                  <option>Prior analysis / notes</option>
                  <option>Other</option>
                </select></div>
              <div class="field"><label>Date</label><input type="date" id="ev-date"></div>
            </div>
            <div class="field"><label>Paste the text</label>
              <textarea id="ev-desc" rows="4" placeholder="Paste an email, message export, or other text"></textarea></div>
            <button class="btn-primary" onclick="addPastedEvidence()">Add to dossier</button>
          </div>` : ''}
      </div>

      <div id="evidence-list">
        ${state.evidence.length === 0
          ? `<div class="empty">No evidence added yet. Payment confirmations, emails, messages, marketing material — add what you have.</div>`
          : state.evidence.map(renderEvidenceItem).join("")}
      </div>
    </div>
  `;
}

const PLACEHOLDER_DESCRIPTION = "This file type (.doc or .msg) isn't read automatically in this prototype — add a short description so it can be included in your dossier.";

function renderEvidenceItem(e){
  const needsDescription = e.needsManualDescription && !e.editing;
  const isSecondary = e.type === SECONDARY_SOURCE_TYPE;
  return `
    <div class="evidence-item">
      <div class="ev-top">
        <div class="ev-body">
          ${e.thumbnail ? `<img class="ev-thumb" src="${e.thumbnail}">` : ''}
          <div>
            <div class="evidence-meta">${esc(e.type)}${e.date ? ' · ' + esc(e.date) : ''}</div>
            <div class="evidence-name">${esc(e.filename || '')}</div>
            ${!e.editing ? `<div class="evidence-text">${esc(e.description)}</div>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:4px; flex-shrink:0;">
          ${!e.editing ? `<button class="btn-danger-text" style="color:var(--navy);" onclick="toggleEditEvidence('${e.id}')">✎ Edit</button>` : ''}
          <button class="btn-danger-text" onclick="removeEvidence('${e.id}')">Remove</button>
        </div>
      </div>

      ${isSecondary && !e.editing ? `<div class="exp-badge exp-conditional" style="margin-top:8px;">Secondary source — not primary evidence</div>` : ''}

      ${e.editing ? `
        <div class="inline-form" style="margin:10px 0 0; max-width:none;">
          <div class="field"><label>Type</label>
            <select id="edit-type-${e.id}">
              ${EVIDENCE_TYPES.map(t => `<option ${e.type === t ? 'selected' : ''}>${t}</option>`).join("")}
            </select></div>
          <div class="field"><label>Description</label>
            <textarea id="edit-desc-${e.id}" rows="3" placeholder="What does this item show? e.g. key dates, amounts, who it's from.">${esc(e.description === PLACEHOLDER_DESCRIPTION ? '' : e.description)}</textarea></div>
          <div class="helper-note" style="margin:-6px 0 10px;">Choose <strong>Prior analysis / notes</strong> if this is someone's write-up or summary <em>about</em> the evidence, rather than the underlying email, payment record, or document itself. The Recoverer will describe what it claims, not treat its conclusions as fact.</div>
          <div style="display:flex; gap:8px;">
            <button class="btn-primary" onclick="saveEvidenceDescription('${e.id}')">Save &amp; analyse</button>
            <button class="btn-ghost" onclick="toggleEditEvidence('${e.id}')">Cancel</button>
          </div>
        </div>` : ''}

      ${needsDescription ? `<div class="helper-note" style="color:var(--amber);">This file type isn't read automatically in this prototype — click Edit above and add a short description so it's included in your reports and dossier.</div>` : ''}

      ${e.analyzing ? `<div class="loading" style="margin-top:10px;"><div class="spinner"></div>Analysing what this shows…</div>` : ''}
      ${(!e.analyzing && e.whatShows) ? `
        <div class="ev-analysis">
          <div class="label-shows">${isSecondary ? 'What this document claims' : 'What this shows'}</div>
          <div class="evidence-text">${esc(e.whatShows)}</div>
          <div class="label-matters">Why it matters</div>
          <div class="evidence-text">${esc(e.whyMatters)}</div>
          <div class="disclaimer">⚠ This is The Recoverer's interpretation, not a legal or factual finding. Check it against your evidence — if anything is wrong, correct it before relying on it.${isSecondary ? ' This item is a secondary source — verify its claims against the primary evidence it refers to before relying on them.' : ''}</div>
        </div>` : ''}
    </div>
  `;
}

function toggleEditEvidence(id){
  const item = state.evidence.find(e => e.id === id);
  if(!item) return;
  item.editing = !item.editing;
  render();
}

function saveEvidenceDescription(id){
  const item = state.evidence.find(e => e.id === id);
  if(!item) return;
  const textarea = document.getElementById(`edit-desc-${id}`);
  const typeSelect = document.getElementById(`edit-type-${id}`);
  const fullText = textarea.value.trim();
  if(!fullText) return;
  if(typeSelect) item.type = typeSelect.value;
  item.needsManualDescription = false;
  item.editing = false;
  item.analyzing = true;
  // Full text is what gets analysed; the saved, displayed description is a
  // shorter excerpt so a long extracted document doesn't dominate the
  // evidence list — analysis quality isn't affected either way.
  item.description = fullText.length > 1500 ? fullText.slice(0, 1500) + " \u2026" : fullText;
  saveState(); render();
  analyzeEvidenceText(item, fullText);
}

function updateCase(field, value){ state.caseData[field] = value; saveState(); }
function toggleUploadForm(which){ state.uploadOpenForm = state.uploadOpenForm === which ? null : which; render(); }

function addPastedEvidence(){
  const type = document.getElementById("ev-type").value;
  const date = document.getElementById("ev-date").value;
  const description = document.getElementById("ev-desc").value.trim();
  if(!description) return;
  const item = { id: crypto.randomUUID(), type, date, filename:"", description, analyzing:true, whatShows:null, whyMatters:null, needsManualDescription:false, editing:false };
  state.evidence.push(item);
  state.uploadOpenForm = null;
  saveState(); render();
  analyzeEvidenceText(item, description);
}

function addUrlEvidence(){
  const url = document.getElementById("url-input").value.trim();
  if(!url) return;
  const item = { id: crypto.randomUUID(), type:"Web link", date:new Date().toISOString().slice(0,10), filename:url, description:"Reference link: " + url, analyzing:false, whatShows:null, whyMatters:null, needsManualDescription:false, editing:false };
  state.evidence.push(item);
  state.uploadOpenForm = null;
  saveState(); render();
}

function removeEvidence(id){
  state.evidence = state.evidence.filter(e => e.id !== id);
  saveState(); render();
}

function handleFileUpload(event){
  const file = event.target.files[0];
  event.target.value = "";
  if(!file) return;
  const isImage = file.type.startsWith("image/");
  const isTexty = file.type.startsWith("text/") || /\.(txt|csv|md|json)$/i.test(file.name);
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isDocx = file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(file.name);

  const item = {
    id: crypto.randomUUID(),
    type: isImage ? "Camera / image upload" : isPdf ? "PDF document" : isDocx ? "Word document" : "Uploaded file",
    date: new Date().toISOString().slice(0,10), filename: file.name, description:"",
    analyzing: isImage || isTexty || isPdf || isDocx, whatShows:null, whyMatters:null, thumbnail:null,
    needsManualDescription:false, editing:false
  };
  state.evidence.push(item);
  render();

  function fallbackToManual(message){
    item.analyzing = false;
    item.needsManualDescription = true;
    item.description = message;
    item.editing = true; // open the edit box immediately — no dead-end state
    saveState(); render();
  }

  if(isImage){
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      item.thumbnail = dataUrl;
      const base64 = dataUrl.split(",")[1];
      render();
      analyzeEvidenceImage(item, base64, file.type);
    };
    reader.readAsDataURL(file);
  } else if(isTexty){
    const reader = new FileReader();
    reader.onload = () => {
      analyzeEvidenceText(item, reader.result);
    };
    reader.readAsText(file);
  } else if(isPdf){
    if(typeof pdfjsLib === "undefined"){
      fallbackToManual("PDF reading isn't available right now — add a short description so this can be included in your dossier.");
      return;
    }
    file.arrayBuffer()
      .then(buf => pdfjsLib.getDocument({ data: buf }).promise)
      .then(async pdf => {
        let text = "";
        const pageCount = Math.min(pdf.numPages, 30); // guard against very long documents
        for(let i = 1; i <= pageCount; i++){
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map(it => it.str).join(" ") + "\n\n";
          if(text.length > MAX_EXTRACTED_CHARS) break;
        }
        text = text.trim();
        if(text.length < 20){
          fallbackToManual("This PDF doesn't appear to contain selectable text — it may be a scanned image. Add a short description so this can be included in your dossier.");
          return;
        }
        confirmExtractedText(item, text.slice(0, MAX_EXTRACTED_CHARS));
      })
      .catch(() => fallbackToManual("This PDF couldn't be read automatically — add a short description so this can be included in your dossier."));
  } else if(isDocx){
    if(typeof mammoth === "undefined"){
      fallbackToManual("Word document reading isn't available right now — add a short description so this can be included in your dossier.");
      return;
    }
    file.arrayBuffer()
      .then(buf => mammoth.extractRawText({ arrayBuffer: buf }))
      .then(result => {
        const text = (result.value || "").trim().slice(0, MAX_EXTRACTED_CHARS);
        if(text.length < 10){
          fallbackToManual("No readable text was found in this document — add a short description so this can be included in your dossier.");
          return;
        }
        confirmExtractedText(item, text);
      })
      .catch(() => fallbackToManual("This Word document couldn't be read automatically — add a short description so this can be included in your dossier."));
  } else {
    fallbackToManual(PLACEHOLDER_DESCRIPTION);
  }

  // Extraction succeeded — open the item for review instead of analysing
  // immediately. This is the checkpoint where the type gets set correctly
  // (e.g. reclassified as "Prior analysis / notes") BEFORE the one and only
  // analysis call runs, rather than analysing once with a default type and
  // hoping the victim remembers to come back and redo it afterward.
  function confirmExtractedText(item, fullText){
    item.analyzing = false;
    item.editing = true;
    item.description = fullText; // full text while editing; trimmed for display once saved
    saveState(); render();
  }
}

const PRIMARY_ANALYSIS_PROMPT = `You analyse a single piece of evidence for a fraud victim's case dossier. Given the evidence content and case context, produce two short blocks: "whatShows" — an objective, factual description of what this evidence literally shows (dates, amounts, names, statements) — and "whyMatters" — a brief interpretation of why it is relevant to the case. Each 1-3 sentences. Respond ONLY with valid JSON: {"whatShows":"...","whyMatters":"..."}`;

const SECONDARY_ANALYSIS_PROMPT = `You analyse a single piece of evidence for a fraud victim's case dossier. This item has been flagged by the victim as a PRIOR ANALYSIS OR WRITE-UP by someone else (not primary evidence like an email, payment record, or original document) — it contains someone's interpretation, summary, or argument about other material, not the underlying facts directly observed. Given its content and the case context, produce two short blocks: "whatShows" — a description of what this write-up CLAIMS or ASSERTS, using language like "this document claims..." or "the write-up asserts..." rather than stating its conclusions as established fact — and "whyMatters" — a brief note on why it's relevant, explicitly flagging that its claims are unverified and should be checked against the actual primary evidence (the original email, register entry, or document it refers to) before being relied on. Each 1-3 sentences. Respond ONLY with valid JSON: {"whatShows":"...","whyMatters":"..."}`;

async function analyzeEvidenceText(item, text){
  const context = caseContextSummary();
  const system = item.type === SECONDARY_SOURCE_TYPE ? SECONDARY_ANALYSIS_PROMPT : PRIMARY_ANALYSIS_PROMPT;
  const userMsg = `Case context:\n${context}\n\nEvidence content:\n${text.slice(0, 6000)}`;
  await runEvidenceAnalysis(item, system, [{ role:"user", content:userMsg }]);
}

async function analyzeEvidenceImage(item, base64, mediaType){
  const context = caseContextSummary();
  const system = item.type === SECONDARY_SOURCE_TYPE ? SECONDARY_ANALYSIS_PROMPT : `You analyse a single piece of image evidence for a fraud victim's case dossier. Look at the image and produce two short blocks: "whatShows" — an objective, factual description of what the image literally shows (visible text, dates, amounts, names) — and "whyMatters" — a brief interpretation of why it is relevant to the case. Each 1-3 sentences. Respond ONLY with valid JSON: {"whatShows":"...","whyMatters":"..."}`;
  const content = [
    { type:"image", source:{ type:"base64", media_type: mediaType || "image/jpeg", data: base64 } },
    { type:"text", text: `Case context:\n${context}\n\nAnalyse this image as evidence.` }
  ];
  await runEvidenceAnalysis(item, system, [{ role:"user", content }]);
}

async function runEvidenceAnalysis(item, system, messages){
  try{
    const data = await callClaude(system, messages, 400);
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    item.whatShows = parsed.whatShows || "Not available.";
    item.whyMatters = parsed.whyMatters || "Not available.";
  }catch(err){
    item.whatShows = "Automated analysis unavailable for this item.";
    item.whyMatters = "Add a short description manually so this can be included in your dossier.";
  }
  item.analyzing = false;
  saveState();
  render();
}

function caseContextSummary(){
  const c = state.caseData;
  return `Victim: ${c.victimName || "[not given]"}; Firm: ${c.firmName || "[not given]"}; Amount lost: ${c.amountLost || "[not given]"}; Date of loss: ${c.dateOfLoss || "[not given]"}; How approached: ${c.howApproached || "[not given]"}`;
}

/* ---------------- Draft Reports ---------------- */
function renderReportsPanel(){
  const recipient = RECIPIENTS.find(r => r.id === state.activeRecipient);
  const report = state.reports[state.activeRecipient];
  const narrative = state.narrativeByRecipient[state.activeRecipient] || "";
  return `
    <div class="panel-head">
      <div class="eyebrow">Step 2</div>
      <div class="panel-title">Draft reports</div>
      <div class="panel-intro">Choose who you're reporting to. The Recoverer turns your case and evidence into a calm, factual, professional letter — you review and edit every word before it's yours to send.</div>
    </div>
    <div class="recipient-tabs">
      ${RECIPIENTS.map(r => `<div class="recipient-tab ${r.id===state.activeRecipient?'active':''}" onclick="setRecipient('${r.id}')">${r.name}</div>`).join("")}
    </div>
    <div class="card">
      <div class="exp-badge ${EXP_CLASS[recipient.expectation]}">${recipient.expLabel}</div>
      <h3>${recipient.name}</h3>
      <div class="panel-intro" style="margin-bottom:14px;">${recipient.brief}</div>
      <div class="split">
        <div class="split-pane left">
          <div class="pane-label">In your own words</div>
          <textarea rows="9" placeholder="Add anything specific for this report — dates, amounts, what you want them to do. It doesn't need to be tidy." oninput="updateNarrative(this.value)">${esc(narrative)}</textarea>
          <div class="helper-note">Your case basics and evidence dossier from Step 1 are included automatically.</div>
          <div style="margin-top:14px;">
            <button class="btn-primary" onclick="draftReport()" ${state.draftLoading ? 'disabled' : ''}>
              ${state.draftLoading ? 'Drafting…' : (report ? 'Redraft' : 'Draft report')}
            </button>
          </div>
        </div>
        <div class="split-pane right">
          <div class="pane-label">Formal report — edit before sending</div>
          ${state.draftLoading
            ? `<div class="letter"><div class="loading"><div class="spinner"></div>Writing a professional, factual draft…</div></div>`
            : report
              ? `<div class="letter" contenteditable="true" oninput="editReport(this.innerText)">${esc(report.text)}</div>
                 <div class="row-actions">
                   <span class="status-pill ${report.status==='sent'?'status-sent':'status-draft'}">${report.status==='sent' ? 'Sent ' + report.sentDate : 'Draft'}</span>
                   <button class="btn-ghost" onclick="copyReport()">Copy text</button>
                   ${report.status !== 'sent' ? `<button class="btn-gold" onclick="markSent()">Mark as sent</button>` : ''}
                 </div>`
              : `<div class="letter letter-placeholder">Your drafted report will appear here once you click "Draft report."</div>`}
        </div>
      </div>
    </div>
  `;
}
function setRecipient(id){ state.activeRecipient = id; render(); }
function updateNarrative(v){ state.narrativeByRecipient[state.activeRecipient] = v; saveState(); }
function editReport(text){ if(!state.reports[state.activeRecipient]) return; state.reports[state.activeRecipient].text = text; saveState(); }
function copyReport(){ const r = state.reports[state.activeRecipient]; if(r) navigator.clipboard.writeText(r.text).catch(()=>{}); }
function markSent(){
  const r = state.reports[state.activeRecipient]; if(!r) return;
  r.status = "sent"; r.sentDate = new Date().toISOString().slice(0,10);
  saveState(); render();
}

async function draftReport(){
  const recipient = RECIPIENTS.find(r => r.id === state.activeRecipient);
  const c = state.caseData;
  const evidenceList = state.evidence.map(e => `- [${e.type}${e.date ? ', ' + e.date : ''}] ${e.whatShows || e.description}`).join("\n") || "No evidence items logged yet.";
  const narrative = state.narrativeByRecipient[state.activeRecipient] || "";

  let recipientGuidance = "";
  if(recipient.id === "fca"){
    recipientGuidance = "This is an intelligence report, not a redress claim — the FCA cannot award compensation. Frame it as providing information for their records and wider market monitoring, not as a request to get the victim's money back. Do not imply the FCA will resolve the case.";
  } else if(recipient.id === "fos"){
    recipientGuidance = "This complaint is against the victim's own bank or EMI, not the scam firm, and concerns the bank's handling of an authorised push payment. Reference that the firm's internal complaints process has been engaged first where applicable, and that this is an escalation under the Financial Ombudsman Service's jurisdiction over the bank.";
  } else if(recipient.id === "actionfraud"){
    recipientGuidance = "This is a formal crime report for the record, structured to the fields Action Fraud typically requests (what happened, who was involved, financial loss, evidence held). Do not imply an investigation or recovery will necessarily follow — the goal is an official crime reference number.";
  } else if(recipient.id === "bank"){
    recipientGuidance = "Frame this explicitly as an Authorised Push Payment fraud claim under the CRM Code, asking the bank to investigate and reimburse under the Code's provisions, and to confirm their complaints-process timeline.";
  }

  const systemPrompt = `You are drafting a formal written report on behalf of a fraud victim, for the victim to review, edit, and send in their own name. Write in first person as the victim. Tone: calm, factual, professional, precise — the way an experienced advocate would write, with no emotional or accusatory language, even though the underlying facts are serious. Use only the facts provided; do not invent names, dates, amounts, or claims. Do not overstate what this recipient can do for the victim — match the tone to what is realistically achievable. Structure as a proper formal letter/report appropriate to the named recipient, including a clear statement of facts, the specific request or ask, and next steps if no response is received. Return only the letter text, no preamble or commentary.`;
  const userPrompt = `Recipient: ${recipient.name}\nPurpose of this report: ${recipient.brief}\n${recipientGuidance ? "Specific guidance for this recipient: " + recipientGuidance + "\n" : ""}\nCase facts:\n- Victim name: ${c.victimName || "[not provided]"}\n- Firm: ${c.firmName || "[not provided]"}\n- Individuals named: ${c.individuals || "[not provided]"}\n- Bank / payment provider: ${c.bankName || "[not provided]"}\n- Amount lost: ${c.amountLost || "[not provided]"}\n- Date of loss: ${c.dateOfLoss || "[not provided]"}\n- How approached / what happened: ${c.howApproached || "[not provided]"}\n- Regulated entity in chain besides the firm: ${c.regulatedEntity || "not sure"}\n- Client classification given by the firm: ${c.classification || "not sure"}\n\nEvidence dossier:\n${evidenceList}\n\nAdditional notes for this specific report:\n${narrative || "None."}\n\nDraft the formal report now.`;

  state.draftLoading = true; render();
  try{
    const data = await callClaude(systemPrompt, [{ role:"user", content:userPrompt }], 1200);
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    state.reports[state.activeRecipient] = { text: text || "(No draft returned — try again.)", status:"draft" };
  }catch(err){
    state.reports[state.activeRecipient] = { text:"Something went wrong drafting this report. Please try again.", status:"draft" };
  }
  state.draftLoading = false;
  saveState(); render();
}

/* ---------------- Escalation Ladder ---------------- */
function renderLadderPanel(){
  const c = state.caseData;
  const noRegulatedEntity = c.regulatedEntity === "no";
  const nonRetail = c.classification && c.classification !== "unsure" && c.classification !== "retail";
  return `
    <div class="panel-head">
      <div class="eyebrow">Step 3</div>
      <div class="panel-title">Escalation ladder</div>
      <div class="panel-intro">Self-directed steps first, in the order most likely to actually help. Routes are labelled honestly — some genuinely recover funds, some are record-keeping, and one only applies in specific circumstances.</div>
    </div>
    <div class="ladder-intro">
      <strong>Managing expectations on purpose:</strong> for many investment scams the FCA and Financial Ombudsman cannot get your money back from the firm itself — the FCA doesn't award compensation, and the Ombudsman only has jurisdiction over regulated firms and eligible complainants.
      ${noRegulatedEntity ? " Based on what you've told us, the firm appears unauthorised, so those routes are unlikely to apply to it directly." : ""}
      ${nonRetail ? " You've also indicated the firm classified you as a non-retail client, which — rightly or wrongly — is often exactly why those routes get closed off." : ""}
      The one regulator-backed route that reliably applies regardless is a claim against your own bank for an authorised push payment fraud. Where the regulatory routes don't apply, the realistic path is a well-evidenced case presented to a solicitor or recovery firm.
    </div>
    <div class="ladder">
      ${LADDER_RUNGS.map(rung => {
        const report = rung.recipient ? state.reports[rung.recipient] : null;
        const done = report && report.status === "sent";
        return `
          <div class="rung">
            <div class="rung-dot ${done ? 'done' : ''} ${rung.lastResort ? 'last-resort' : ''}">${done ? '✓' : ''}</div>
            <div class="rung-card ${rung.lastResort ? 'last-resort' : ''}">
              <div class="exp-badge ${EXP_CLASS[rung.tag]}">${rung.tagLabel}</div>
              <div class="rung-title">${rung.title}</div>
              <div class="rung-note">${rung.note}</div>
              <div class="rung-status">
                ${rung.recipient
                  ? (done ? `<span class="status-pill status-sent">Sent ${report.sentDate}</span>`
                          : `<span class="status-pill status-draft">Not sent yet</span> — <a href="#" onclick="setRecipient('${rung.recipient}'); setActive('reports'); return false;">go to draft</a>`)
                  : `<span class="status-pill status-draft">Not started</span>`}
              </div>
            </div>
          </div>`;
      }).join("")}
    </div>
  `;
}

/* ---------------- Safeguard Check ---------------- */
function renderSafeguardPanel(){
  const sg = state.safeguard;
  return `
    <div class="panel-head">
      <div class="eyebrow">Step 4 · Safeguard</div>
      <div class="panel-title">Second-scam check</div>
      <div class="panel-intro">Fraud victims are routinely re-targeted by fake recovery services. If anyone has approached you, or you're considering approaching anyone, check them here before anything moves forward.</div>
    </div>
    <div class="card">
      <div class="grid2">
        <div class="field"><label>Their name / firm</label>
          <input type="text" value="${esc(sg.partyName)}" oninput="updateSafeguard('partyName', this.value)"></div>
      </div>
      <div class="field">
        <label>What have they said or done? How did contact start?</label>
        <textarea rows="4" oninput="updateSafeguard('notes', this.value)">${esc(sg.notes)}</textarea>
      </div>
      <button class="btn-primary" onclick="runSafeguardCheck()" ${sg.loading ? 'disabled':''}>${sg.loading ? 'Checking…' : 'Run check'}</button>
    </div>
    ${sg.loading ? `<div class="card"><div class="loading"><div class="spinner"></div>Checking against known recovery-scam patterns…</div></div>` : ''}
    ${sg.result ? `
      <div class="card">
        <div class="verdict-banner ${sg.result.verdict === 'caution' ? 'verdict-caution' : 'verdict-clear'}">${esc(sg.result.summary)}</div>
        ${sg.result.flags.map(f => `
          <div class="flag-row">
            <div class="flag-icon ${f.hit ? 'hit' : 'clear'}">${f.hit ? '!' : '✓'}</div>
            <div class="flag-text"><strong>${esc(f.checklistItem)}</strong>${f.hit ? ' — ' + esc(f.note) : ''}</div>
          </div>`).join("")}
        <div class="helper-note">This is The Recoverer's assessment based on what you've described, not a legal or regulatory finding. Trust your own judgement alongside it.</div>
      </div>` : ''}
  `;
}
function updateSafeguard(field, value){ state.safeguard[field] = value; }

async function runSafeguardCheck(){
  if(!state.safeguard.notes.trim()) return;
  state.safeguard.loading = true; render();
  const checklist = SAFEGUARD_CHECKS.map((c,i) => `${i+1}. ${c}`).join("\n");
  const systemPrompt = `You assess whether a third party approaching a fraud victim shows signs of being a "recovery room" scam — a second fraud targeting people who have already lost money. You will be given a checklist and a description of the party and contact. For each checklist item, decide if the description shows evidence of it ("hit": true/false) and give a one-sentence note only if hit is true. Then give an overall one-to-two sentence summary and a verdict of either "caution" (one or more real hits) or "clear" (no clear hits, but absence of evidence is not proof of legitimacy — say so). Respond ONLY with valid JSON, no markdown fences, no preamble, in this exact shape:
{"verdict":"caution|clear","summary":"...","flags":[{"checklistItem":"...","hit":true|false,"note":"..."}]}
The flags array must contain exactly these ${SAFEGUARD_CHECKS.length} checklist items in order, verbatim as given.`;
  const userPrompt = `Checklist:\n${checklist}\n\nParty name: ${state.safeguard.partyName || "[not given]"}\n\nDescription of contact:\n${state.safeguard.notes}`;
  try{
    const data = await callClaude(systemPrompt, [{ role:"user", content:userPrompt }], 1000);
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    state.safeguard.result = JSON.parse(clean);
  }catch(err){
    state.safeguard.result = {
      verdict:"caution",
      summary:"Couldn't complete an automated check. Treat any request for upfront payment, guaranteed results, or pressure to act fast as a serious warning sign regardless.",
      flags: SAFEGUARD_CHECKS.map(c => ({ checklistItem:c, hit:false, note:"" }))
    };
  }
  state.safeguard.loading = false; render();
}

/* ---------------- Download Dossier (PDF) ----------------
   All PDF generation is local formatting of data already sitting in `state` —
   it never calls Claude. jsPDF's built-in Helvetica font is used throughout
   (no embedded custom fonts), and no images are embedded, to keep files small.
   Text is measured and wrapped with splitTextToSize before it is placed, and
   every write checks remaining page space first — content flows onto a new
   page rather than being cut off, and the footer's page count is computed
   from the real, finished document (via jsPDF's putTotalPages), so it can't
   drift the way a hardcoded total would. */
function openDownloadModal(){ state.showDownloadModal = true; renderModals(); }
function closeDownloadModal(){ state.showDownloadModal = false; renderModals(); }

const PDF = {
  PAGE_W: 210, PAGE_H: 297,
  MARGIN_L: 18, MARGIN_R: 18, TOP: 30, BOTTOM: 20,
  NAVY: [26,46,82], GOLD: [168,122,47], MUTED: [107,114,128],
  INK: [31,36,48], LINE: [228,223,212], SAFE: [47,111,78], AMBER: [179,105,29],
  TONE: {
    real:      { bg:[234,244,238], fg:[47,111,78] },
    foundation:{ bg:[234,238,246], fg:[26,46,82] },
    record:    { bg:[239,234,224], fg:[107,114,128] },
    conditional:{bg:[251,240,225], fg:[179,105,29] },
    path:      { bg:[231,217,190], fg:[90,67,16] },
  }
};
PDF.CONTENT_W = PDF.PAGE_W - PDF.MARGIN_L - PDF.MARGIN_R;
PDF.BOTTOM_Y = PDF.PAGE_H - PDF.BOTTOM;

class PdfBuilder{
  constructor(doc, sectionLabel, caseTitle){
    this.doc = doc; this.y = PDF.TOP;
    this.sectionLabel = sectionLabel; this.caseTitle = caseTitle;
  }
  ensureSpace(h){
    if(this.y + h > PDF.BOTTOM_Y){ this.doc.addPage(); this.y = PDF.TOP; }
  }
  coverTitle(title, subtitle){
    this.doc.setFont("helvetica","bold"); this.doc.setFontSize(18); this.doc.setTextColor(...PDF.NAVY);
    this.doc.text(title, PDF.MARGIN_L, this.y); this.y += 8;
    if(subtitle){
      this.doc.setFont("helvetica","normal"); this.doc.setFontSize(10.5); this.doc.setTextColor(...PDF.MUTED);
      this.doc.text(subtitle, PDF.MARGIN_L, this.y); this.y += 9;
    }
    this.divider();
  }
  heading(text){
    this.ensureSpace(12);
    this.doc.setFont("helvetica","bold"); this.doc.setFontSize(13); this.doc.setTextColor(...PDF.NAVY);
    this.doc.text(text, PDF.MARGIN_L, this.y); this.y += 8;
  }
  subheading(text){
    this.ensureSpace(8);
    this.doc.setFont("helvetica","bold"); this.doc.setFontSize(10.5); this.doc.setTextColor(...PDF.NAVY);
    const lines = this.doc.splitTextToSize(text, PDF.CONTENT_W);
    lines.forEach(line => { this.ensureSpace(5.2); this.doc.text(line, PDF.MARGIN_L, this.y); this.y += 5.2; });
    this.y += 0.5;
  }
  paragraph(text, opts={}){
    if(!text) return;
    const size = opts.size || 9.7;
    const color = opts.color || PDF.INK;
    const lineHeight = size * 0.44;
    this.doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    this.doc.setFontSize(size);
    this.doc.setTextColor(...color);
    const lines = this.doc.splitTextToSize(text, PDF.CONTENT_W - (opts.indent || 0));
    lines.forEach(line => {
      this.ensureSpace(lineHeight);
      this.doc.text(line, PDF.MARGIN_L + (opts.indent || 0), this.y);
      this.y += lineHeight;
    });
    this.y += opts.spacingAfter != null ? opts.spacingAfter : 2.4;
  }
  labelValueGrid(pairs){
    const labelW = 46, colGap = 6, valueW = PDF.CONTENT_W - labelW - colGap;
    this.doc.setFontSize(9.3);
    pairs.forEach(([label, value]) => {
      const valLines = this.doc.splitTextToSize(String(value || "-"), valueW);
      const rowH = Math.max(valLines.length * 4.5, 5);
      this.ensureSpace(rowH);
      this.doc.setFont("helvetica","bold"); this.doc.setTextColor(...PDF.MUTED);
      this.doc.text(label, PDF.MARGIN_L, this.y);
      this.doc.setFont("helvetica","normal"); this.doc.setTextColor(...PDF.INK);
      valLines.forEach((l,i) => this.doc.text(l, PDF.MARGIN_L + labelW + colGap, this.y + i*4.5));
      this.y += rowH + 1.6;
    });
  }
  badge(text, tone){
    const palette = PDF.TONE[tone] || PDF.TONE.foundation;
    this.doc.setFont("helvetica","bold"); this.doc.setFontSize(7.4);
    const label = text.toUpperCase();
    const tw = this.doc.getTextWidth(label);        // measure first, size the box to fit — never the reverse
    const padX = 2.6, h = 4.6, w = tw + padX*2;
    this.ensureSpace(h + 2.5);
    this.doc.setFillColor(...palette.bg);
    this.doc.roundedRect(PDF.MARGIN_L, this.y - 3.3, w, h, 1, 1, "F");
    this.doc.setTextColor(...palette.fg);
    this.doc.text(label, PDF.MARGIN_L + padX, this.y);
    this.y += h + 2.6;
  }
  divider(){
    this.ensureSpace(5);
    this.doc.setDrawColor(...PDF.LINE);
    this.doc.line(PDF.MARGIN_L, this.y, PDF.PAGE_W - PDF.MARGIN_R, this.y);
    this.y += 6;
  }
  spacer(h){ this.y += h; }
  /* Reserves a minimum block of space (heading + badge + first line of body)
     so a badge or heading can never be stranded alone at the top of a new
     page, separated from the content it belongs to — the whole cluster
     moves together. */
  reserve(h){ this.ensureSpace(h); }
  finalize(){
    const doc = this.doc;
    const totalPagesExp = "{total_pages_count_string}";
    const pageCount = doc.internal.getNumberOfPages();
    for(let i = 1; i <= pageCount; i++){
      doc.setPage(i);
      doc.setDrawColor(...PDF.LINE);
      doc.line(PDF.MARGIN_L, 14, PDF.PAGE_W - PDF.MARGIN_R, 14);
      doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(...PDF.MUTED);
      doc.text(this.caseTitle || "The Recoverer\u2122", PDF.MARGIN_L, 10);
      doc.text(this.sectionLabel, PDF.PAGE_W - PDF.MARGIN_R, 10, { align:"right" });
      doc.line(PDF.MARGIN_L, PDF.PAGE_H - 16, PDF.PAGE_W - PDF.MARGIN_R, PDF.PAGE_H - 16);
      doc.text("The Recoverer\u2122 \u00b7 Get SAFE \u00b7 Not legal advice", PDF.MARGIN_L, PDF.PAGE_H - 10);
      doc.text("Page " + i + " of " + totalPagesExp, PDF.PAGE_W - PDF.MARGIN_R, PDF.PAGE_H - 10, { align:"right" });
    }
    if(typeof doc.putTotalPages === "function") doc.putTotalPages(totalPagesExp);
  }
}

/* ---- Structured data (shared by every export) ---- */
function buildCaseOverviewData(){
  const c = state.caseData;
  return {
    title: state.caseTitle || defaultCaseTitle(),
    rows: [
      ["Victim", c.victimName || "-"],
      ["Firm", c.firmName || "-"],
      ["Individuals named", c.individuals || "-"],
      ["Bank / payment provider", c.bankName || "-"],
      ["Amount lost", c.amountLost || "-"],
      ["Date of loss", c.dateOfLoss || "-"],
      ["Regulated entity in chain", c.regulatedEntity || "unsure"],
      ["Client classification", c.classification || "unsure"],
    ],
    narrative: c.howApproached || "-",
    strengthLabel: strengthLabel(computeCaseStrength()),
    strengthPct: computeCaseStrength(),
  };
}
function buildEvidenceLibraryData(){
  return state.evidence.map((e,i) => ({
    index: i+1,
    meta: `${e.type}${e.date ? ' \u00b7 ' + e.date : ''}${e.filename ? ' \u00b7 ' + e.filename : ''}`,
    description: e.description, whatShows: e.whatShows, whyMatters: e.whyMatters,
    isSecondary: e.type === SECONDARY_SOURCE_TYPE
  }));
}
function buildCorrespondenceLogData(){
  return RECIPIENTS.map(r => {
    const rep = state.reports[r.id];
    return {
      name: r.name, expLabel: r.expLabel, tone: r.expectation,
      status: rep ? (rep.status === "sent" ? `Sent ${rep.sentDate}` : "Drafted, not yet sent") : "Not drafted yet",
      text: rep ? rep.text : null
    };
  });
}
function buildEscalationLadderData(){
  return LADDER_RUNGS.map(r => {
    const rep = r.recipient ? state.reports[r.recipient] : null;
    return {
      title: r.title, note: r.note, tagLabel: r.tagLabel, tone: r.tag,
      status: r.recipient ? (rep && rep.status === "sent" ? `Sent ${rep.sentDate}` : "Not sent yet") : "Not started"
    };
  });
}
function buildSafeguardData(){
  const sg = state.safeguard;
  if(!sg.result) return null;
  return { partyName: sg.partyName || "-", verdict: sg.result.verdict, summary: sg.result.summary, flags: sg.result.flags };
}
function buildNextStepsData(){
  const steps = [];
  if(state.evidence.length === 0) steps.push("Add evidence to your dossier before drafting reports.");
  RECIPIENTS.forEach(r => { if(!state.reports[r.id]) steps.push(`Draft a report to ${r.name}.`); });
  if(steps.length === 0) steps.push("All core reports drafted. Review the escalation ladder for what's outstanding.");
  return steps;
}

/* ---- Section writers: each draws one section into a PdfBuilder ---- */
function writeOverviewSection(pb, cover){
  const d = buildCaseOverviewData();
  if(cover) pb.coverTitle("Case Overview", d.title); else pb.heading("Case Overview");
  pb.labelValueGrid(d.rows);
  pb.spacer(1);
  pb.subheading("What happened");
  pb.paragraph(d.narrative);
  pb.spacer(1);
  pb.paragraph(`Case strength: ${d.strengthLabel} (${d.strengthPct}%)`, { bold:true, size:9.5, color:PDF.GOLD });
}
function writeEvidenceSection(pb, cover){
  const items = buildEvidenceLibraryData();
  if(cover) pb.coverTitle("Evidence Library", `${items.length} item${items.length===1?'':'s'} filed`); else pb.heading("Evidence Library");
  if(items.length === 0){ pb.paragraph("No evidence filed yet.", { color:PDF.MUTED }); return; }
  items.forEach(it => {
    pb.reserve(it.isSecondary ? 24 : 16); // badge + heading move together when flagged as a secondary source
    if(it.isSecondary) pb.badge("Secondary source \u2014 not primary evidence", "conditional");
    pb.subheading(`#${String(it.index).padStart(3,'0')}  ${it.meta}`);
    if(it.description) pb.paragraph(it.description, { size:9.4 });
    if(it.whatShows) pb.paragraph((it.isSecondary ? "What this claims: " : "What this shows: ") + it.whatShows, { size:9.4 });
    if(it.whyMatters) pb.paragraph("Why it matters: " + it.whyMatters, { size:9.4, color:PDF.AMBER });
    pb.spacer(2.5);
  });
}
function writeCorrespondenceSection(pb, cover){
  const rows = buildCorrespondenceLogData();
  if(cover) pb.coverTitle("Correspondence Log", "Reports drafted and sent"); else pb.heading("Correspondence Log");
  rows.forEach(r => {
    pb.reserve(24); // badge + heading move together, never split across a page
    pb.badge(r.expLabel, r.tone);
    pb.subheading(r.name + "  \u2014  " + r.status);
    if(r.text) pb.paragraph(r.text, { size:9.2 }); else pb.paragraph("Not drafted yet.", { size:9.2, color:PDF.MUTED });
    pb.spacer(3);
  });
}
function writeLadderSection(pb, cover){
  const rows = buildEscalationLadderData();
  if(cover) pb.coverTitle("Escalation Ladder", "Realistic routes, in order"); else pb.heading("Escalation Ladder");
  rows.forEach(r => {
    pb.reserve(24); // badge + heading move together, never split across a page
    pb.badge(r.tagLabel, r.tone);
    pb.subheading(r.title + "  \u2014  " + r.status);
    pb.paragraph(r.note, { size:9.2 });
    pb.spacer(2);
  });
}
function writeSafeguardSection(pb, cover){
  const sg = buildSafeguardData();
  if(cover) pb.coverTitle("Safeguard Check", "Second-scam check result"); else pb.heading("Safeguard Check");
  if(!sg){ pb.paragraph("No check run yet.", { color:PDF.MUTED }); return; }
  pb.reserve(20); // "party checked" line + verdict badge move together
  pb.paragraph(`Party checked: ${sg.partyName}`, { bold:true, size:9.7 });
  pb.badge(sg.verdict === "caution" ? "Caution" : "Clear", sg.verdict === "caution" ? "conditional" : "real");
  pb.paragraph(sg.summary, { size:9.5 });
  pb.spacer(1);
  sg.flags.forEach(f => {
    pb.paragraph((f.hit ? "[ ! ] " : "[ ok ] ") + f.checklistItem + (f.hit && f.note ? " \u2014 " + f.note : ""), { size:9.2, color: f.hit ? PDF.AMBER : PDF.SAFE });
  });
}
function writeNextStepsSection(pb, cover){
  const steps = buildNextStepsData();
  if(cover) pb.coverTitle("Next Steps", "What's still outstanding"); else pb.heading("Next Steps");
  steps.forEach(s => pb.paragraph("\u2022  " + s, { size:9.6 }));
}

const SECTIONS = {
  overview:      { label:"Case Overview",       file:"case-overview.pdf",       write: writeOverviewSection },
  evidence:      { label:"Evidence Library",     file:"evidence-library.pdf",    write: writeEvidenceSection },
  correspondence:{ label:"Correspondence Log",   file:"correspondence-log.pdf",  write: writeCorrespondenceSection },
  ladder:        { label:"Escalation Ladder",    file:"escalation-ladder.pdf",   write: writeLadderSection },
  safeguard:     { label:"Safeguard Check",      file:"safeguard-check.pdf",     write: writeSafeguardSection },
  nextsteps:     { label:"Next Steps",           file:"next-steps.pdf",          write: writeNextStepsSection },
};

function generateSectionPdf(key){
  try{
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"mm", format:"a4" });
    const title = state.caseTitle || defaultCaseTitle();
    const section = SECTIONS[key];
    const pb = new PdfBuilder(doc, section.label, title);
    section.write(pb, true);
    pb.finalize();
    doc.save(section.file);
  }catch(err){
    showToast("Couldn't generate that PDF — please try again");
  }
}
function generateCompleteDossierPdf(){
  try{
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:"mm", format:"a4" });
    const title = state.caseTitle || defaultCaseTitle();
    const pb = new PdfBuilder(doc, "Complete Dossier", title);
    pb.coverTitle("Complete Dossier", title);
    const order = ["overview","evidence","correspondence","ladder","safeguard","nextsteps"];
    order.forEach((key, i) => {
      if(i > 0){ doc.addPage(); pb.y = PDF.TOP; }
      SECTIONS[key].write(pb, false);
    });
    pb.finalize();
    doc.save("complete-dossier.pdf");
  }catch(err){
    showToast("Couldn't generate the dossier — please try again");
  }
}
function buildShareSummaryText(){
  const d = buildCaseOverviewData();
  const items = buildEvidenceLibraryData();
  const corr = buildCorrespondenceLogData();
  const lines = [`THE RECOVERER \u2014 CASE SUMMARY`, d.title, ""];
  d.rows.forEach(([l,v]) => lines.push(`${l}: ${v}`));
  lines.push("", `Evidence items filed: ${items.length}`, `Reports drafted: ${corr.filter(c=>c.text).length} of ${corr.length}`, "", "Use the Download button in the app for the full PDF dossier.");
  return lines.join("\n");
}

const DOWNLOAD_ITEMS = [
  { icon:"📁", title:"Complete Dossier", sub:"All sections, one PDF", generate: () => generateCompleteDossierPdf() },
  { icon:"📄", title:"Case Overview", sub:"Summary and context", generate: () => generateSectionPdf("overview") },
  { icon:"🗂", title:"Evidence Library", sub:"All items with notes", generate: () => generateSectionPdf("evidence") },
  { icon:"✉️", title:"Correspondence Log", sub:"Reports drafted and sent", generate: () => generateSectionPdf("correspondence") },
  { icon:"🪜", title:"Escalation Ladder", sub:"Status of each step", generate: () => generateSectionPdf("ladder") },
  { icon:"🛡", title:"Safeguard Check", sub:"Second-scam check result", generate: () => generateSectionPdf("safeguard") },
  { icon:"📌", title:"Next Steps", sub:"What's still outstanding", generate: () => generateSectionPdf("nextsteps") },
];

function renderModals(){
  const root = document.getElementById("modal-root");
  let html = "";
  if(state.showDownloadModal){
    html += `
      <div class="modal-overlay" onclick="if(event.target===this) closeDownloadModal()">
        <div class="modal">
          <div class="modal-head"><h2>Download Dossier</h2><button class="modal-close" onclick="closeDownloadModal()">✕</button></div>
          ${DOWNLOAD_ITEMS.map((it, idx) => `
            <div class="modal-item" onclick="DOWNLOAD_ITEMS[${idx}].generate()">
              <div><div class="mi-title">${it.icon} ${it.title}</div><div class="mi-sub">${it.sub}</div></div>
              <div class="mi-icon">↓</div>
            </div>`).join("")}
        </div>
      </div>`;
  }
  if(state.confirmAction){
    const isDelete = state.confirmAction === "delete";
    html += `
      <div class="confirm-overlay">
        <div class="confirm-box">
          <h3>${isDelete ? "Delete this case?" : "Reset this case?"}</h3>
          <p>${isDelete ? "This removes all saved case data, evidence, and drafted reports. This can't be undone." : "This clears the case basics, evidence, and drafted reports so you can start over. This can't be undone."}</p>
          <div class="confirm-actions">
            <button class="btn-ghost" onclick="cancelConfirm()">Cancel</button>
            <button class="tb-btn danger" style="color:#A6432B; border-color:#A6432B;" onclick="confirmYes()">${isDelete ? "Delete" : "Reset"}</button>
          </div>
        </div>
      </div>`;
  }
  root.innerHTML = html;
}

/* ---------------- Render ---------------- */
function render(){
  renderAbout();
  renderStageTrack();
  const main = document.getElementById("main");
  if(state.active === "case") main.innerHTML = renderCasePanel();
  else if(state.active === "reports") main.innerHTML = renderReportsPanel();
  else if(state.active === "ladder") main.innerHTML = renderLadderPanel();
  else if(state.active === "safeguard") main.innerHTML = renderSafeguardPanel();
  renderModals();
}

function esc(str){ return (str || "").toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

loadState();
