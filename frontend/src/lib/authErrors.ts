/** Map raw Supabase Auth errors to messages that are safe and useful to show. */
export function friendlyAuthError(err: { message?: string; status?: number; code?: string } | null | undefined): string {
  if (!err) return "Something went wrong. Please try again.";
  const msg = (err.message || "").toLowerCase();
  const code = (err.code || "").toLowerCase();

  if (code === "over_email_send_rate_limit" || msg.includes("rate limit") || msg.includes("for security purposes") || err.status === 429) {
    return "Too many attempts. Please wait a minute before requesting another code.";
  }
  if (code === "otp_expired" || msg.includes("expired")) {
    return "That code has expired. Request a new one and try again.";
  }
  if (msg.includes("invalid") || msg.includes("token")) {
    return "That code is incorrect or has already been used. Check the latest email, or request a new code.";
  }
  if (msg.includes("signups not allowed")) {
    return "Sign-ups are currently disabled for this workspace.";
  }
  if (msg.includes("failed to fetch") || msg.includes("network")) {
    return "Could not reach the sign-in service. Check your connection and try again.";
  }
  return "We couldn't sign you in. Please try again.";
}
