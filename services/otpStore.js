// Stateless OTP store backed by the `otp_codes` Supabase table. Ported
// verbatim from ai-mentor/server/services/otpStore.js as part of moving
// parent-onboarding child-email verification off the monolith (which had
// no test-environment Supabase project) onto this service's Test-project
// connection.

const supabase = require('./supabase');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const _mem = new Map();
let _tableMissing = false;

const memKey = (email, purpose) => `${purpose}:${email}`;

function isMissingTable(error) {
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || /relation .* does not exist|could not find the table/i.test(error?.message || '')
  );
}

function warnMissing() {
  if (_tableMissing) return;
  _tableMissing = true;
  console.warn('[otpStore] `otp_codes` table not found - using in-memory fallback (not safe across multiple instances).');
}

async function setOtp(email, purpose, { otp, ttlMs = DEFAULT_TTL_MS } = {}) {
  const expiresAt = Date.now() + ttlMs;
  try {
    if (!_tableMissing) {
      const { error } = await supabase
        .from('otp_codes')
        .upsert({ email, purpose, otp, expires_at: new Date(expiresAt).toISOString() }, { onConflict: 'email,purpose' });
      if (error) throw error;
      return;
    }
  } catch (error) {
    if (isMissingTable(error)) warnMissing();
    else console.error('[otpStore.setOtp]', error.message || error);
  }
  _mem.set(memKey(email, purpose), { otp, expiresAt });
}

async function getOtp(email, purpose) {
  try {
    if (!_tableMissing) {
      const { data, error } = await supabase
        .from('otp_codes').select('otp, expires_at').eq('email', email).eq('purpose', purpose).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { otp: data.otp, expiresAt: new Date(data.expires_at).getTime() };
    }
  } catch (error) {
    if (isMissingTable(error)) warnMissing();
    else console.error('[otpStore.getOtp]', error.message || error);
  }
  const m = _mem.get(memKey(email, purpose));
  return m ? { otp: m.otp, expiresAt: m.expiresAt } : null;
}

async function deleteOtp(email, purpose) {
  try {
    if (!_tableMissing) {
      const { error } = await supabase.from('otp_codes').delete().eq('email', email).eq('purpose', purpose);
      if (error) throw error;
    }
  } catch (error) {
    if (isMissingTable(error)) warnMissing();
    else console.error('[otpStore.deleteOtp]', error.message || error);
  }
  _mem.delete(memKey(email, purpose));
}

module.exports = { setOtp, getOtp, deleteOtp };
