import { comments } from "./data.js";
import {
  API_LABELS,
  REWRITE_PRESETS,
  checkAvailability,
  detectLanguage,
  draftReply,
  isUsable,
  onLog,
  onProgress,
  prepareAll,
  proofread,
  rewrite,
  translate,
  triage
} from "./ai.js";

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };
const languageNames = new Intl.DisplayNames([ "en" ], { type: "language" });
const relativeTime = new Intl.RelativeTimeFormat( "en", { numeric: "auto" });

const state = {
  comments: comments.map( ( c ) => ({
    ...c,
    language: null,
    confidence: 0,
    candidates: [],
    translation: null,
    showTranslation: false,
    triage: null,
    busy: null,
    error: null,
    draft: "",
    replies: []
  }) ),
  selectedId: comments[ 0 ].id,
  sort: "newest",
  status: {},
  progress: {},
  log: [],
  isAnalyzing: false,
  replyBusy: null,
  replyError: null,
  proof: null,
  rewritePreset: "formal"
};

const $ = ( id ) => document.getElementById( id );

function esc( value ) {
  return String( value ?? "" )
    .replaceAll( "&", "&amp;" )
    .replaceAll( "<", "&lt;" )
    .replaceAll( ">", "&gt;" )
    .replaceAll( "\"", "&quot;" );
}

function langName( code ) {
  try {
    return languageNames.of( code );
  } catch {
    return code;
  }
}

function percent( value ) {
  return `${ Math.round( value * 100 ) }%`;
}

function timeAgo( minutes ) {
  return minutes < 60
    ? relativeTime.format( -minutes, "minute" )
    : relativeTime.format( -Math.round( minutes / 60 ), "hour" );
}

function initials( name ) {
  return name.split( /\s+/ ).map( ( part ) => part[ 0 ] ).join( "" ).slice( 0, 2 ).toUpperCase();
}

function selected() {
  return state.comments.find( ( c ) => c.id === state.selectedId );
}

function usable( api ) {
  return isUsable( state.status[ api ] );
}

function needsTranslation( c ) {
  return Boolean( c.language ) && c.language !== "en" && c.language !== "und";
}

/* ---------- Rendering ---------- */

function renderStatus() {
  const chips = Object.entries( API_LABELS ).map( ( [ api, label ] ) => {
    const status = state.status[ api ] ?? "checking";
    const progress = Object.entries( state.progress )
      .filter( ( [ key ] ) => key.split( ":" )[ 0 ] === api )
      .map( ( [ , value ] ) => value );
    const text = progress.length && progress.some( ( p ) => p < 1 )
      ? percent( progress.reduce( ( a, b ) => a + b, 0 ) / progress.length )
      : status;
    return `<li class="chip chip-${ esc( status ) }" title="${ esc( label ) }: ${ esc( status ) }">
      <span class="chip-dot" aria-hidden="true"></span>${ esc( label ) }
      <span class="chip-status">${ esc( text ) }</span>
    </li>`;
  });
  $( "ai-status" ).innerHTML = chips.join( "" );

  const pending = Object.values( state.status ).some( ( s ) => s === "downloadable" || s === "downloading" );
  $( "prepare" ).hidden = !pending;

  const notice = $( "notice" );
  const statuses = Object.values( state.status );
  const isChecked = statuses.length === Object.keys( API_LABELS ).length;
  if ( isChecked && !statuses.some( isUsable ) ) {
    notice.hidden = false;
    notice.textContent = "None of the built-in AI APIs are usable in this browser. Open the demo in desktop Chrome, see README.md for the flags.";
  } else if ( pending ) {
    notice.hidden = false;
    notice.textContent = "Some models need a one-time download. Click \"Download models\" (browsers only allow it after a click).";
  } else {
    notice.hidden = true;
  }
}

function languageBadge( c ) {
  if ( c.busy === "detect" ) {
    return `<span class="badge badge-pending">Detecting…</span>`;
  }
  if ( !c.language ) {
    return "";
  }
  if ( c.language === "und" ) {
    const guesses = c.candidates.map( ( r ) => `${ r.detectedLanguage } ${ percent( r.confidence ) }` ).join( ", " );
    return `<span class="badge badge-muted" title="Best guesses: ${ esc( guesses ) }">Unknown language</span>`;
  }
  return `<span class="badge badge-lang" title="Confidence ${ percent( c.confidence ) }">${ esc( langName( c.language ) ) }</span>`;
}

