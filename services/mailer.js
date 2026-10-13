const { Resend } = require('resend');
const nodemailer = require('nodemailer');

// ── Primary: Resend (noreply@aivorah.ai) ────────────────────────────────────
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = 'Aivorah <noreply@aivorah.ai>';

// ── Fallback: Gmail SMTP (only if Resend not configured) ────────────────────
const gmailTransporter = (!resend && process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      pool: true, maxConnections: 3, maxMessages: 10, rateDelta: 2000, rateLimit: 5,
    })
  : null;

// Strip HTML to plain text
function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Send email (Resend primary, Gmail fallback) ─────────────────────────────
async function sendEmail({ to, subject, html, replyTo, attachments }, retries = 3) {
  const text = htmlToPlainText(html);

  // Try Resend first
  if (resend) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const { data, error } = await resend.emails.send({
          from: FROM_EMAIL,
          to,
          subject,
          html,
          text,
          ...(replyTo ? { replyTo } : {}),
          ...(attachments ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}),
        });
        if (error) throw new Error(error.message);
        console.log(`[mailer:resend] Sent to ${to} (attempt ${attempt}), id: ${data?.id}`);
        return data;
      } catch (err) {
        console.warn(`[mailer:resend] Attempt ${attempt}/${retries} failed for ${to}: ${err.message}`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        else throw err;
      }
    }
  }

  // Fallback to Gmail SMTP
  if (gmailTransporter) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const info = await gmailTransporter.sendMail({
          from: `"Aivorah" <${process.env.EMAIL_USER}>`,
          to, subject, html, text,
          replyTo: replyTo || `"Aivorah" <${process.env.EMAIL_USER}>`,
          ...(attachments ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content, encoding: 'base64', contentType: a.contentType })) } : {}),
        });
        console.log(`[mailer:gmail] Sent to ${to} (attempt ${attempt}), messageId: ${info.messageId}`);
        return info;
      } catch (err) {
        console.warn(`[mailer:gmail] Attempt ${attempt}/${retries} failed for ${to}: ${err.message}`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        else throw err;
      }
    }
  }

  console.warn(`[mailer] No email provider configured — skipping email to ${to}`);
}

// ── Email functions (templates unchanged) ───────────────────────────────────

