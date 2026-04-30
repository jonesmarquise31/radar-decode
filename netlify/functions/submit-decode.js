// Netlify Function: handles the Radar Decode post-payment intake form.
//
// Accepts POST multipart/form-data with: session_id, linkedin_url, resume (file).
// Verifies the Stripe session is real, paid, and matches the Decode price.
// Uploads the resume to Supabase Storage (decode-resumes bucket) and inserts
// a row into public.decode_submissions. Idempotent on stripe_session_id.
//
// Env required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   STRIPE_SECRET_KEY
//   DECODE_PRICE_AMOUNT_CENTS  (e.g. 4700)

const Busboy = require('busboy');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const LINKEDIN_RE = /^https?:\/\/([a-z]+\.)?linkedin\.com\/(in|mwlite\/in)\/[A-Za-z0-9_%-]+(\/.*)?$/i;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return resp(204, null);
  }
  if (event.httpMethod !== 'POST') {
    return resp(405, { success: false, error: 'Method not allowed' });
  }

  console.log('[submit-decode] received', { method: event.httpMethod });

  // Required server config — fail closed if anything is missing,
  // but never reveal which key is unset.
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const expectedAmount = parseInt(process.env.DECODE_PRICE_AMOUNT_CENTS || '', 10);
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !STRIPE_SECRET_KEY ||
    !Number.isFinite(expectedAmount)
  ) {
    return resp(500, { success: false, error: 'Server is not configured for submissions yet.' });
  }

  // Parse multipart body.
  let parsed;
  try {
    parsed = await parseMultipart(event);
  } catch (err) {
    if (err && err.code === 'FILE_TOO_LARGE') {
      return resp(400, { success: false, error: 'Resume must be 10MB or smaller.' });
    }
    return resp(400, { success: false, error: 'Could not read your submission. Please try again.' });
  }

  const session_id = (parsed.session_id || '').trim();
  const linkedin_url = (parsed.linkedin_url || '').trim();
  const resume = parsed.resume;

  if (!session_id) {
    return resp(400, { success: false, error: 'Missing payment session.' });
  }
  if (!linkedin_url || !LINKEDIN_RE.test(linkedin_url)) {
    return resp(400, {
      success: false,
      error: 'Enter a valid LinkedIn profile URL (e.g. https://linkedin.com/in/yourname).',
    });
  }
  if (!resume || !resume.buffer || !resume.filename) {
    return resp(400, { success: false, error: 'Attach your resume to continue.' });
  }
  if (!ALLOWED_MIME.has(resume.mimeType)) {
    return resp(400, { success: false, error: 'Resume must be a PDF, DOC, or DOCX.' });
  }
  if (resume.buffer.length === 0) {
    return resp(400, { success: false, error: 'Resume file appears to be empty.' });
  }
  if (resume.buffer.length > MAX_BYTES) {
    return resp(400, { success: false, error: 'Resume must be 10MB or smaller.' });
  }

  // Verify Stripe session — must be real, paid, and the right price.
  const stripe = Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' });
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch (err) {
    return resp(400, { success: false, error: 'Payment session not found.' });
  }
  if (!session || session.payment_status !== 'paid') {
    return resp(402, { success: false, error: 'Payment is not marked complete yet.' });
  }
  if (session.amount_total !== expectedAmount) {
    return resp(402, { success: false, error: 'Payment amount does not match this offer.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Idempotency: if a row already exists for this session, treat as success.
  {
    const { data: existing, error: lookupErr } = await supabase
      .from('decode_submissions')
      .select('id')
      .eq('stripe_session_id', session_id)
      .maybeSingle();
    if (lookupErr) {
      return resp(500, { success: false, error: 'Could not save your submission. Please try again.' });
    }
    if (existing) {
      return resp(200, { success: true, alreadySubmitted: true });
    }
  }

  // Upload resume to private storage bucket. Path = sessionId/safeFilename.
  const safeFilename = resume.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'resume';
  const storagePath = `${session_id}/${safeFilename}`;
  {
    const { error: uploadErr } = await supabase
      .storage
      .from('decode-resumes')
      .upload(storagePath, resume.buffer, {
        contentType: resume.mimeType,
        upsert: true,
      });
    if (uploadErr) {
      return resp(500, { success: false, error: 'Could not save your resume. Please try again.' });
    }
  }

  // Insert submission row.
  const customerEmail =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    '';
  const customerName =
    (session.customer_details && session.customer_details.name) || null;

  const { error: insertErr } = await supabase.from('decode_submissions').insert({
    stripe_session_id: session_id,
    stripe_payment_status: session.payment_status,
    customer_email: customerEmail,
    customer_name: customerName,
    amount_paid_cents: session.amount_total,
    linkedin_url,
    resume_storage_path: storagePath,
    resume_filename: resume.filename,
  });
  if (insertErr) {
    // 23505 = unique_violation: a concurrent request claimed the same session_id.
    if (insertErr.code === '23505') {
      return resp(200, { success: true, alreadySubmitted: true });
    }
    return resp(500, { success: false, error: 'Could not save your submission. Please try again.' });
  }

  console.log('[submit-decode] inserted', { session_id });

  return resp(200, { success: true });
};

// ---------- helpers ----------

function resp(statusCode, body) {
  const headers = {
    'cache-control': 'no-store',
    'access-control-allow-origin': 'https://radar-decode.netlify.app',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
  if (body === null) {
    return { statusCode, headers };
  }
  return {
    statusCode,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function lowercaseHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) out[k.toLowerCase()] = h[k];
  return out;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const headers = lowercaseHeaders(event.headers);
    const contentType = headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return reject(new Error('Expected multipart/form-data'));
    }

    let busboy;
    try {
      busboy = Busboy({
        headers,
        limits: { files: 1, fileSize: MAX_BYTES, fields: 20, fieldSize: 4096 },
      });
    } catch (err) {
      return reject(err);
    }

    const fields = {};
    let fileResult = null;
    let fileTooLarge = false;
    let busboyError = null;

    busboy.on('field', (name, val) => {
      fields[name] = val;
    });

    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        fileTooLarge = true;
        stream.resume();
      });
      stream.on('end', () => {
        if (fileTooLarge) return;
        fileResult = {
          fieldName: name,
          filename: info.filename || 'resume',
          mimeType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(chunks),
        };
      });
      stream.on('error', (e) => {
        busboyError = e;
      });
    });

    busboy.on('error', (e) => {
      busboyError = e;
    });

    busboy.on('close', () => {
      if (busboyError) return reject(busboyError);
      if (fileTooLarge) {
        const e = new Error('File too large');
        e.code = 'FILE_TOO_LARGE';
        return reject(e);
      }
      resolve({ ...fields, resume: fileResult });
    });

    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'utf8');
    busboy.end(body);
  });
}
