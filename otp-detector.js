// otp-detector.js — Extract OTP codes from incoming WhatsApp messages
'use strict';

/**
 * Ordered list of regex patterns (most specific first).
 * Each pattern tries to extract a 4–8 digit code.
 */
const OTP_PATTERNS = [
  // "Your OTP is 123456"
  /(?:otp|one[-\s]?time\s(?:password|code)|verification\s(?:code|pin)|auth(?:entication)?\scode)[^\d]*(\d{4,8})/i,

  // "Code: 123456" or "PIN: 1234"
  /(?:code|pin|passcode|password)[^\d]*(\d{4,8})/i,

  // "Use 123456 to verify"
  /(?:use|enter|input|provide)[^\d]*(\d{4,8})\s*(?:to|for)/i,

  // "123456 is your OTP / verification code"
  /(\d{4,8})\s+(?:is\s+(?:your|the)\s+)?(?:otp|code|pin|password|passcode)/i,

  // Standalone 4–8 digit number (fallback)
  /\b(\d{4,8})\b/,
];

/**
 * Attempt to extract an OTP code from a message string.
 * Returns the first match, or null if nothing is found.
 *
 * @param {string} message
 * @returns {string|null}
 */
function detectOTP(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.trim();

  for (const pattern of OTP_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Determine whether a message is likely an OTP message.
 * Used as a quick pre-filter before running detectOTP.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isOTPMessage(message) {
  if (!message || typeof message !== 'string') return false;

  const lower = message.toLowerCase();

  const OTP_KEYWORDS = [
    'otp', 'one-time', 'one time', 'verification code', 'verify',
    'auth code', 'authentication', 'passcode', 'pin', 'your code',
    'login code', 'security code', 'access code', 'activation code',
  ];

  const hasKeyword = OTP_KEYWORDS.some(k => lower.includes(k));
  if (hasKeyword) return true;

  // Fallback: contains a 4–8 digit number
  return /\b\d{4,8}\b/.test(message);
}

module.exports = { detectOTP, isOTPMessage };