async function sendCredentialsEmail({ to, childName, loginId, password, childEmail }) {
  if (!to) return;
  try {
    const passwordRow = password
      ? `<tr><td style="padding:8px 0;color:#888;font-size:13px">Password</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${password}</td></tr>`
      : '';

    // Only offer a "forward to child" button when this copy is going to someone
    // other than the child (i.e. the parent/teacher), and there's a password to forward.
    const canForward = password && childEmail && childEmail.toLowerCase() !== String(to).toLowerCase();
    const forwardBlock = canForward ? (() => {
      const shareText = `Hi ${childName},\n\nHere are your Aivorah login details:\n\nLogin ID: ${loginId}\nPassword: ${password}\n\nLog in at https://aivorah.ai`;
      const mailtoBody = encodeURIComponent(shareText);
      const mailtoHref = `mailto:${encodeURIComponent(childEmail)}?subject=${encodeURIComponent('Your Aivorah Login')}&body=${mailtoBody}`;
      // WhatsApp's click-to-chat URL is a plain link (no JS/Web Share API needed,
      // so it works inside any email client) — opens the app with the message
      // pre-filled, letting the parent pick who to send it to (WhatsApp, SMS via
      // the OS share sheet on mobile, etc.), not just the child's own email.
      const waHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
      return `
          <div style="text-align:center;margin:4px 0 20px">
            <a href="${mailtoHref}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;margin:0 6px 8px">
              Forward via Email
            </a>
            <a href="${waHref}" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;margin:0 6px 8px">
              Share via WhatsApp
            </a>
            <p style="font-size:12px;color:#999;margin:8px 0 0">Opens your mail app or WhatsApp with the Login ID and Password pre-filled.</p>
          </div>`;
    })() : '';

    await sendEmail({
      to,
      subject: `${childName}'s Aivorah Login Details`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Student account ready</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi there!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            The student account for <strong>${childName}</strong> has been created on Aivorah.
            Here are the login credentials — please save them somewhere safe.
          </p>

          <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Login ID</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${loginId}</td></tr>
              ${passwordRow}
            </table>
          </div>
${forwardBlock}
          <p style="font-size:13px;color:#666;line-height:1.6">
            Your child can log in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a>
            using the <strong>Login ID</strong> and <strong>Password</strong> above.
            Select <em>Student</em> on the login screen.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a student account was created via Aivorah. If you didn't request this, please contact support.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendCredentialsEmail failed:', err.message);
  }
}

// One consolidated email per bulk-import batch, with a CSV attachment of every
// created student's login/password — replaces sending the teacher a separate
// email for every single row, which flooded their inbox on a large import.
async function sendBulkCredentialsEmail({ to, created }) {
  if (!to || !created || created.length === 0) return;
  try {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const roleLabel = (role) => (role === 'parent' ? 'Parent' : 'Student');

    // A bulk import creates BOTH students and their parents — the email must
    // reflect that mix, not label everyone a "student" (parents were being told
    // to log in as Student, which fails). Each row carries its own role.
    const studentCount = created.filter(r => r.role !== 'parent').length;
    const parentCount = created.filter(r => r.role === 'parent').length;

    // Human breakdown, e.g. "2 students and 2 parents" / "3 students" / "1 parent".
    const parts = [];
    if (studentCount) parts.push(`${studentCount} student${studentCount !== 1 ? 's' : ''}`);
    if (parentCount) parts.push(`${parentCount} parent${parentCount !== 1 ? 's' : ''}`);
    const breakdown = parts.join(' and ');
    const totalWord = `${created.length} account${created.length !== 1 ? 's were' : ' was'} created`;

    const csvLines = [
      'Name,Role,Login Email,Password,Grade,Curriculum',
      ...created.map(r => [r.name, roleLabel(r.role), r.email, r.password || 'Invite emailed', r.grade, r.curriculum].map(esc).join(',')),
    ];
    const csvContent = csvLines.join('\n');

    // word-break lets long Login IDs / passwords WRAP inside their cell instead
    // of forcing the table wider than a phone screen (the mobile overflow bug).
    const rowsHtml = created.map(r => `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;word-break:break-word">${r.name}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:${r.role === 'parent' ? '#7C3AED' : '#0f766e'};font-weight:700">${roleLabel(r.role)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;word-break:break-all">${r.email}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;word-break:break-all">${r.password || 'Invite emailed'}</td>
          </tr>`).join('');

    await sendEmail({
      to,
      subject: `${created.length} login${created.length !== 1 ? 's' : ''} created — Aivorah bulk import`,
      attachments: [{
        filename: `logins_${new Date().toISOString().split('T')[0]}.csv`,
        content: Buffer.from(csvContent).toString('base64'),
        contentType: 'text/csv',
      }],
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Bulk import complete</p>
          </div>
          <p style="font-size:14px;color:#555;line-height:1.6">
            <strong>${totalWord}</strong>${breakdown ? ` (${breakdown})` : ''}. The full list is attached as a CSV — here's a quick preview:
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;table-layout:fixed">
            <colgroup>
              <col style="width:22%"><col style="width:16%"><col style="width:33%"><col style="width:29%">
            </colgroup>
            <thead>
              <tr style="background:#f5f3ff">
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Name</td>
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Role</td>
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Login ID</td>
                <td style="padding:6px 8px;font-size:12px;color:#888;font-weight:700">Password</td>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <p style="font-size:13px;color:#666;line-height:1.6">
            Everyone logs in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a> using their Login ID and Password above — each person selects their own role on the login screen (<em>Student</em> for students, <em>Parent</em> for parents). Everyone is asked to set a new password on first sign-in.
          </p>
          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a bulk import was run on your Aivorah account.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendBulkCredentialsEmail failed:', err.message);
  }
}

async function sendOwnAccountCredentialsEmail({ to, name, loginId, password, role }) {
  if (!to) return;
  const roleLabel = role === 'teacher' ? 'Teacher' : role === 'parent' ? 'Parent' : 'Student';
  try {
    await sendEmail({
      to,
      subject: `Your Aivorah ${roleLabel} account is ready`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">${roleLabel} account ready</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name || 'there'}!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Your Aivorah ${roleLabel} account has been created. Here are your login credentials — please save them somewhere safe.
          </p>

          <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Login ID</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${loginId}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Password</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${password}</td></tr>
            </table>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            Log in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a>
            using the <strong>Login ID</strong> and <strong>Password</strong> above. Select <em>${roleLabel}</em> on the login screen.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a ${roleLabel} account was created for you on Aivorah. If you didn't expect this, please contact support.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendOwnAccountCredentialsEmail failed:', err.message);
  }
}

// Ported from ai-mentor/server/services/mailer.js's sendEmailOtpCode - used
// by routes/parent.js's child-email-verification OTP routes.
async function sendEmailOtpCode({ to, otp, name }) {
  if (!to || !otp) return;
  return sendEmail({
    to,
    subject: 'Your Aivorah verification code',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
        <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
          <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Verify your email</p>
        </div>
        <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name || 'there'},</p>
        <p style="font-size:14px;color:#555;line-height:1.6">
          Enter the code below to verify this email address on Aivorah. This code expires in <strong>10 minutes</strong>.
        </p>
        <div style="text-align:center;margin:32px 0">
          <div style="display:inline-block;background:#f5f3ff;border:2px solid #7C3AED;border-radius:16px;padding:20px 48px">
            <span style="font-size:36px;font-weight:800;color:#7C3AED;letter-spacing:10px">${otp}</span>
          </div>
        </div>
        <p style="font-size:13px;color:#666;line-height:1.6">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

// Ported from ai-mentor/server/services/mailer.js - used by routes/parent.js's
// child password-reset route.
async function sendPasswordResetEmail({ to, resetLink, childName }) {
  if (!to || !resetLink) return;
  const isChildReset = !!childName;
  const subject = isChildReset ? `Reset ${childName}'s Aivorah password` : 'Reset your Aivorah password';
  const bodyText = isChildReset
    ? `You requested a password reset for your child <strong>${childName}</strong>'s Aivorah account. Click the button below to set a new password.`
    : `We received a request to reset the password for your Aivorah account (<strong>${to}</strong>). Click the button below to set a new password.`;
  try {
    await sendEmail({
      to,
      subject,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">Password Reset</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hello,</p>
          <p style="font-size:14px;color:#555;line-height:1.6">${bodyText}</p>

          <div style="text-align:center;margin:32px 0">
            <a href="${resetLink}" style="background:#7C3AED;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block">
              Reset Password
            </a>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            This link will expire in 1 hour. If you didn't request this, you can safely ignore this email.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            Aivorah · Hyderabad, India
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendPasswordResetEmail failed:', err.message);
  }
}

// Set-password invite for a teacher-created student with a real email — same
// wording as platform-admin's Add user invite. Throws so the caller can report it.
async function sendStudentInviteEmail({ to, name, link }) {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  await sendEmail({
    to,
    subject: "You've been invited to Aivorah as a Student",
    html: `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0B0B0B">
  <h2 style="margin:0 0 12px">Welcome to Aivorah</h2>
  <p>Hi ${esc(name)},</p>
  <p>Your teacher has created a <strong>Student</strong> account for you. To get started, set your password using the button below.</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#9A7B2E;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Set your password</a></p>
  <p>You'll also need to verify your email address before you can use Aivorah — we've sent a separate verification email for this.</p>
</div>`,
  });
}

module.exports = { sendCredentialsEmail, sendBulkCredentialsEmail, sendOwnAccountCredentialsEmail, sendEmailOtpCode, sendPasswordResetEmail, sendStudentInviteEmail };
