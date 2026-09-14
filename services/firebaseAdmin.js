// Firebase Admin — used for a reliable server-side "does this email already
// have a Firebase Auth account" check (see firebaseEmailExists() in
// routes/teacher.js). The public accounts:createAuthUri REST endpoint used
// previously silently stopped revealing this once Email Enumeration
// Protection was enabled on the Firebase project — it returns the exact same
// response for an existing and a nonexistent email, so that check was a
// permanent no-op. admin.auth().getUserByEmail() bypasses that entirely.
//
// Same init pattern as aivorah-auth-service/services/firebaseAdmin.js — kept
// in sync deliberately, copy changes there too if this needs updating.
//   1. FIREBASE_SERVICE_ACCOUNT_B64 env var (base64 JSON) — Render/production
//   2. FIREBASE_SERVICE_ACCOUNT env var (raw JSON) — alternate production path
//   3. firebase-service-account.json file — local dev

let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
      const svcJson = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
      credential = admin.credential.cert(svcJson);
      console.log('[firebase-admin] initialised from FIREBASE_SERVICE_ACCOUNT_B64 env var');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const svcJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(svcJson);
      console.log('[firebase-admin] initialised from FIREBASE_SERVICE_ACCOUNT env var');
    } else {
      const svcPath = require('path').join(__dirname, '../firebase-service-account.json');
      if (require('fs').existsSync(svcPath)) {
        credential = admin.credential.cert(require(svcPath));
        console.log('[firebase-admin] initialised from service account file');
      }
    }

    if (credential) {
      admin.initializeApp({ credential });
      firebaseAdmin = admin;
    } else {
      console.warn('[firebase-admin] no service account found — student email-exists check will fall back to Supabase-only');
    }
  } else {
    firebaseAdmin = admin;
  }
} catch (e) {
  console.warn('[firebase-admin] not available:', e.message);
}

module.exports = firebaseAdmin;
