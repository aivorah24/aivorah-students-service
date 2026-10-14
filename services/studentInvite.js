// Real-email students created by a teacher get the platform-admin "Add user"
// flow: Firebase login with a random password nobody sees, a set-password
// invite, and auth-service's verification email. They can't use the app until
// they verify (accountStatus stays pending_verification until then).
// Auto-generated @aivorah.student logins keep the credentials flow instead.
const { randomUUID } = require('crypto');
const firebaseAdmin = require('./firebaseAdmin');
const { sendStudentInviteEmail } = require('./mailer');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'https://aivorah-auth-service-g27s.onrender.com';
const APP_URL = process.env.APP_URL || 'https://aivorah.ai';
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isRealEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(e) && !e.endsWith('@aivorah.student');
}

function appBaseFor(frontendOrigin) {
  return ORIGIN_RE.test(String(frontendOrigin || '')) ? frontendOrigin : APP_URL;
}

async function createInvitedFirebaseUser(email, name) {
  return firebaseAdmin.auth().createUser({
    email, password: randomUUID() + 'Aa1!', displayName: `${name}|student`, emailVerified: false,
  });
}

// Never throws — the account is kept if an email fails; the teacher can resend.
async function sendInviteAndVerification({ email, name, frontendOrigin }) {
  const appBase = appBaseFor(frontendOrigin);
  let inviteSent = false; let inviteError = null;
  try {
    const link = await firebaseAdmin.auth().generatePasswordResetLink(email, { url: `${appBase}/` });
    await sendStudentInviteEmail({ to: email, name, link });
    inviteSent = true;
  } catch (err) {
    console.warn('[studentInvite] invite email failed:', err.message);
    inviteError = 'Account created, but the invite email could not be sent. Ask the student to use "Forgot password".';
  }

  let verificationSent = false;
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/user/send-verification`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, frontendOrigin: appBase }),
    });
    verificationSent = res.ok;
    if (!res.ok) console.warn('[studentInvite] send-verification failed:', res.status);
  } catch (err) {
    console.warn('[studentInvite] send-verification failed:', err.message);
  }
  return { inviteSent, inviteError, verificationSent };
}

module.exports = { isRealEmail, createInvitedFirebaseUser, sendInviteAndVerification };