function triageBadges( c ) {
  if ( c.busy === "triage" ) {
    return `<span class="badge badge-pending">Triaging…</span>`;
  }
  const t = c.triage;
  if ( !t ) {
    return "";
  }
  return [
    `<span class="badge urgency urgency-${ esc( t.urgency ) }">${ esc( t.urgency ) } urgency</span>`,
    `<span class="badge">${ esc( t.category ) }</span>`,
    `<span class="badge sentiment-${ esc( t.sentiment ) }">${ esc( t.sentiment ) }</span>`,
    t.orderId ? `<span class="badge badge-mono">${ esc( t.orderId ) }</span>` : ""
  ].join( "" );
}

function sortedComments() {
  const list = [ ...state.comments ];
  if ( state.sort === "urgency" ) {
    const rank = ( c ) => c.triage ? URGENCY_ORDER[ c.triage.urgency ] ?? 3 : 3;
    list.sort( ( a, b ) => rank( a ) - rank( b ) || a.minutesAgo - b.minutesAgo );
  } else {
    list.sort( ( a, b ) => a.minutesAgo - b.minutesAgo );
  }
  return list;
}

function renderInbox() {
  $( "count" ).textContent = state.comments.length;
  $( "analyze" ).disabled = state.isAnalyzing || !usable( "LanguageDetector" );
  $( "analyze" ).textContent = state.isAnalyzing ? "Analyzing…" : "Analyze inbox";

  $( "inbox-list" ).innerHTML = sortedComments().map( ( c ) => `
    <li>
      <button type="button" class="inbox-item${ c.id === state.selectedId ? " is-selected" : "" }" data-action="select" data-id="${ c.id }">
        <span class="avatar" aria-hidden="true">${ esc( initials( c.author ) ) }</span>
        <span class="inbox-body">
          <span class="inbox-meta">
            <strong>${ esc( c.author ) }</strong>
            <time>${ esc( timeAgo( c.minutesAgo ) ) }</time>
          </span>
          <span class="inbox-text" lang="${ esc( c.language && c.language !== "und" ? c.language : "" ) }">${ esc( c.text ) }</span>
          <span class="badges">${ languageBadge( c ) }${ triageBadges( c ) }</span>
          ${ c.replies.length ? `<span class="replied">Replied</span>` : "" }
        </span>
      </button>
    </li>` ).join( "" );
}

function renderProof() {
  const { text, corrections } = state.proof;
  if ( !corrections.length ) {
    return `<div class="proof" id="proof"><p class="proof-ok">No issues found.</p></div>`;
  }
  let html = "";
  let cursor = 0;
  corrections.forEach( ( fix, i ) => {
    html += esc( text.slice( cursor, fix.startIndex ) );
    html += `<button type="button" class="fix" data-action="apply-fix" data-fix="${ i }" title="Apply this fix">`
      + `<del>${ esc( text.slice( fix.startIndex, fix.endIndex ) ) }</del>`
      + `<ins>${ esc( fix.correction ) }</ins></button>`;
    cursor = fix.endIndex;
  });
  html += esc( text.slice( cursor ) );
  return `<div class="proof" id="proof">
    <div class="proof-head">
      <span>${ corrections.length } ${ corrections.length === 1 ? "issue" : "issues" }. Click one to fix it.</span>
      <span>
        <button type="button" class="btn btn-small" data-action="apply-all">Fix all</button>
        <button type="button" class="btn btn-small btn-ghost" data-action="dismiss-proof">Dismiss</button>
      </span>
    </div>
    <p class="proof-text">${ html }</p>
  </div>`;
}

function renderDetail() {
  // Background analysis re-renders often, keep the caret where the user left it.
  const active = document.activeElement;
  const caret = active?.id === "reply-text"
    ? [ active.selectionStart, active.selectionEnd ]
    : null;
  renderDetailMarkup();
  if ( caret ) {
    const textarea = $( "reply-text" );
    textarea.focus();
    textarea.setSelectionRange( ...caret );
  }
}

