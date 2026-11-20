/** Map raw Auth (Firebase / Django) errors to messages that are safe and useful to show. */
export function friendlyAuthError(err: { message?: string; status?: number; code?: string } | null | undefined): string {
  if (!err) return "Something went wrong. Please try again.";
  const msg = (err.message || "").toLowerCase();
  const code = (err.code || "").toLowerCase();

  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found" ||
    msg.includes("invalid-credential") ||
    msg.includes("wrong password") ||
    msg.includes("user not found")
  ) {
    return "Invalid email or password. Please verify your credentials.";
  }

  if (code === "auth/email-already-in-use" || msg.includes("email-already-in-use")) {
    return "An account with this email already exists. Please sign in instead.";
  }

  if (code === "auth/weak-password" || msg.includes("weak-password")) {
    return "Password is too weak. Please use at least 6 characters.";
  }

  if (code === "auth/invalid-email" || msg.includes("invalid-email")) {
    return "Please enter a valid email address.";
  }

  if (code === "auth/popup-closed-by-user") {
    return "Sign-in was cancelled.";
  }

  if (
    code === "auth/too-many-requests" ||
    code === "over_email_send_rate_limit" ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    err.status === 429
  ) {
    return "Too many attempts. Please wait a minute and try again.";
  }

  if (code === "auth/unauthorized-domain") {
    return "This domain is not authorized in Firebase Console (Authentication -> Settings -> Authorized domains).";
  }

  if (msg.includes("failed to fetch") || msg.includes("network")) {
    return "Could not reach the authentication service. Check your connection and try again.";
  }

  return err.message || "We couldn't sign you in. Please try again.";
}
