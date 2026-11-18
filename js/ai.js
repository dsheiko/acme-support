/**
 * Thin wrappers around Chrome built-in AI APIs.
 * Every instance is created once and cached by key, so the UI can call these freely.
 */

export const SUPPORT_LANGUAGES = [ "de", "es", "ja", "uk", "fr" ];

const MIN_CONFIDENCE = 0.5;

const TRIAGE_SYSTEM_PROMPT = "You triage customer support comments for Acme, an online store "
  + "that sells home electronics. Urgency is high when the customer lost money or cannot use "
  + "the product, medium when something is broken but there is a workaround, low otherwise. "
  + "orderId is an order number mentioned in the comment, or null.";

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    sentiment: { type: "string", enum: [ "positive", "neutral", "negative", "angry" ] },
    category: { type: "string", enum: [ "billing", "delivery", "bug", "feature-request", "praise", "other" ] },
    urgency: { type: "string", enum: [ "low", "medium", "high" ] },
    orderId: { type: [ "string", "null" ] }
  },
  required: [ "sentiment", "category", "urgency", "orderId" ],
  additionalProperties: false
};

const PROMPT_IO = {
  expectedInputs: [{ type: "text", languages: [ "en" ] }],
  expectedOutputs: [{ type: "text", languages: [ "en" ] }]
};

const PROMPT_OPTIONS = {
  ...PROMPT_IO,
  initialPrompts: [{ role: "system", content: TRIAGE_SYSTEM_PROMPT }]
};

const WRITER_OPTIONS = {
  tone: "neutral",
  format: "plain-text",
  length: "short",
  sharedContext: "Replies from the Acme customer support team to customers. "
    + "Do not promise refunds, discounts or delivery dates. Sign as Acme Support.",
  expectedInputLanguages: [ "en" ],
  expectedContextLanguages: [ "en" ],
  outputLanguage: "en"
};

const REWRITER_BASE = {
  format: "plain-text",
  sharedContext: "A reply from customer support to a customer.",
  expectedInputLanguages: [ "en" ],
  expectedContextLanguages: [ "en" ],
  outputLanguage: "en"
};

export const REWRITE_PRESETS = {
  formal: { label: "More formal", options: { tone: "more-formal" } },
  casual: { label: "Friendlier", options: { tone: "more-casual" } },
  shorter: { label: "Shorter", options: { length: "shorter" } },
  longer: { label: "Longer", options: { length: "longer" } }
};

const PROOFREADER_OPTIONS = {
  expectedInputLanguages: [ "en" ]
};

/** Options used for availability checks, one entry per API. */
const AVAILABILITY_OPTIONS = {
  LanguageDetector: {},
  LanguageModel: PROMPT_IO,
  Writer: WRITER_OPTIONS,
  Rewriter: { ...REWRITER_BASE, ...REWRITE_PRESETS.formal.options },
  Proofreader: PROOFREADER_OPTIONS
};

export const API_LABELS = {
  LanguageDetector: "Language Detector",
  Translator: "Translator",
  LanguageModel: "Prompt API",
  Writer: "Writer",
  Rewriter: "Rewriter",
  Proofreader: "Proofreader"
};

let logHandler = () => {};
let progressHandler = () => {};

export function onLog( fn ) {
  logHandler = fn;
}

export function onProgress( fn ) {
  progressHandler = fn;
}

async function timed( label, fn ) {
  const start = performance.now();
  try {
    const result = await fn();
    logHandler({ label, ms: Math.round( performance.now() - start ) });
    return result;
  } catch ( err ) {
    logHandler({ label, ms: Math.round( performance.now() - start ), error: err.message });
    throw err;
  }
}

const instances = new Map();

/**
 * Returns a cached instance promise. The create() call itself happens synchronously,
 * which matters: when the model has to be downloaded, create() needs user activation,
 * and activation is gone after a couple of awaits.
 */
function getInstance( key, api, options ) {
  if ( !instances.has( key ) ) {
    const promise = timed( `${ key } create()`, () => self[ api ].create({
      ...options,
      monitor( m ) {
        m.addEventListener( "downloadprogress", ( e ) => progressHandler( key, e.loaded ) );
      }
    }) );
    promise.catch( () => instances.delete( key ) );
    instances.set( key, promise );
  }
  return instances.get( key );
}

function translatorPairs() {
  return SUPPORT_LANGUAGES.flatMap( ( lang ) => [
    { sourceLanguage: lang, targetLanguage: "en" },
    { sourceLanguage: "en", targetLanguage: lang }
  ]);
}

const STATUS_RANK = [ "unsupported", "unavailable", "downloadable", "downloading", "available" ];
const AVAILABILITY_TIMEOUT = 5000;

function withTimeout( promise, ms, label ) {
  return Promise.race([
    promise,
    new Promise( ( _, reject ) => setTimeout( () => reject( new Error( `${ label } timed out after ${ ms } ms` ) ), ms ) )
  ]);
}