function renderDetailMarkup() {
  const c = selected();
  if ( !c ) {
    $( "detail" ).innerHTML = `<p class="empty">Pick a comment from the inbox.</p>`;
    return;
  }
  const busy = Boolean( state.replyBusy );
  const showTranslated = c.showTranslation && c.translation;
  const target = needsTranslation( c ) ? langName( c.language ) : null;
  const presetOptions = Object.entries( REWRITE_PRESETS )
    .map( ( [ key, p ] ) => `<option value="${ key }"${ key === state.rewritePreset ? " selected" : "" }>${ esc( p.label ) }</option>` )
    .join( "" );
  const unavailable = ( api ) => usable( api ) ? "" : ` disabled title="${ esc( API_LABELS[ api ] ) } is not available in this browser"`;

  $( "detail" ).innerHTML = `
    <article class="ticket">
      <header class="ticket-head">
        <span class="avatar avatar-lg" aria-hidden="true">${ esc( initials( c.author ) ) }</span>
        <div>
          <h2>${ esc( c.author ) }</h2>
          <time>${ esc( timeAgo( c.minutesAgo ) ) }</time>
        </div>
      </header>
      <div class="badges">${ languageBadge( c ) }${ triageBadges( c ) }</div>
      ${ c.language === "und" && c.candidates.length ? `<p class="hint">Detector isn't sure. Best guesses: ${
        c.candidates.map( ( r ) => `${ esc( langName( r.detectedLanguage ) ) } ${ percent( r.confidence ) }` ).join( ", " ) }</p>` : "" }

      <blockquote class="ticket-text" lang="${ esc( showTranslated ? "en" : c.language && c.language !== "und" ? c.language : "" ) }">${
        esc( showTranslated ? c.translation : c.text ) }</blockquote>

      ${ c.language !== "en" ? `<div class="ticket-actions">
        <button type="button" class="btn btn-small" data-action="translate"${ unavailable( "Translator" ) }${ c.busy ? " disabled" : "" }>
          ${ c.busy === "translate" ? "Translating…" : showTranslated ? "Show original" : "Translate to English" }
        </button>
        ${ showTranslated ? `<span class="hint">Translated from ${ esc( langName( c.language ) ) } on this device</span>` : "" }
      </div>` : "" }
      ${ c.error ? `<p class="error">${ esc( c.error ) }</p>` : "" }

      ${ c.replies.map( ( r ) => `
        <div class="reply-sent">
          <div class="reply-sent-head">Acme Support</div>
          <p lang="${ esc( r.translated ? r.language : "en" ) }">${ esc( r.translated ?? r.text ) }</p>
          ${ r.translated ? `<details><summary>English original</summary><p>${ esc( r.text ) }</p></details>` : "" }
        </div>` ).join( "" ) }
    </article>

    <form class="reply" id="reply-form">
      <label for="reply-text">Your reply <span class="hint">(write in English${ target ? `, the customer gets it in ${ esc( target ) }` : "" })</span></label>
      <textarea id="reply-text" rows="8"${ busy ? " readonly" : "" }></textarea>
      ${ state.proof ? renderProof() : "" }
      ${ state.replyError ? `<p class="error">${ esc( state.replyError ) }</p>` : "" }
      <div class="toolbar">
        <button type="button" class="btn" data-action="draft"${ unavailable( "Writer" ) }${ busy ? " disabled" : "" }>
          ${ state.replyBusy === "draft" ? "Writing…" : "Draft it" }
        </button>
        <span class="split">
          <label class="visually-hidden" for="rewrite-preset">Rewrite style</label>
          <select id="rewrite-preset"${ busy ? " disabled" : "" }>${ presetOptions }</select>
          <button type="button" class="btn" data-action="rewrite"${ unavailable( "Rewriter" ) }${ busy ? " disabled" : "" }>
            ${ state.replyBusy === "rewrite" ? "Rewriting…" : "Rewrite" }
          </button>
        </span>
        <button type="button" class="btn" data-action="proofread"${ unavailable( "Proofreader" ) }${ busy ? " disabled" : "" }>
          ${ state.replyBusy === "proofread" ? "Checking…" : "Check" }
        </button>
        <button type="submit" class="btn btn-primary"${ busy ? " disabled" : "" }>
          ${ state.replyBusy === "send" ? "Translating…" : target ? `Send in ${ esc( target ) }` : "Send" }
        </button>
      </div>
    </form>`;

  $( "reply-text" ).value = c.draft;
}

