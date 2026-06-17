import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import * as crypto from 'crypto';

interface OtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const otpStore = new Map<string, OtpRecord>();

// TTL 정리 (1분마다)
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of otpStore.entries()) {
    if (rec.expiresAt < now) otpStore.delete(key);
  }
}, 60_000).unref();

@Controller('auth')
export class AuthController {
  @Post('phone/send')
  @HttpCode(HttpStatus.OK)
  async sendPhoneOtp(@Body() body: Record<string, unknown>) {
    const phone = String(body['phone'] ?? '').replace(/[^0-9]/g, '');
    if (!/^01[0-9]{8,9}$/.test(phone)) {
      return { ok: false, message: '올바른 전화번호 형식이 아닙니다.' };
    }

    const existing = otpStore.get(phone);
    const now = Date.now();

    // 1분 재발송 쿨다운
    if (existing && now - existing.lastSentAt < 60_000) {
      const remain = Math.ceil((60_000 - (now - existing.lastSentAt)) / 1000);
      return { ok: false, message: `${remain}초 후에 다시 시도하세요.` };
    }

    // 5회 초과 시도 차단 (3분 만료 전)
    if (existing && existing.expiresAt > now && existing.attempts >= 5) {
      return { ok: false, message: '인증 시도 횟수를 초과했습니다. 3분 후 다시 시도하세요.' };
    }

    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    otpStore.set(phone, {
      code,
      expiresAt: now + 3 * 60_000,
      attempts: 0,
      lastSentAt: now,
    });

    await this.sendSms(phone, `[인증번호] ${code}\n3분 이내에 입력해 주세요.`);
    return { ok: true, message: '인증번호가 발송되었습니다.' };
  }

  @Post('phone/verify')
  @HttpCode(HttpStatus.OK)
  verifyPhoneOtp(@Body() body: Record<string, unknown>) {
    const phone = String(body['phone'] ?? '').replace(/[^0-9]/g, '');
    const code  = String(body['code']  ?? '').trim();

    if (!phone || !code) {
      return { ok: false, message: '전화번호와 인증번호를 입력해 주세요.' };
    }

    const rec = otpStore.get(phone);
    if (!rec) return { ok: false, message: '인증번호를 먼저 발송해 주세요.' };
    if (Date.now() > rec.expiresAt) {
      otpStore.delete(phone);
      return { ok: false, message: '인증번호가 만료되었습니다. 다시 발송해 주세요.' };
    }
    if (rec.attempts >= 5) {
      return { ok: false, message: '인증 시도 횟수를 초과했습니다.' };
    }

    rec.attempts++;
    if (rec.code !== code) {
      return { ok: false, message: `인증번호가 일치하지 않습니다. (${5 - rec.attempts}회 남음)` };
    }

    otpStore.delete(phone);
    return { ok: true, message: '인증이 완료되었습니다.' };
  }

  // ─────────────────────────────────────────────
  // PRIVATE — Solapi SMS 발송
  // ─────────────────────────────────────────────

  private async sendSms(to: string, text: string): Promise<void> {
    const apiKey    = process.env.SOLAPI_API_KEY;
    const apiSecret = process.env.SOLAPI_API_SECRET;
    const sender    = process.env.SOLAPI_SENDER;

    if (!apiKey || !apiSecret || !sender) {
      console.log(`[OTP 개발모드] ${to} → ${text}`);
      return;
    }

    const date = new Date().toISOString();
    const salt = crypto.randomBytes(8).toString('hex');
    const hmac = crypto.createHmac('sha256', apiSecret);
    hmac.update(date + salt);
    const signature = hmac.digest('hex');

    const authHeader = `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;

    try {
      const res = await fetch('https://api.solapi.com/messages/v4/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          message: { to, from: sender, text },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[OTP SMS 실패] ${res.status} ${err}`);
      }
    } catch (err) {
      console.error('[OTP SMS 오류]', err);
    }
  }
}
