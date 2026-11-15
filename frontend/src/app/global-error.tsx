"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Reports unhandled React render errors to Sentry (no-op without a DSN) and shows a safe fallback.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div role="alert" style={{ padding: 32, fontFamily: "sans-serif" }}>
          <h2>Something went wrong</h2>
          <p>The error has been reported. Please refresh the page.</p>
        </div>
      </body>
    </html>
  );
}