function renderLog() {
  $( "log-count" ).textContent = state.log.length || "";
  $( "log" ).innerHTML = state.log.map( ( entry ) => `
    <li class="${ entry.error ? "log-error" : "" }">
      <code>${ esc( entry.label ) }</code>
      <span>${ entry.ms } ms</span>
      ${ entry.error ? `<span>${ esc( entry.error ) }</span>` : "" }
    </li>` ).join( "" );
}

function render() {
  renderStatus();
  renderInbox();
  renderDetail();
}

/* ---------- AI flows ---------- */

async function ensureLanguage( c ) {
  if ( c.language || !usable( "LanguageDetector" ) ) {
    return;
  }
  c.busy = "detect";
  render();
  try {
    Object.assign( c, await detectLanguage( c.text ) );
  } finally {
    c.busy = null;
  }
}

async function englishText( c ) {
  await ensureLanguage( c );
  if ( !needsTranslation( c ) ) {
    return c.text;
  }
  if ( !c.translation && usable( "Translator" ) ) {
    try {
      c.translation = await translate( c.text, c.language, "en" );
    } catch ( err ) {
      console.warn( "Translation failed, falling back to the original text", err );
      return c.text;
    }
  }
  return c.translation ?? c.text;
}

async function analyzeComment( c ) {
  c.error = null;
  try {
    await ensureLanguage( c );
    if ( !c.triage && usable( "LanguageModel" ) ) {
      // Nano does best in English, so triage the translation.
      const text = await englishText( c );
      c.busy = "triage";
      render();
      c.triage = await triage( text );
    }
  } catch ( err ) {
    c.error = err.message;
  } finally {
    c.busy = null;
    render();
  }
}

async function analyzeInbox() {
  state.isAnalyzing = true;
  render();
  for ( const c of sortedComments() ) {
    await analyzeComment( c );
  }
  state.isAnalyzing = false;
  render();
}

async function runReplyAction( name, fn ) {
  state.replyBusy = name;
  state.replyError = null;
  render();
  try {
    await fn();
  } catch ( err ) {
    state.replyError = err.message;
  } finally {
    state.replyBusy = null;
    render();
  }
}

function handleTranslate( c ) {
  if ( c.translation ) {
    c.showTranslation = !c.showTranslation;
    render();
    return;
  }
  c.error = null;
  c.busy = "translate";
  render();
  englishText( c )
    .then( () => {
      if ( c.language === "und" ) {
        c.error = "Can't translate: the language wasn't detected.";
      } else if ( !c.translation && needsTranslation( c ) ) {
        c.error = `No translation model for ${ langName( c.language ) } on this device.`;
      }
      c.showTranslation = Boolean( c.translation );
    })
    .catch( ( err ) => {
      c.error = err.message;
    })
    .finally( () => {
      c.busy = null;
      render();
    });
}

function handleDraft( c ) {
  runReplyAction( "draft", async () => {
    const english = await englishText( c );
    const t = c.triage;
    const facts = t
      ? ` Category: ${ t.category }. Urgency: ${ t.urgency }.${ t.orderId ? ` Order: ${ t.orderId }.` : "" }`
      : "";
    const task = `Write a reply to ${ c.author }, who left the customer comment given as context.${ facts }`;
    state.proof = null;
    renderDetail();
    c.draft = await draftReply( task, `Customer comment: ${ english }`, ( text ) => {
      c.draft = text;
      const textarea = $( "reply-text" );
      if ( textarea && state.selectedId === c.id ) {
        textarea.value = text;
      }
    });
  });
}

function handleRewrite( c ) {
  if ( !c.draft.trim() ) {
    state.replyError = "Write something first, then rewrite it.";
    renderDetail();
    return;
  }
  runReplyAction( "rewrite", async () => {
    c.draft = await rewrite( c.draft, state.rewritePreset );
    state.proof = null;
  });
}