/**
 * @returns {Promise<"unsupported"|"unavailable"|"downloadable"|"downloading"|"available">}
 */
export async function checkAvailability( api ) {
  if ( !( api in self ) ) {
    return "unsupported";
  }
  try {
    // Seen in headless Chrome 148: Translator.availability() never settles.
    if ( api === "Translator" ) {
      // Each language pair is its own download. Report the least ready one.
      const all = await withTimeout(
        Promise.all( translatorPairs().map( ( pair ) => Translator.availability( pair ) ) ),
        AVAILABILITY_TIMEOUT,
        "Translator.availability()"
      );
      return all.reduce( ( worst, s ) => STATUS_RANK.indexOf( s ) < STATUS_RANK.indexOf( worst ) ? s : worst, "available" );
    }
    return await withTimeout(
      self[ api ].availability( AVAILABILITY_OPTIONS[ api ] ),
      AVAILABILITY_TIMEOUT,
      `${ api }.availability()`
    );
  } catch ( err ) {
    console.warn( `${ api }.availability() failed`, err );
    return "unavailable";
  }
}

export function isUsable( status ) {
  return [ "available", "downloadable", "downloading" ].includes( status );
}

/**
 * Kicks off every model download at once. Must be called straight from a click handler.
 */
export function prepareAll( statuses ) {
  const jobs = [];
  if ( isUsable( statuses.LanguageDetector ) ) {
    jobs.push( getInstance( "LanguageDetector", "LanguageDetector", {}) );
  }
  if ( isUsable( statuses.Translator ) ) {
    translatorPairs().forEach( ( pair ) => {
      jobs.push( getInstance( `Translator:${ pair.sourceLanguage }-${ pair.targetLanguage }`, "Translator", pair ) );
    });
  }
  if ( isUsable( statuses.LanguageModel ) ) {
    jobs.push( getInstance( "LanguageModel", "LanguageModel", PROMPT_OPTIONS ) );
  }
  if ( isUsable( statuses.Writer ) ) {
    jobs.push( getInstance( "Writer", "Writer", WRITER_OPTIONS ) );
  }
  if ( isUsable( statuses.Rewriter ) ) {
    jobs.push( getInstance( "Rewriter:formal", "Rewriter", { ...REWRITER_BASE, ...REWRITE_PRESETS.formal.options }) );
  }
  if ( isUsable( statuses.Proofreader ) ) {
    jobs.push( getInstance( "Proofreader", "Proofreader", PROOFREADER_OPTIONS ) );
  }
  return Promise.allSettled( jobs );
}

/**
 * @returns {Promise<{ language: string, confidence: number, candidates: Array<{ detectedLanguage: string, confidence: number }> }>}
 */
export async function detectLanguage( text ) {
  const detector = await getInstance( "LanguageDetector", "LanguageDetector", {});
  const results = await timed( "LanguageDetector detect()", () => detector.detect( text ) );
  const [ top ] = results;
  return {
    language: top && top.confidence >= MIN_CONFIDENCE ? top.detectedLanguage : "und",
    confidence: top ? top.confidence : 0,
    candidates: results.slice( 0, 3 )
  };
}

export async function translate( text, sourceLanguage, targetLanguage ) {
  const key = `Translator:${ sourceLanguage }-${ targetLanguage }`;
  const translator = await getInstance( key, "Translator", { sourceLanguage, targetLanguage });
  return timed( `${ key } translate()`, () => translator.translate( text ) );
}

export async function triage( englishText ) {
  const base = await getInstance( "LanguageModel", "LanguageModel", PROMPT_OPTIONS );
  // Comments are independent, so each one gets a fresh copy of the system prompt only.
  const session = await base.clone();
  try {
    const raw = await timed( "LanguageModel prompt()", () => session.prompt(
      `Customer comment:\n"""\n${ englishText }\n"""`,
      { responseConstraint: TRIAGE_SCHEMA }
    ) );
    return JSON.parse( raw );
  } finally {
    session.destroy();
  }
}

export async function draftReply( task, context, onChunk ) {
  const writer = await getInstance( "Writer", "Writer", WRITER_OPTIONS );
  return timed( "Writer writeStreaming()", async () => {
    let text = "";
    for await ( const chunk of writer.writeStreaming( task, { context }) ) {
      text += chunk;
      onChunk( text );
    }
    return text;
  });
}

export async function rewrite( text, preset ) {
  const rewriter = await getInstance(
    `Rewriter:${ preset }`,
    "Rewriter",
    { ...REWRITER_BASE, ...REWRITE_PRESETS[ preset ].options }
  );
  return timed( `Rewriter:${ preset } rewrite()`, () => rewriter.rewrite( text ) );
}

/**
 * @returns {Promise<{ correctedInput: string, corrections: Array<{ startIndex: number, endIndex: number, correction: string }> }>}
 */
export async function proofread( text ) {
  const proofreader = await getInstance( "Proofreader", "Proofreader", PROOFREADER_OPTIONS );
  return timed( "Proofreader proofread()", () => proofreader.proofread( text ) );
}