function handleProofread( c ) {
  if ( !c.draft.trim() ) {
    state.replyError = "Nothing to check yet.";
    renderDetail();
    return;
  }
  runReplyAction( "proofread", async () => {
    const result = await proofread( c.draft );
    state.proof = {
      text: c.draft,
      corrections: [ ...result.corrections ].sort( ( a, b ) => a.startIndex - b.startIndex )
    };
  });
}

function applyFix( c, index ) {
  const { text, corrections } = state.proof;
  const fix = corrections[ index ];
  const next = text.slice( 0, fix.startIndex ) + fix.correction + text.slice( fix.endIndex );
  const shift = fix.correction.length - ( fix.endIndex - fix.startIndex );
  state.proof = {
    text: next,
    corrections: corrections
      .filter( ( _, i ) => i !== index )
      .map( ( other ) => other.startIndex >= fix.endIndex
        ? { ...other, startIndex: other.startIndex + shift, endIndex: other.endIndex + shift }
        : other )
  };
  c.draft = next;
  if ( !state.proof.corrections.length ) {
    state.proof = null;
  }
  renderDetail();
}

function handleSend( c ) {
  const text = c.draft.trim();
  if ( !text ) {
    return;
  }
  runReplyAction( "send", async () => {
    const translated = needsTranslation( c ) ? await translate( text, "en", c.language ) : null;
    c.replies.push({ text, translated, language: c.language });
    c.draft = "";
    state.proof = null;
  });
}

/* ---------- Events ---------- */

document.addEventListener( "click", ( e ) => {
  const target = e.target.closest( "[data-action]" );
  if ( !target || target.disabled ) {
    return;
  }
  const c = selected();
  switch ( target.dataset.action ) {
  case "select":
    state.selectedId = Number( target.dataset.id );
    state.proof = null;
    state.replyError = null;
    render();
    break;
  case "translate":
    handleTranslate( c );
    break;
  case "draft":
    handleDraft( c );
    break;
  case "rewrite":
    handleRewrite( c );
    break;
  case "proofread":
    handleProofread( c );
    break;
  case "apply-fix":
    applyFix( c, Number( target.dataset.fix ) );
    break;
  case "apply-all":
    c.draft = state.proof.text;
    state.proof.corrections.slice().reverse().forEach( ( fix ) => {
      c.draft = c.draft.slice( 0, fix.startIndex ) + fix.correction + c.draft.slice( fix.endIndex );
    });
    state.proof = null;
    renderDetail();
    break;
  case "dismiss-proof":
    state.proof = null;
    renderDetail();
    break;
  default:
    break;
  }
});

document.addEventListener( "input", ( e ) => {
  if ( e.target.id === "reply-text" ) {
    selected().draft = e.target.value;
    if ( state.proof ) {
      // Indices no longer match the text.
      state.proof = null;
      $( "proof" )?.remove();
    }
  }
});

document.addEventListener( "change", ( e ) => {
  if ( e.target.id === "rewrite-preset" ) {
    state.rewritePreset = e.target.value;
  }
  if ( e.target.id === "sort" ) {
    state.sort = e.target.value;
    renderInbox();
  }
});

document.addEventListener( "submit", ( e ) => {
  if ( e.target.id === "reply-form" ) {
    e.preventDefault();
    handleSend( selected() );
  }
});

$( "analyze" ).addEventListener( "click", () => analyzeInbox() );

$( "prepare" ).addEventListener( "click", async () => {
  $( "prepare" ).disabled = true;
  // No await before this call: create() needs the click's user activation.
  const results = await prepareAll( state.status );
  results
    .filter( ( r ) => r.status === "rejected" )
    .forEach( ( r ) => console.warn( "Model preparation failed", r.reason ) );
  $( "prepare" ).disabled = false;
  await refreshStatus();
  analyzeInbox();
});

onProgress( ( key, loaded ) => {
  state.progress[ key ] = loaded;
  renderStatus();
});

onLog( ( entry ) => {
  state.log.unshift( entry );
  state.log.length = Math.min( state.log.length, 100 );
  renderLog();
});

function refreshStatus() {
  return Promise.all( Object.keys( API_LABELS ).map( async ( api ) => {
    state.status[ api ] = await checkAvailability( api );
    render();
  }) );
}

render();
await refreshStatus();
// A returning visitor already has the models, so no click is needed.
if ( state.status.LanguageDetector === "available" ) {
  analyzeInbox();
}
